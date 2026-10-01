import SwiftUI

struct AboutView: View {
    @State private var snapshot: UserHealthData?

    var body: some View {
        NavigationStack {
            List {
                Section("Company") {
                    HStack(spacing: 12) {
                        Image(systemName: "bolt.heart.fill")
                            .font(.largeTitle)
                            .foregroundStyle(.orange)
                        VStack(alignment: .leading, spacing: 4) {
                            Text("HEICO Fitness AI")
                                .font(.headline)
                            Text("Local-first personal AI fitness coach for iPhone.")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                Section("About Us") {
                    Text("We build privacy-focused coaching experiences that combine local model inference, retrieval-augmented guidance, and Apple Health data. The assistant supports evidence-aware training, nutrition, recovery, and stress coaching.")
                }

                Section("Model") {
                    Text("Runtime: OpenAI-compatible local endpoint")
                    Text("Default endpoint: http://127.0.0.1:8080/v1/chat/completions")
                    Text("Tool available: get_user_health_data()")
                }

                Section("Health Data Snapshot") {
                    if let snapshot {
                        Text("Age: \(snapshot.age)")
                        Text("Weight: \(String(format: "%.1f", snapshot.weight_kg)) kg")
                        Text("Height: \(String(format: "%.1f", snapshot.height_cm)) cm")
                        Text("Sleep: \(String(format: "%.1f", snapshot.sleep_duration_hours)) h")
                        Text("HRV: \(snapshot.hrv_ms) ms")
                        Text("Resting HR: \(snapshot.resting_heart_rate_bpm) bpm")
                    } else {
                        Text("Tap refresh to load HealthKit metrics.")
                            .foregroundStyle(.secondary)
                    }

                    Button("Refresh Health Data") {
                        Task {
                            snapshot = await HealthDataService.shared.get_user_health_data()
                        }
                    }
                }
            }
            .navigationTitle("About")
        }
    }
}
