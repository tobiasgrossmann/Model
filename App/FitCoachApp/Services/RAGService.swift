import Foundation

final class RAGService {
    static let shared = RAGService()

    private var docs: [String: String] = [:]

    private init() {
        loadDocs()
    }

    func search(query: String, limit: Int = 3) -> [DocumentHit] {
        let terms = tokenize(query)
        guard !terms.isEmpty else { return [] }

        var hits: [DocumentHit] = []
        for (name, body) in docs {
            let lower = body.lowercased()
            var score = 0
            for term in terms {
                if lower.contains(term) {
                    score += 1
                }
            }
            if score > 0 {
                let title = body.split(separator: "\n").first.map(String.init) ?? name
                let excerpt = body.prefix(500)
                    .replacingOccurrences(of: "\n", with: " ")
                hits.append(DocumentHit(fileName: name, title: title.replacingOccurrences(of: "#", with: "").trimmingCharacters(in: .whitespaces), excerpt: String(excerpt), score: score))
            }
        }

        return hits.sorted { a, b in
            if a.score == b.score {
                return a.fileName < b.fileName
            }
            return a.score > b.score
        }
        .prefix(limit)
        .map { $0 }
    }

    func markdown(for fileName: String) -> String? {
        docs[fileName]
    }

    private func tokenize(_ text: String) -> [String] {
        text.lowercased()
            .split { !$0.isLetter && !$0.isNumber }
            .map(String.init)
            .filter { $0.count >= 3 }
    }

    private func loadDocs() {
        if let urls = Bundle.main.urls(forResourcesWithExtension: "md", subdirectory: "RAG") {
            for url in urls {
                if let text = try? String(contentsOf: url, encoding: .utf8) {
                    docs[url.lastPathComponent] = text
                }
            }
        }

        // Fallback for development when resources are missing from bundle.
        if docs.isEmpty {
            let fm = FileManager.default
            if let cwd = fm.currentDirectoryPath as String? {
                let localPath = URL(fileURLWithPath: cwd).appendingPathComponent("rag")
                if let files = try? fm.contentsOfDirectory(at: localPath, includingPropertiesForKeys: nil) {
                    for file in files where file.pathExtension == "md" {
                        if let text = try? String(contentsOf: file, encoding: .utf8) {
                            docs[file.lastPathComponent] = text
                        }
                    }
                }
            }
        }
    }
}
