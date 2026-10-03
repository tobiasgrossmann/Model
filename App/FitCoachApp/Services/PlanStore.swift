import Foundation

@MainActor
final class PlanStore: ObservableObject {
    @Published private(set) var foodPlans: [FoodPlan] = []
    @Published private(set) var trainingPlans: [TrainingPlan] = []

    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init() {
        load()
    }

    func saveFoodPlan(_ plan: FoodPlan) {
        upsert(plan, in: &foodPlans)
        persistFoodPlans()
    }

    func saveTrainingPlan(_ plan: TrainingPlan) {
        upsert(plan, in: &trainingPlans)
        persistTrainingPlans()
    }

    private func upsert<T: Identifiable & Hashable>(_ plan: T, in plans: inout [T]) where T.ID == String {
        if let index = plans.firstIndex(where: { $0.id == plan.id }) {
            plans[index] = plan
        } else {
            plans.insert(plan, at: 0)
        }
    }

    private func load() {
        foodPlans = loadArray(from: foodPlansURL)
        trainingPlans = loadArray(from: trainingPlansURL)
    }

    private func persistFoodPlans() {
        persist(foodPlans, to: foodPlansURL)
    }

    private func persistTrainingPlans() {
        persist(trainingPlans, to: trainingPlansURL)
    }

    private func loadArray<T: Decodable>(from url: URL) -> [T] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        return (try? decoder.decode([T].self, from: data)) ?? []
    }

    private func persist<T: Encodable>(_ value: T, to url: URL) {
        do {
            let data = try encoder.encode(value)
            try FileManager.default.createDirectory(at: storageDirectory, withIntermediateDirectories: true)
            try data.write(to: url, options: .atomic)
        } catch {
            // Keep the app usable even if persistence fails.
        }
    }

    private var storageDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("FitCoachApp", isDirectory: true)
    }

    private var foodPlansURL: URL {
        storageDirectory.appendingPathComponent("food-plans.json")
    }

    private var trainingPlansURL: URL {
        storageDirectory.appendingPathComponent("training-plans.json")
    }
}