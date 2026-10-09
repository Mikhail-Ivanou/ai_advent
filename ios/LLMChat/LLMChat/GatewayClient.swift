import Foundation
import UIKit

/// Connection settings, stored in UserDefaults (and editable on the settings screen).
enum Settings {
    static let serverURLKey = "serverURL"
    static let apiKeyKey = "apiKey"
    static let clientNameKey = "clientName"
    static let modelKey = "model"

    static let defaultServerURL = "http://localhost:8088"

    /// The simulator's name ("iPhone 17 Pro"), so two simulators are told apart in the gateway's log.
    static var defaultClientName: String {
        ProcessInfo.processInfo.environment["SIMULATOR_DEVICE_NAME"] ?? UIDevice.current.name
    }

    static var serverURL: String { UserDefaults.standard.string(forKey: serverURLKey) ?? defaultServerURL }
    static var apiKey: String { UserDefaults.standard.string(forKey: apiKeyKey) ?? "" }
    static var clientName: String {
        let name = UserDefaults.standard.string(forKey: clientNameKey) ?? ""
        return name.isEmpty ? defaultClientName : name
    }
    /// Empty = the gateway's default model.
    static var model: String { UserDefaults.standard.string(forKey: modelKey) ?? "" }
}

struct ChatTurn: Encodable {
    let role: String
    let content: String
}

struct Usage: Decodable {
    let prompt_tokens: Int
    let completion_tokens: Int
}

struct Completion {
    var model: String?
    var finishReason: String?
    var usage: Usage?
}

struct ServerHealth: Decodable {
    struct Limits: Decodable {
        let maxContextTokens: Int
        let maxOutputTokens: Int
        let rateLimitPerMinute: Int
    }
    let status: String
    let defaultModel: String
    let limits: Limits
}

enum GatewayError: LocalizedError {
    case invalidURL(String)
    /// An error answer from the gateway (OpenAI shape: `{"error": {"code", "message", ...}}`).
    case api(status: Int, code: String, message: String, retryAfter: Int?, details: [String: Int])
    case badResponse(String)

    var errorDescription: String? {
        switch self {
        case .invalidURL(let url):
            return "Некорректный адрес сервера: \(url)"
        case .badResponse(let text):
            return "Непонятный ответ сервера: \(text)"
        case let .api(status, code, message, retryAfter, details):
            let retry = retryAfter.map { " Повторите через \($0) с." } ?? ""
            switch code {
            case "invalid_api_key":
                return "Неверный API-ключ — проверьте настройки."
            case "rate_limit_exceeded":
                return "Слишком часто: превышен лимит запросов в минуту.\(retry)"
            case "server_busy":
                return "Сервер занят — очередь заполнена.\(retry)"
            case "context_length_exceeded":
                if let used = details["prompt_tokens"], let max = details["max_context_tokens"] {
                    return "Диалог не помещается в контекст: \(used) токенов при лимите \(max). Начните новый чат."
                }
                return "Диалог не помещается в контекст модели. Начните новый чат."
            case "model_not_found":
                return "Модель недоступна: \(message)"
            default:
                return "Ошибка \(status): \(message)"
            }
        }
    }
}

/// Talks to llm-gateway's OpenAI-compatible API.
struct GatewayClient {
    let baseURL: URL
    let apiKey: String
    let clientName: String

    init(serverURL: String = Settings.serverURL, apiKey: String = Settings.apiKey, clientName: String = Settings.clientName) throws {
        let trimmed = serverURL.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: trimmed), url.scheme == "http" || url.scheme == "https", url.host != nil else {
            throw GatewayError.invalidURL(serverURL)
        }
        self.baseURL = url
        self.apiKey = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        self.clientName = clientName
    }

    private func request(_ path: String, method: String = "GET", body: Data? = nil) -> URLRequest {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = method
        request.timeoutInterval = 300
        if !apiKey.isEmpty { request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization") }
        // Header values must be ASCII; the gateway decodes this back.
        let encodedName = clientName.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? clientName
        request.setValue(encodedName, forHTTPHeaderField: "X-Client-Name")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    func health() async throws -> ServerHealth {
        let (data, response) = try await URLSession.shared.data(for: request("health"))
        try Self.check(response, data)
        return try JSONDecoder().decode(ServerHealth.self, from: data)
    }

    func models() async throws -> [String] {
        struct List: Decodable { struct Model: Decodable { let id: String }; let data: [Model] }
        let (data, response) = try await URLSession.shared.data(for: request("v1/models"))
        try Self.check(response, data)
        return try JSONDecoder().decode(List.self, from: data).data.map(\.id)
    }

    /// Streams one answer; `onDelta` gets text as it's generated. Cancelling the task closes the connection,
    /// which makes the gateway stop generating.
    func streamChat(messages: [ChatTurn], model: String, onDelta: @MainActor (String) -> Void) async throws -> Completion {
        struct Body: Encodable {
            struct StreamOptions: Encodable { let include_usage: Bool }
            let model: String?
            let messages: [ChatTurn]
            let stream: Bool
            let stream_options: StreamOptions
            let temperature: Double
        }
        let body = try JSONEncoder().encode(Body(
            model: model.isEmpty ? nil : model,
            messages: messages,
            stream: true,
            stream_options: .init(include_usage: true),
            temperature: 0.3
        ))
        let (bytes, response) = try await URLSession.shared.bytes(for: request("v1/chat/completions", method: "POST", body: body))
        if let http = response as? HTTPURLResponse, http.statusCode != 200 {
            var data = Data()
            for try await byte in bytes { data.append(byte) }
            try Self.check(response, data)
        }

        struct Chunk: Decodable {
            struct Choice: Decodable {
                struct Delta: Decodable { let content: String? }
                let delta: Delta
                let finish_reason: String?
            }
            let model: String?
            let choices: [Choice]?
            let usage: Usage?
        }
        var completion = Completion()
        for try await line in bytes.lines {
            guard line.hasPrefix("data: ") else { continue }
            let payload = Data(line.dropFirst(6).utf8)
            if line == "data: [DONE]" { break }
            // An error after the stream started comes in-band.
            if let error = Self.apiError(status: 200, data: payload, retryAfter: nil) { throw error }
            let chunk = try JSONDecoder().decode(Chunk.self, from: payload)
            completion.model = chunk.model ?? completion.model
            if let usage = chunk.usage { completion.usage = usage }
            for choice in chunk.choices ?? [] {
                if let text = choice.delta.content, !text.isEmpty { await onDelta(text) }
                if let reason = choice.finish_reason { completion.finishReason = reason }
            }
        }
        return completion
    }

    private static func check(_ response: URLResponse, _ data: Data) throws {
        guard let http = response as? HTTPURLResponse else { throw GatewayError.badResponse("не HTTP") }
        guard http.statusCode != 200 else { return }
        let retryAfter = (http.value(forHTTPHeaderField: "Retry-After")).flatMap(Int.init)
        throw apiError(status: http.statusCode, data: data, retryAfter: retryAfter)
            ?? GatewayError.badResponse("HTTP \(http.statusCode) \(String(decoding: data.prefix(200), as: UTF8.self))")
    }

    private static func apiError(status: Int, data: Data, retryAfter: Int?) -> GatewayError? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let error = object["error"] as? [String: Any] else { return nil }
        let details = error.compactMapValues { $0 as? Int }
        return .api(
            status: status,
            code: error["code"] as? String ?? "error",
            message: error["message"] as? String ?? "неизвестная ошибка",
            retryAfter: retryAfter,
            details: details
        )
    }
}
