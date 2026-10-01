import Foundation

@MainActor
final class ChatViewModel: ObservableObject {
    @Published var messages: [ChatMessage] = [
        ChatMessage(role: .assistant, content: "I am your local fitness coach. Ask about training, recovery, or nutrition.")
    ]
    @Published var input: String = ""
    @Published var isLoading = false
    @Published var selectedReference: ChatReference?

    private let rag = RAGService.shared
    private let health = HealthDataService.shared
    private let remoteEngine = LocalOpenAIModelEngine()
    private let fallbackEngine = FallbackRuleModelEngine()

    private var toolWasCalled = false

    init() {
        Task {
            await health.requestAuthorizationIfNeeded()
        }
    }

    func send() {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        input = ""
        messages.append(ChatMessage(role: .user, content: text))

        Task {
            await runConversation(for: text)
        }
    }

    func markdownForSelectedReference() -> String {
        guard let selectedReference else { return "" }
        return rag.markdown(for: selectedReference.fileName) ?? "Document not found."
    }

    private func runConversation(for query: String) async {
        isLoading = true
        defer { isLoading = false }

        let hits = rag.search(query: query, limit: 3)
        let refs = hits.map { ChatReference(fileName: $0.fileName, title: $0.title) }

        let context = hits.map { "[\($0.fileName)] \($0.excerpt)" }.joined(separator: "\n\n")
        let system = ChatMessage(
            role: .system,
            content: "You are a concise personal AI fitness trainer. Use the provided RAG snippets when relevant and cite source filenames in your answer. Call get_user_health_data only when real-time user metrics are required. RAG snippets:\n\n\(context)"
        )

        var convo = [system] + messages
        let tools = [
            ToolSpec(
                type: "function",
                function: ToolFunction(
                    name: "get_user_health_data",
                    description: "Return latest user health metrics from Apple HealthKit.",
                    parameters: JSONSchema(type: "object", properties: [:])
                )
            )
        ]

        do {
            var turn = try await remoteEngine.chat(messages: convo, tools: tools)

            if case let .toolRequest(calls, assistantText) = turn {
                if let assistantText, !assistantText.isEmpty {
                    convo.append(ChatMessage(role: .assistant, content: assistantText))
                }
                let handled = await handleToolCalls(calls, convo: &convo)
                if handled {
                    turn = try await remoteEngine.chat(messages: convo, tools: tools)
                }
            }

            switch turn {
            case .assistant(let text):
                messages.append(ChatMessage(role: .assistant, content: text, references: refs))
            case .toolRequest:
                messages.append(ChatMessage(role: .assistant, content: "I could not complete the tool flow. Please try again.", references: refs))
            }
        } catch {
            do {
                var turn = try await fallbackEngine.chat(messages: convo, tools: tools)
                if case let .toolRequest(calls, _) = turn {
                    var tmp = convo
                    let handled = await handleToolCalls(calls, convo: &tmp)
                    if handled {
                        if let toolMsg = tmp.last(where: { $0.role == .tool }) {
                            messages.append(ChatMessage(role: .assistant, content: "Using your local health data: \(toolMsg.content)", references: refs))
                            return
                        }
                    }
                    turn = .assistant(text: "I could not reach the model endpoint. Start your local model server and try again.")
                }
                if case let .assistant(text) = turn {
                    messages.append(ChatMessage(role: .assistant, content: text, references: refs))
                }
            } catch {
                messages.append(ChatMessage(role: .assistant, content: "Model unavailable. Verify local model runtime and endpoint configuration.", references: refs))
            }
        }
    }

    private func handleToolCalls(_ calls: [LLMToolCall], convo: inout [ChatMessage]) async -> Bool {
        var called = false
        for call in calls {
            if call.function.name == "get_user_health_data" {
                if toolWasCalled {
                    continue
                }
                let data = await health.get_user_health_data()
                let payload = (try? String(data: JSONEncoder().encode(data), encoding: .utf8)) ?? "{}"
                convo.append(ChatMessage(role: .tool, content: payload))
                toolWasCalled = true
                called = true
            }
        }
        return called
    }
}
