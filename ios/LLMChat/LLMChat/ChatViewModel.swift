import Foundation
import Observation

struct Message: Identifiable, Equatable {
    enum Role { case user, assistant, error }

    let id = UUID()
    let role: Role
    var text: String
    /// Footer under an answer: model, time, tokens.
    var meta: String?
    var isStreaming = false
    /// A question that got no answer is left out of the history sent next time.
    var failed = false
}

enum ServerStatus: Equatable {
    case unknown
    case online(model: String)
    case offline(String)
}

@MainActor
@Observable
final class ChatViewModel {
    private(set) var messages: [Message] = []
    private(set) var isSending = false
    private(set) var status: ServerStatus = .unknown
    private var task: Task<Void, Never>?

    private let systemPrompt = "Ты — полезный ассистент. Отвечай по-русски, кратко и по делу."

    func checkServer() async {
        do {
            let health = try await GatewayClient().health()
            let model = Settings.model.isEmpty ? health.defaultModel : Settings.model
            status = .online(model: model)
        } catch {
            status = .offline(error.localizedDescription)
        }
    }

    func send(_ text: String) {
        let question = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !question.isEmpty, !isSending else { return }

        let history = [ChatTurn(role: "system", content: systemPrompt)] + messages.compactMap { message -> ChatTurn? in
            guard !message.failed else { return nil }
            switch message.role {
            case .user: return ChatTurn(role: "user", content: message.text)
            case .assistant: return message.text.isEmpty ? nil : ChatTurn(role: "assistant", content: message.text)
            case .error: return nil
            }
        } + [ChatTurn(role: "user", content: question)]

        let user = Message(role: .user, text: question)
        let answer = Message(role: .assistant, text: "", isStreaming: true)
        messages.append(contentsOf: [user, answer])
        isSending = true

        task = Task {
            let started = Date()
            defer {
                isSending = false
                task = nil
            }
            do {
                let client = try GatewayClient()
                let completion = try await client.streamChat(messages: history, model: Settings.model) { [weak self] delta in
                    self?.update(answer.id) { $0.text += delta }
                }
                update(answer.id) {
                    $0.isStreaming = false
                    $0.meta = Self.meta(completion, seconds: Date().timeIntervalSince(started))
                }
                status = .online(model: completion.model ?? Settings.model)
            } catch {
                let cancelled = error is CancellationError || (error as? URLError)?.code == .cancelled
                let gotText = messages.first { $0.id == answer.id }.map { !$0.text.isEmpty } ?? false
                update(answer.id) { $0.isStreaming = false }
                if cancelled {
                    update(answer.id) { $0.meta = "остановлено · \(Self.seconds(Date().timeIntervalSince(started)))" }
                    if !gotText {
                        update(answer.id) { $0.failed = true }
                        update(user.id) { $0.failed = true }
                    }
                } else {
                    // Keep whatever arrived before the error, but don't send this exchange again.
                    if gotText { update(answer.id) { $0.failed = true } } else { messages.removeAll { $0.id == answer.id } }
                    update(user.id) { $0.failed = true }
                    // Not after a reset: the chat this error belongs to is gone.
                    if messages.contains(where: { $0.id == user.id }) {
                        messages.append(Message(role: .error, text: error.localizedDescription))
                    }
                    if error is URLError { status = .offline(error.localizedDescription) }
                }
            }
        }
    }

    /// Edits a message in place; a no-op if the chat was reset meanwhile.
    private func update(_ id: UUID, _ change: (inout Message) -> Void) {
        guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
        change(&messages[index])
    }

    func stop() {
        task?.cancel()
    }

    func reset() {
        stop()
        messages.removeAll()
    }

    private static func meta(_ completion: Completion, seconds: TimeInterval) -> String {
        var parts = [completion.model, Self.seconds(seconds)].compactMap { $0 }
        if let usage = completion.usage { parts.append("\(usage.completion_tokens) ток.") }
        if completion.finishReason == "length" { parts.append("обрезано по лимиту") }
        return parts.joined(separator: " · ")
    }

    private static func seconds(_ value: TimeInterval) -> String {
        String(format: "%.1f с", value)
    }
}
