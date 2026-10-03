import SwiftUI

struct PlansView: View {
    @EnvironmentObject private var planStore: PlanStore

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    planSection(
                        title: "Training Plans",
                        emptyText: "No saved training plans yet."
                    ) {
                        ForEach(planStore.trainingPlans) { plan in
                            NavigationLink {
                                TrainingPlanDetailView(plan: plan)
                            } label: {
                                PlanCard(
                                    title: plan.id,
                                    systemImage: "figure.run",
                                    tint: .orange,
                                    language: plan.language,
                                    durationDays: plan.duration_days,
                                    entryCount: plan.days.count,
                                    entryLabel: "sessions"
                                )
                            }
                            .buttonStyle(.plain)
                        }
                    }

                    planSection(
                        title: "Food Plans",
                        emptyText: "No saved food plans yet."
                    ) {
                        ForEach(planStore.foodPlans) { plan in
                            NavigationLink {
                                FoodPlanDetailView(plan: plan)
                            } label: {
                                PlanCard(
                                    title: plan.id,
                                    systemImage: "fork.knife",
                                    tint: .green,
                                    language: plan.language,
                                    durationDays: plan.duration_days,
                                    entryCount: plan.days.count,
                                    entryLabel: "days"
                                )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .padding()
            }
            .navigationTitle("Plans")
        }
    }

    @ViewBuilder
    private func planSection<Content: View>(title: String, emptyText: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .font(.title3.weight(.semibold))

            content()

            if title == "Training Plans", planStore.trainingPlans.isEmpty {
                EmptyPlanState(text: emptyText)
            }

            if title == "Food Plans", planStore.foodPlans.isEmpty {
                EmptyPlanState(text: emptyText)
            }
        }
    }
}

private struct PlanCard: View {
    let title: String
    let systemImage: String
    let tint: Color
    let language: String
    let durationDays: Int
    let entryCount: Int
    let entryLabel: String

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: systemImage)
                .font(.title3)
                .foregroundStyle(tint)
                .frame(width: 28, height: 28)

            VStack(alignment: .leading, spacing: 10) {
                Text(title)
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(.primary)
                    .multilineTextAlignment(.leading)

                HStack(spacing: 8) {
                    PlanBadge(text: language.uppercased(), tint: tint.opacity(0.18), foreground: tint)
                    PlanBadge(text: "\(durationDays)d", tint: Color.secondary.opacity(0.12), foreground: .primary)
                    PlanBadge(text: "\(entryCount) \(entryLabel)", tint: Color.secondary.opacity(0.12), foreground: .primary)
                }
            }

            Spacer(minLength: 0)

            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Color(.secondarySystemBackground))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(Color.black.opacity(0.04), lineWidth: 1)
        )
    }
}

private struct PlanBadge: View {
    let text: String
    let tint: Color
    let foreground: Color

    var body: some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .foregroundStyle(foreground)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(
                Capsule(style: .continuous)
                    .fill(tint)
            )
    }
}

private struct EmptyPlanState: View {
    let text: String

    var body: some View {
        Text(text)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(Color(.secondarySystemBackground))
            )
    }
}

private struct TrainingPlanDetailView: View {
    let plan: TrainingPlan

    var body: some View {
        List(plan.days) { day in
            Section(day.day) {
                detailRow("Title", day.title)
                detailRow("Duration", "\(day.duration_minutes) min")
                detailRow("Frequency", day.frequency)
                detailRow("Training", day.training)
                detailRow("Focus", day.focus)
                detailRow("Notes", day.notes)
            }
        }
        .navigationTitle("Training Plan")
    }
}

private struct FoodPlanDetailView: View {
    let plan: FoodPlan

    var body: some View {
        List(plan.days) { day in
            Section(day.day) {
                detailRow("Breakfast", day.breakfast)
                detailRow("Lunch", day.lunch)
                detailRow("Dinner", day.dinner)
            }
        }
        .navigationTitle("Food Plan")
    }
}

@ViewBuilder
private func detailRow(_ label: String, _ value: String) -> some View {
    VStack(alignment: .leading, spacing: 4) {
        Text(label)
            .font(.caption)
            .foregroundStyle(.secondary)
        Text(value)
    }
}