import SwiftUI

struct ChatView: View {
    @EnvironmentObject var vm: ChatViewModel

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 12) {
                            ForEach(vm.messages) { msg in
                                MessageBubble(message: msg) {
                                    vm.selectedReference = $0
                                }
                            }
                        }
                        .padding()
                    }
                    .onChange(of: vm.messages.count) { _, _ in
                        if let lastId = vm.messages.last?.id {
                            withAnimation {
                                proxy.scrollTo(lastId, anchor: .bottom)
                            }
                        }
                    }
                }

                if vm.isLoading {
                    ProgressView("Thinking...")
                        .padding(.bottom, 8)
                }

                HStack(spacing: 8) {
                    TextField("Ask about training, nutrition, recovery...", text: $vm.input, axis: .vertical)
                        .lineLimit(1...4)
                        .textFieldStyle(.roundedBorder)

                    Button("Send") {
                        vm.send()
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(vm.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                .padding()
                .background(.thinMaterial)
            }
            .navigationTitle("FitCoach")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    LogoBadge()
                }
            }
            .sheet(item: $vm.selectedReference) { _ in
                DocumentViewer(
                    title: vm.selectedReference?.title ?? "Reference",
                    markdown: vm.markdownForSelectedReference()
                )
            }
        }
    }
}

private struct MessageBubble: View {
    let message: ChatMessage
    let onOpenRef: (ChatReference) -> Void

    var body: some View {
        VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 8) {
            HStack {
                if message.role == .user { Spacer() }
                Text(message.content)
                    .padding(12)
                    .background(message.role == .user ? Color.accentColor : Color.gray.opacity(0.15))
                    .foregroundStyle(message.role == .user ? .white : .primary)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                if message.role != .user { Spacer() }
            }

            if !message.references.isEmpty && message.role == .assistant {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(message.references, id: \.self) { ref in
                            Button(ref.fileName) {
                                onOpenRef(ref)
                            }
                            .buttonStyle(.bordered)
                            .font(.caption)
                        }
                    }
                }
            }
        }
        .id(message.id)
    }
}

private struct LogoBadge: View {
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "bolt.heart.fill")
                .foregroundStyle(.orange)
            Text("HEICO")
                .font(.headline)
        }
    }
}
