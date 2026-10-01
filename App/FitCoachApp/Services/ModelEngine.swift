import Foundation

protocol ModelEngine {
    func chat(messages: [ChatMessage], tools: [ToolSpec]) async throws -> LLMTurn
}

enum ModelEngineError: Error {
    case badResponse
}

final class LocalOpenAIModelEngine: ModelEngine {
    private let session: URLSession
    private let endpoint: URL
    private let modelName: String

    init(
        endpoint: URL = URL(string: "http://127.0.0.1:8080/v1/chat/completions")!,
        modelName: String = "trainer-local"
    ) {
        self.session = URLSession(configuration: .default)
        self.endpoint = endpoint
        self.modelName = modelName
    }

    func chat(messages: [ChatMessage], tools: [ToolSpec]) async throws -> LLMTurn {
        var req = URLRequest(url: endpoint)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let payload = ChatCompletionRequest(
            model: modelName,
            messages: messages.map { APIMsg(role: $0.role.rawValue, content: $0.content) },
            tools: tools,
            temperature: 0.3
        )
        req.httpBody = try JSONEncoder().encode(payload)

        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw ModelEngineError.badResponse
        }

        let decoded = try JSONDecoder().decode(ChatCompletionResponse.self, from: data)
        guard let msg = decoded.choices.first?.message else {
            throw ModelEngineError.badResponse
        }

        if let toolCalls = msg.tool_calls, !toolCalls.isEmpty {
            return .toolRequest(calls: toolCalls, assistantText: msg.content)
        }

        return .assistant(text: msg.content ?? "")
    }
}

final class FallbackRuleModelEngine: ModelEngine {
    func chat(messages: [ChatMessage], tools: [ToolSpec]) async throws -> LLMTurn {
        guard let latest = messages.last(where: { $0.role == .user }) else {
            return .assistant(text: "How can I help with your fitness plan today?")
        }

        let lower = latest.content.lowercased()
        let shouldCallTool = lower.contains("bmi") || lower.contains("sleep") || lower.contains("hrv") || lower.contains("heart") || lower.contains("calories")

        if shouldCallTool {
            return .toolRequest(calls: [
                LLMToolCall(
                    id: UUID().uuidString,
                    type: "function",
                    function: LLMToolFunctionCall(name: "get_user_health_data", arguments: "{}")
                )
            ], assistantText: nil)
        }

        return .assistant(text: "Consistent movement, balanced meals, and enough recovery are your foundation. If you want, I can give you a 7-day beginner plan.")
    }
}

private struct ChatCompletionRequest: Codable {
    let model: String
    let messages: [APIMsg]
    let tools: [ToolSpec]
    let temperature: Double
}

private struct APIMsg: Codable {
    let role: String
    let content: String?

    init(role: String, content: String?) {
        self.role = role
        self.content = content
    }
}

private struct ChatCompletionResponse: Codable {
    let choices: [Choice]

    struct Choice: Codable {
        let message: Message
    }

    struct Message: Codable {
        let content: String?
        let tool_calls: [LLMToolCall]?
    }
}
