import SwiftUI

@main
struct FitCoachAppApp: App {
    @StateObject private var planStore: PlanStore
    @StateObject private var viewModel: ChatViewModel

    init() {
        let store = PlanStore()
        _planStore = StateObject(wrappedValue: store)
        _viewModel = StateObject(wrappedValue: ChatViewModel(planStore: store))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(viewModel)
                .environmentObject(planStore)
        }
    }
}

struct RootView: View {
    var body: some View {
        TabView {
            ChatView()
                .tabItem {
                    Label("Chat", systemImage: "message")
                }

            PlansView()
                .tabItem {
                    Label("Plans", systemImage: "list.bullet.rectangle")
                }

            AboutView()
                .tabItem {
                    Label("About", systemImage: "info.circle")
                }
        }
    }
}
