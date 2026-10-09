import SwiftUI

struct ChatView: View {
    @State private var model = ChatViewModel()
    @State private var draft = ""
    @State private var showSettings = false
    @FocusState private var inputFocused: Bool
    @AppStorage(Settings.serverURLKey) private var serverURL = Settings.defaultServerURL

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 12) {
                        if model.messages.isEmpty {
                            emptyState
                        }
                        ForEach(model.messages) { message in
                            MessageRow(message: message).id(message.id)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: model.messages) {
                    withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo("bottom", anchor: .bottom) }
                }
            }
            .safeAreaInset(edge: .bottom) { inputBar }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) { titleView }
                ToolbarItem(placement: .topBarLeading) {
                    Button { model.reset() } label: { Image(systemName: "square.and.pencil") }
                        .accessibilityLabel("Новый чат")
                        .disabled(model.messages.isEmpty)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSettings = true } label: { Image(systemName: "gearshape") }
                        .accessibilityLabel("Настройки")
                }
            }
            .sheet(isPresented: $showSettings, onDismiss: { Task { await model.checkServer() } }) {
                SettingsView()
            }
            .task { await model.checkServer() }
        }
    }

    private var titleView: some View {
        VStack(spacing: 1) {
            Text("LLM Chat").font(.headline)
            HStack(spacing: 5) {
                Circle().fill(statusColor).frame(width: 7, height: 7)
                Text(statusText).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
        }
    }

    private var statusColor: Color {
        switch model.status {
        case .unknown: return .gray
        case .online: return .green
        case .offline: return .red
        }
    }

    private var statusText: String {
        switch model.status {
        case .unknown: return "проверка…"
        case .online(let name): return "\(name) · \(URL(string: serverURL)?.host ?? serverURL)"
        case .offline: return "нет связи с сервером"
        }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "bubble.left.and.text.bubble.right")
                .font(.system(size: 40))
                .foregroundStyle(.secondary)
            Text("Приватный чат с локальной LLM").font(.headline)
            Text("Сервер: \(serverURL)\nУстройство: \(Settings.clientName)")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            if case .offline(let reason) = model.status {
                Text(reason).font(.footnote).foregroundStyle(.red).multilineTextAlignment(.center)
                Button("Открыть настройки") { showSettings = true }.font(.footnote)
            }
        }
        .padding(.top, 80)
        .frame(maxWidth: .infinity)
    }

    private var inputBar: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Сообщение", text: $draft, axis: .vertical)
                .lineLimit(1...5)
                .focused($inputFocused)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20))
                .onSubmit(send)
                .accessibilityIdentifier("messageField")

            if model.isSending {
                Button(action: model.stop) {
                    Image(systemName: "stop.circle.fill").font(.system(size: 32))
                }
                .tint(.red)
                .accessibilityLabel("Остановить")
            } else {
                Button(action: send) {
                    Image(systemName: "arrow.up.circle.fill").font(.system(size: 32))
                }
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel("Отправить")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private func send() {
        guard !model.isSending else { return }
        model.send(draft)
        draft = ""
    }
}

private struct MessageRow: View {
    let message: Message

    var body: some View {
        switch message.role {
        case .user:
            HStack {
                Spacer(minLength: 48)
                Text(message.text)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 18))
                    .foregroundStyle(.white)
                    .opacity(message.failed ? 0.5 : 1)
                    .textSelection(.enabled)
            }
        case .assistant:
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Group {
                        if message.text.isEmpty && message.isStreaming {
                            ProgressView().padding(.vertical, 4)
                        } else {
                            Text(message.text + (message.isStreaming ? " ▍" : ""))
                                .textSelection(.enabled)
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))

                    if let meta = message.meta {
                        Text(meta).font(.caption2).foregroundStyle(.secondary).padding(.leading, 8)
                    }
                }
                Spacer(minLength: 48)
            }
        case .error:
            Label(message.text, systemImage: "exclamationmark.triangle.fill")
                .font(.footnote)
                .foregroundStyle(.red)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
        }
    }
}

#Preview {
    ChatView()
}
