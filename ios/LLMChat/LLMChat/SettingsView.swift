import SwiftUI

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @AppStorage(Settings.serverURLKey) private var serverURL = Settings.defaultServerURL
    @AppStorage(Settings.apiKeyKey) private var apiKey = ""
    @AppStorage(Settings.clientNameKey) private var clientName = ""
    @AppStorage(Settings.modelKey) private var model = ""

    @State private var models: [String] = []
    @State private var check: String?
    @State private var checking = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("http://192.168.1.10:8088", text: $serverURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("API-ключ", text: $apiKey)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Сервер")
                } footer: {
                    Text("Адрес llm-gateway и ключ из GATEWAY_KEYS в его .env.")
                }

                Section {
                    TextField(Settings.defaultClientName, text: $clientName)
                } header: {
                    Text("Имя устройства")
                } footer: {
                    Text("Показывается в логах сервера, чтобы различать клиенты.")
                }

                Section("Модель") {
                    Picker("Модель", selection: $model) {
                        Text("По умолчанию сервера").tag("")
                        ForEach(models, id: \.self) { Text($0).tag($0) }
                    }
                }

                Section {
                    Button {
                        Task { await runCheck() }
                    } label: {
                        HStack {
                            Text("Проверить подключение")
                            if checking { Spacer(); ProgressView() }
                        }
                    }
                    if let check {
                        Text(check).font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Настройки")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Готово") { dismiss() } }
            }
            .task { await runCheck() }
        }
    }

    private func runCheck() async {
        checking = true
        defer { checking = false }
        do {
            let client = try GatewayClient(serverURL: serverURL, apiKey: apiKey, clientName: clientName.isEmpty ? Settings.defaultClientName : clientName)
            let health = try await client.health()
            models = try await client.models()
            let limits = health.limits
            check = "✅ Подключено. Модель по умолчанию: \(health.defaultModel). Контекст \(limits.maxContextTokens) ток., ответ до \(limits.maxOutputTokens) ток., \(limits.rateLimitPerMinute) запросов/мин."
        } catch {
            check = "❌ \(error.localizedDescription)"
        }
    }
}
