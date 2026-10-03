import Foundation

struct UserHealthData: Codable {
    let age: Int
    let weight_kg: Double
    let height_cm: Double
    let sex: String
    let pregnancy_status: Bool
    let active_calories_burned: Int
    let basal_energy_burned: Int
    let exercise_minutes: Int
    let stand_hours: Int
    let sleep_duration_hours: Double
    let hrv_ms: Int
    let resting_heart_rate_bpm: Int
}

struct ChatReference: Identifiable, Hashable {
    let id = UUID()
    let fileName: String
    let title: String
}

enum ChatRole: String, Codable {
    case system
    case user
    case assistant
    case tool
}

struct ChatMessage: Identifiable, Codable {
    let id: UUID
    let role: ChatRole
    let content: String
    let references: [ChatReference]

    init(id: UUID = UUID(), role: ChatRole, content: String, references: [ChatReference] = []) {
        self.id = id
        self.role = role
        self.content = content
        self.references = references
    }
}

struct ToolSpec: Codable {
    let type: String
    let function: ToolFunction
}

struct ToolFunction: Codable {
    let name: String
    let description: String
    let parameters: JSONSchema
}

struct JSONSchema: Codable {
    let type: String
    let properties: [String: JSONSchema]?
    let required: [String]?
    let items: JSONSchema?

    init(type: String, properties: [String: JSONSchema]? = nil, required: [String]? = nil, items: JSONSchema? = nil) {
        self.type = type
        self.properties = properties
        self.required = required
        self.items = items
    }
}

struct LLMToolCall: Codable {
    let id: String
    let type: String
    let function: LLMToolFunctionCall
}

struct LLMToolFunctionCall: Codable {
    let name: String
    let arguments: String
}

struct FoodPlan: Codable, Identifiable, Hashable {
    struct Day: Codable, Identifiable, Hashable {
        let day: String
        let breakfast: String
        let lunch: String
        let dinner: String

        var id: String { day }
    }

    let id: String
    let language: String
    let duration_days: Int
    let days: [Day]
}

struct TrainingPlan: Codable, Identifiable, Hashable {
    struct Day: Codable, Identifiable, Hashable {
        let day: String
        let title: String
        let duration_minutes: Int
        let frequency: String
        let training: String
        let focus: String
        let notes: String

        var id: String { day }
    }

    let id: String
    let language: String
    let duration_days: Int
    let days: [Day]
}

struct FoodPlanToolArguments: Codable {
    let plan: FoodPlan
}

struct TrainingPlanToolArguments: Codable {
    let plan: TrainingPlan
}

struct SavedToolResult: Codable {
    let status: String
    let tool: String
    let plan_id: String
    let duration_days: Int
    let language: String
}

enum LLMTurn {
    case assistant(text: String)
    case toolRequest(calls: [LLMToolCall], assistantText: String?)
}

struct DocumentHit {
    let fileName: String
    let title: String
    let excerpt: String
    let score: Int
}
