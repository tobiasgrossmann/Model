import SwiftUI

struct DocumentViewer: View {
    let title: String
    let markdown: String

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if let attributed = try? AttributedString(markdown: markdown) {
                        Text(attributed)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        Text(markdown)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding()
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}
