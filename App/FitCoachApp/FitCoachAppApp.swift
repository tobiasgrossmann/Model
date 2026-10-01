import SwiftUI

@main
struct FitCoachAppApp: App {
    @StateObject private var viewModel = ChatViewModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(viewModel)
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

            AboutView()
                .tabItem {
                    Label("About", systemImage: "info.circle")
                }
        }
    }
}
