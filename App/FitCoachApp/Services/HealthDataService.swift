import Foundation
import HealthKit

final class HealthDataService {
    static let shared = HealthDataService()

    private let store = HKHealthStore()

    private init() {}

    func requestAuthorizationIfNeeded() async {
        guard HKHealthStore.isHealthDataAvailable() else { return }

        let toRead: Set<HKObjectType> = [
            HKObjectType.characteristicType(forIdentifier: .biologicalSex)!,
            HKObjectType.quantityType(forIdentifier: .bodyMass)!,
            HKObjectType.quantityType(forIdentifier: .height)!,
            HKObjectType.quantityType(forIdentifier: .activeEnergyBurned)!,
            HKObjectType.quantityType(forIdentifier: .basalEnergyBurned)!,
            HKObjectType.quantityType(forIdentifier: .appleExerciseTime)!,
            HKObjectType.quantityType(forIdentifier: .appleStandTime)!,
            HKObjectType.categoryType(forIdentifier: .sleepAnalysis)!,
            HKObjectType.quantityType(forIdentifier: .heartRateVariabilitySDNN)!,
            HKObjectType.quantityType(forIdentifier: .restingHeartRate)!
        ]

        do {
            try await store.requestAuthorization(toShare: [], read: toRead)
        } catch {
            // Keep app usable even if authorization fails.
        }
    }

    // Tool function required by the model orchestration.
    func get_user_health_data() async -> UserHealthData {
        if !HKHealthStore.isHealthDataAvailable() {
            return UserHealthData(
                age: 30,
                weight_kg: 70,
                height_cm: 175,
                sex: "unknown",
                pregnancy_status: false,
                active_calories_burned: 0,
                basal_energy_burned: 0,
                exercise_minutes: 0,
                stand_hours: 0,
                sleep_duration_hours: 0,
                hrv_ms: 0,
                resting_heart_rate_bpm: 0
            )
        }

        async let age = fetchAge()
        async let sex = fetchSex()
        async let weight = fetchLatestQuantity(.bodyMass, unit: .gramUnit(with: .kilo), fallback: 70)
        async let height = fetchLatestQuantity(.height, unit: .meterUnit(with: .centi), fallback: 175)
        async let active = fetchTodaySum(.activeEnergyBurned, unit: .kilocalorie(), fallback: 0)
        async let basal = fetchTodaySum(.basalEnergyBurned, unit: .kilocalorie(), fallback: 0)
        async let exercise = fetchTodaySum(.appleExerciseTime, unit: .minute(), fallback: 0)
        async let standMinutes = fetchTodaySum(.appleStandTime, unit: .minute(), fallback: 0)
        async let sleepHours = fetchLastNightSleepHours()
        async let hrv = fetchLatestQuantity(.heartRateVariabilitySDNN, unit: HKUnit.secondUnit(with: .milli), fallback: 0)
        async let rhr = fetchLatestQuantity(.restingHeartRate, unit: HKUnit.count().unitDivided(by: .minute()), fallback: 0)

        return UserHealthData(
            age: Int(await age),
            weight_kg: await weight,
            height_cm: await height,
            sex: await sex,
            pregnancy_status: false,
            active_calories_burned: Int(await active),
            basal_energy_burned: Int(await basal),
            exercise_minutes: Int(await exercise),
            stand_hours: Int((await standMinutes) / 60.0),
            sleep_duration_hours: await sleepHours,
            hrv_ms: Int(await hrv),
            resting_heart_rate_bpm: Int(await rhr)
        )
    }

    private func fetchAge() async -> Double {
        do {
            let comps = try store.dateOfBirthComponents()
            guard let year = comps.year else { return 30 }
            let currentYear = Calendar.current.component(.year, from: Date())
            return Double(max(0, currentYear - year))
        } catch {
            return 30
        }
    }

    private func fetchSex() async -> String {
        do {
            let sex = try store.biologicalSex().biologicalSex
            switch sex {
            case .female: return "female"
            case .male: return "male"
            default: return "unknown"
            }
        } catch {
            return "unknown"
        }
    }

    private func fetchLatestQuantity(_ identifier: HKQuantityTypeIdentifier, unit: HKUnit, fallback: Double) async -> Double {
        guard let type = HKObjectType.quantityType(forIdentifier: identifier) else { return fallback }
        return await withCheckedContinuation { continuation in
            let sort = NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)
            let query = HKSampleQuery(sampleType: type, predicate: nil, limit: 1, sortDescriptors: [sort]) { _, samples, _ in
                guard
                    let sample = samples?.first as? HKQuantitySample
                else {
                    continuation.resume(returning: fallback)
                    return
                }
                continuation.resume(returning: sample.quantity.doubleValue(for: unit))
            }
            store.execute(query)
        }
    }

    private func fetchTodaySum(_ identifier: HKQuantityTypeIdentifier, unit: HKUnit, fallback: Double) async -> Double {
        guard let type = HKObjectType.quantityType(forIdentifier: identifier) else { return fallback }

        let cal = Calendar.current
        let start = cal.startOfDay(for: Date())
        let predicate = HKQuery.predicateForSamples(withStart: start, end: Date(), options: .strictStartDate)

        return await withCheckedContinuation { continuation in
            let query = HKStatisticsQuery(quantityType: type, quantitySamplePredicate: predicate, options: .cumulativeSum) { _, stats, _ in
                guard let sum = stats?.sumQuantity() else {
                    continuation.resume(returning: fallback)
                    return
                }
                continuation.resume(returning: sum.doubleValue(for: unit))
            }
            store.execute(query)
        }
    }

    private func fetchLastNightSleepHours() async -> Double {
        guard let type = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) else { return 0 }

        let cal = Calendar.current
        let now = Date()
        guard let start = cal.date(byAdding: .day, value: -1, to: now) else { return 0 }
        let predicate = HKQuery.predicateForSamples(withStart: start, end: now, options: .strictStartDate)

        return await withCheckedContinuation { continuation in
            let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)
            let query = HKSampleQuery(sampleType: type, predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: [sort]) { _, samples, _ in
                guard let samples = samples as? [HKCategorySample], !samples.isEmpty else {
                    continuation.resume(returning: 0)
                    return
                }
                var total: TimeInterval = 0
                for s in samples {
                    total += s.endDate.timeIntervalSince(s.startDate)
                }
                continuation.resume(returning: total / 3600.0)
            }
            store.execute(query)
        }
    }
}
