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
    private let planStore: PlanStore

    private var toolWasCalled = false

    init(planStore: PlanStore) {
        self.planStore = planStore
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
        toolWasCalled = false

        let hits = rag.search(query: query, limit: 3)
        let refs = hits.map { ChatReference(fileName: $0.fileName, title: $0.title) }

        let context = hits.map { "[\($0.fileName)] \($0.excerpt)" }.joined(separator: "\n\n")
        let system = ChatMessage(
            role: .system,
            content: "You are a concise personal AI fitness trainer. Use the provided RAG snippets when relevant and cite source filenames in your answer. Call get_user_health_data only when real-time user metrics are required. When you create a structured meal or training plan that should be persisted, call save_food_plan or save_training_plan with the full plan payload. RAG snippets:\n\n\(context)"
        )

        var convo = [system] + messages
        let tools = makeToolSpecs()
        var toolNotices: [String] = []

        do {
            var turn = try await remoteEngine.chat(messages: convo, tools: tools)
            var remainingToolRounds = 4

            while case let .toolRequest(calls, assistantText) = turn, remainingToolRounds > 0 {
                if let assistantText, !assistantText.isEmpty {
                    convo.append(ChatMessage(role: .assistant, content: assistantText))
                }
                let handled = await handleToolCalls(calls, convo: &convo, notices: &toolNotices)
                guard handled else { break }
                remainingToolRounds -= 1
                turn = try await remoteEngine.chat(messages: convo, tools: tools)
            }

            switch turn {
            case .assistant(let text):
                messages.append(ChatMessage(role: .assistant, content: text, references: refs))
                appendToolNotices(toolNotices)
            case .toolRequest:
                messages.append(ChatMessage(role: .assistant, content: "I could not complete the tool flow. Please try again.", references: refs))
                appendToolNotices(toolNotices)
            }
        } catch {
            do {
                var turn = try await fallbackEngine.chat(messages: convo, tools: tools)
                if case let .toolRequest(calls, _) = turn {
                    var tmp = convo
                    let handled = await handleToolCalls(calls, convo: &tmp, notices: &toolNotices)
                    if handled {
                        if let toolMsg = tmp.last(where: { $0.role == .tool }) {
                            messages.append(ChatMessage(role: .assistant, content: "Using your local health data: \(toolMsg.content)", references: refs))
                            appendToolNotices(toolNotices)
                            return
                        }
                    }
                    turn = .assistant(text: "I could not reach the model endpoint. Start your local model server and try again.")
                }
                if case let .assistant(text) = turn {
                    messages.append(ChatMessage(role: .assistant, content: text, references: refs))
                    appendToolNotices(toolNotices)
                }
            } catch {
                messages.append(ChatMessage(role: .assistant, content: "Model unavailable. Verify local model runtime and endpoint configuration.", references: refs))
                appendToolNotices(toolNotices)
            }
        }
    }

    private func appendToolNotices(_ notices: [String]) {
        for notice in notices {
            messages.append(ChatMessage(role: .assistant, content: notice))
        }
    }

    private func makeToolSpecs() -> [ToolSpec] {
        [
            ToolSpec(
                type: "function",
                function: ToolFunction(
                    name: "get_user_health_data",
                    description: "Return latest user health metrics from Apple HealthKit.",
                    parameters: JSONSchema(type: "object", properties: [:], required: [])
                )
            ),
            ToolSpec(
                type: "function",
                function: ToolFunction(
                    name: "save_food_plan",
                    description: "Persist a food plan for the selected language.",
                    parameters: JSONSchema(
                        type: "object",
                        properties: [
                            "plan": JSONSchema(
                                type: "object",
                                properties: [
                                    "id": JSONSchema(type: "string"),
                                    "language": JSONSchema(type: "string"),
                                    "duration_days": JSONSchema(type: "integer"),
                                    "days": JSONSchema(
                                        type: "array",
                                        items: JSONSchema(
                                            type: "object",
                                            properties: [
                                                "day": JSONSchema(type: "string"),
                                                "breakfast": JSONSchema(type: "string"),
                                                "lunch": JSONSchema(type: "string"),
                                                "dinner": JSONSchema(type: "string")
                                            ],
                                            required: ["day", "breakfast", "lunch", "dinner"]
                                        )
                                    )
                                ],
                                required: ["id", "language", "duration_days", "days"]
                            )
                        ],
                        required: ["plan"]
                    )
                )
            ),
            ToolSpec(
                type: "function",
                function: ToolFunction(
                    name: "save_training_plan",
                    description: "Persist a training plan for the selected language.",
                    parameters: JSONSchema(
                        type: "object",
                        properties: [
                            "plan": JSONSchema(
                                type: "object",
                                properties: [
                                    "id": JSONSchema(type: "string"),
                                    "language": JSONSchema(type: "string"),
                                    "duration_days": JSONSchema(type: "integer"),
                                    "days": JSONSchema(
                                        type: "array",
                                        items: JSONSchema(
                                            type: "object",
                                            properties: [
                                                "day": JSONSchema(type: "string"),
                                                "title": JSONSchema(type: "string"),
                                                "duration_minutes": JSONSchema(type: "integer"),
                                                "frequency": JSONSchema(type: "string"),
                                                "training": JSONSchema(type: "string"),
                                                "focus": JSONSchema(type: "string"),
                                                "notes": JSONSchema(type: "string")
                                            ],
                                            required: ["day", "title", "duration_minutes", "frequency", "training", "focus", "notes"]
                                        )
                                    )
                                ],
                                required: ["id", "language", "duration_days", "days"]
                            )
                        ],
                        required: ["plan"]
                    )
                )
            )
        ]
    }

    private func handleToolCalls(_ calls: [LLMToolCall], convo: inout [ChatMessage], notices: inout [String]) async -> Bool {
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
                continue
            }

            if call.function.name == "save_food_plan",
               let raw = call.function.arguments.data(using: .utf8),
               let args = try? JSONDecoder().decode(FoodPlanToolArguments.self, from: raw) {
                planStore.saveFoodPlan(args.plan)
                let result = SavedToolResult(
                    status: "saved",
                    tool: "save_food_plan",
                    plan_id: args.plan.id,
                    duration_days: args.plan.duration_days,
                    language: args.plan.language
                )
                let payload = (try? String(data: JSONEncoder().encode(result), encoding: .utf8)) ?? "{\"status\":\"saved\"}"
                convo.append(ChatMessage(role: .tool, content: payload))
                notices.append("Saved food plan \"\(args.plan.id)\" (\(args.plan.duration_days) days, \(args.plan.language.uppercased())). You can view it in the Plans tab.")
                called = true
                continue
            }

            if call.function.name == "save_training_plan",
               let raw = call.function.arguments.data(using: .utf8),
               let args = try? JSONDecoder().decode(TrainingPlanToolArguments.self, from: raw) {
                planStore.saveTrainingPlan(args.plan)
                let result = SavedToolResult(
                    status: "saved",
                    tool: "save_training_plan",
                    plan_id: args.plan.id,
                    duration_days: args.plan.duration_days,
                    language: args.plan.language
                )
                let payload = (try? String(data: JSONEncoder().encode(result), encoding: .utf8)) ?? "{\"status\":\"saved\"}"
                convo.append(ChatMessage(role: .tool, content: payload))
                notices.append("Saved training plan \"\(args.plan.id)\" (\(args.plan.duration_days) days, \(args.plan.language.uppercased())). You can view it in the Plans tab.")
                called = true
            }
        }
        return called
    }
}
