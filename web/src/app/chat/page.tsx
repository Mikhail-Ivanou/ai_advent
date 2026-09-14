'use client';

import { FormEvent, useEffect, useState } from 'react';

type Usage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

type TokenCounts = {
  requestTokens: number;
  historyTokens: number;
  responseTokens: number;
};

type CompressionInfo = {
  enabled: boolean;
  keepLastN: number;
  summarizedMessageCount: number;
  recentMessageCount: number;
  summary: string;
  summaryUpdate?: { usage?: Usage; costByn?: number };
};

type LlmRequestLog = {
  label: string;
  /** The exact JSON body sent to the API for this call. */
  body: Record<string, unknown>;
};

type Message = {
  role: 'user' | 'assistant';
  content: string;
  meta?: {
    model: string;
    responseTimeMs: number;
    usage?: Usage;
    costByn?: number;
    tokens: TokenCounts;
    compression?: CompressionInfo;
    requests: LlmRequestLog[];
  };
};

type Format = 'text' | 'json';
type ReasoningMode = 'direct' | 'step-by-step' | 'self-prompt' | 'expert-panel';

type ChatSettings = {
  format: Format;
  maxOutputTokens: string;
  stopSequence: string;
  reasoningMode: ReasoningMode;
  temperature: string;
  model: string;
  compressionEnabled: boolean;
  keepLastN: string;
};

type Chat = {
  id: string;
  title: string;
  createdAt: number;
  messages: Message[];
  settings: ChatSettings;
};

const MODELS = [
  { value: 'deepseek-v4-flash', label: 'Слабая (deepseek-v4-flash)' },
  { value: 'deepseek-chat-v3', label: 'Средняя (deepseek-chat-v3)' },
  { value: 'kimi-k2.5', label: 'Средняя (kimi-k2.5)' },
  { value: 'deepseek-v4-pro', label: 'Сильная (deepseek-v4-pro)' },
  { value: 'gpt-3.5-turbo-instruct', label: 'Малое окно (gpt-3.5-turbo-instruct, 4k)' },
  { value: 'deepseek-r1-distill-llama-70b', label: 'Малое окно, ближе к DeepSeek (deepseek-r1-distill-llama-70b, 8k)' },
  { value: 'qwen-2.5-72b-instruct', label: 'Малое окно, быстрее (qwen-2.5-72b-instruct, 32k)' },
] as const;

const STORAGE_KEY = 'advent.chats';

function defaultSettings(): ChatSettings {
  return {
    format: 'text',
    maxOutputTokens: '',
    stopSequence: '',
    reasoningMode: 'direct',
    temperature: '1',
    model: MODELS[0].value,
    compressionEnabled: false,
    keepLastN: '20',
  };
}

function createChat(): Chat {
  return {
    id: crypto.randomUUID(),
    title: 'Новый чат',
    createdAt: Date.now(),
    messages: [],
    settings: defaultSettings(),
  };
}

// Older persisted chats may not have a `settings` field yet — backfill defaults.
function normalizeChat(chat: Chat): Chat {
  return { ...chat, settings: { ...defaultSettings(), ...chat.settings } };
}

function chatTitle(chat: Chat): string {
  const firstUserMessage = chat.messages.find((m) => m.role === 'user');
  if (!firstUserMessage) return chat.title;
  return firstUserMessage.content.length > 30
    ? `${firstUserMessage.content.slice(0, 30)}…`
    : firstUserMessage.content;
}

export default function ChatPage() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // Loading state and errors are keyed by chat id, so a request in one chat
  // never shows "Thinking…" or locks the input in another.
  const [loadingChatIds, setLoadingChatIds] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});

  const [input, setInput] = useState('');

  // Load persisted chats on mount, or seed with a single empty chat.
  useEffect(() => {
    let loaded: Chat[] = [];
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) loaded = JSON.parse(raw);
    } catch {
      loaded = [];
    }
    if (loaded.length === 0) loaded = [createChat()];
    loaded = loaded.map(normalizeChat);
    setChats(loaded);
    setActiveChatId(loaded[0].id);
    setHydrated(true);
  }, []);

  // Persist chats whenever they change.
  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(chats));
  }, [chats, hydrated]);

  const activeChat = chats.find((c) => c.id === activeChatId) ?? null;
  const isActiveLoading = activeChatId ? loadingChatIds.has(activeChatId) : false;
  const activeError = activeChatId ? (errors[activeChatId] ?? null) : null;

  const chatTotals = (activeChat?.messages ?? []).reduce(
    (totals, message) => {
      if (!message.meta) return totals;
      return {
        apiTokens: totals.apiTokens + (message.meta.usage?.totalTokens ?? 0),
        costByn: totals.costByn + (message.meta.costByn ?? 0),
      };
    },
    { apiTokens: 0, costByn: 0 },
  );

  const latestCompression = [...(activeChat?.messages ?? [])].reverse().find((m) => m.meta?.compression)?.meta
    ?.compression;
  const latestRequests = [...(activeChat?.messages ?? [])].reverse().find((m) => m.meta?.requests)?.meta?.requests;

  function newChat() {
    const chat = createChat();
    setChats((prev) => [chat, ...prev]);
    setActiveChatId(chat.id);
  }

  function deleteChat(id: string) {
    setChats((prev) => {
      const remaining = prev.filter((c) => c.id !== id);
      if (remaining.length > 0) {
        if (activeChatId === id) setActiveChatId(remaining[0].id);
        return remaining;
      }
      const fresh = createChat();
      setActiveChatId(fresh.id);
      return [fresh];
    });
    setLoadingChatIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setErrors((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    // Best-effort: drop the agent's persisted history server-side too.
    fetch(`/api/backend/agents/${id}`, { method: 'DELETE' }).catch(() => {});
  }

  function switchChat(id: string) {
    setActiveChatId(id);
  }

  function updateMessages(chatId: string, updater: (messages: Message[]) => Message[]) {
    setChats((prev) => prev.map((c) => (c.id === chatId ? { ...c, messages: updater(c.messages) } : c)));
  }

  function updateSettings(chatId: string, patch: Partial<ChatSettings>) {
    setChats((prev) =>
      prev.map((c) => (c.id === chatId ? { ...c, settings: { ...c.settings, ...patch } } : c)),
    );
  }

  function setChatLoading(chatId: string, isLoading: boolean) {
    setLoadingChatIds((prev) => {
      const next = new Set(prev);
      if (isLoading) next.add(chatId);
      else next.delete(chatId);
      return next;
    });
  }

  function setChatError(chatId: string, message: string | null) {
    setErrors((prev) => {
      const next = { ...prev };
      if (message) next[chatId] = message;
      else delete next[chatId];
      return next;
    });
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const chatId = activeChatId;
    const prompt = input.trim();
    if (!prompt || !chatId || loadingChatIds.has(chatId)) return;

    const settings = chats.find((c) => c.id === chatId)?.settings ?? defaultSettings();

    updateMessages(chatId, (messages) => [...messages, { role: 'user', content: prompt }]);
    setInput('');
    setChatLoading(chatId, true);
    setChatError(chatId, null);

    const parsedMaxTokens = parseInt(settings.maxOutputTokens, 10);
    const parsedKeepLastN = parseInt(settings.keepLastN, 10);

    try {
      const response = await fetch(`/api/backend/agents/${chatId}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          format: settings.format,
          maxOutputTokens: Number.isFinite(parsedMaxTokens) && parsedMaxTokens > 0 ? parsedMaxTokens : undefined,
          stopSequence: settings.stopSequence.trim() || undefined,
          reasoningMode: settings.reasoningMode,
          temperature: parseFloat(settings.temperature),
          model: settings.model,
          compression: {
            enabled: settings.compressionEnabled,
            keepLastN: Number.isFinite(parsedKeepLastN) && parsedKeepLastN >= 0 ? parsedKeepLastN : 20,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`Backend error: ${response.status} ${await response.text()}`);
      }

      const data: {
        answer: string;
        model: string;
        responseTimeMs: number;
        usage?: Usage;
        costByn?: number;
        tokens: TokenCounts;
        compression?: CompressionInfo;
        requests: LlmRequestLog[];
      } = await response.json();

      updateMessages(chatId, (messages) => [
        ...messages,
        {
          role: 'assistant',
          content: data.answer,
          meta: {
            model: data.model,
            responseTimeMs: data.responseTimeMs,
            usage: data.usage,
            costByn: data.costByn,
            tokens: data.tokens,
            compression: data.compression,
            requests: data.requests,
          },
        },
      ]);
    } catch (err) {
      setChatError(chatId, err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setChatLoading(chatId, false);
    }
  }

  if (!hydrated || !activeChat) {
    return null;
  }

  const settings = activeChat.settings;

  return (
    <main className="mx-auto flex h-screen max-w-[100rem] gap-4 overflow-hidden bg-paper px-6 py-10 text-ink">
      <aside className="flex w-56 shrink-0 flex-col gap-2">
        <button
          type="button"
          onClick={newChat}
          className="rounded-md bg-pine px-3 py-2 text-sm text-white hover:opacity-90"
        >
          + Новый чат
        </button>
        <div className="flex flex-1 flex-col gap-1 overflow-y-auto">
          {chats.map((chat) => (
            <div
              key={chat.id}
              onClick={() => switchChat(chat.id)}
              className={`group flex cursor-pointer items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm ${
                chat.id === activeChatId
                  ? 'border-pine bg-white font-medium'
                  : 'border-black/10 bg-white/50 hover:bg-white'
              }`}
            >
              <span className="truncate">
                {chatTitle(chat)}
                {loadingChatIds.has(chat.id) && <span className="ml-1 text-pine">…</span>}
              </span>
              <button
                type="button"
                title="Удалить чат"
                onClick={(event) => {
                  event.stopPropagation();
                  deleteChat(chat.id);
                }}
                className="shrink-0 rounded px-1 text-[#5c5c5c] opacity-0 hover:bg-black/5 hover:text-red-600 group-hover:opacity-100"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-hidden">
        <div className="shrink-0 flex items-center justify-between">
          <h1 className="truncate text-2xl font-medium">{chatTitle(activeChat)}</h1>
        </div>

        <div className="shrink-0 flex flex-wrap gap-4 rounded-lg border border-black/10 bg-white p-4 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-pine">Reasoning mode</span>
            <select
              value={settings.reasoningMode}
              onChange={(event) =>
                updateSettings(activeChat.id, { reasoningMode: event.target.value as ReasoningMode })
              }
              className="rounded-md border border-black/10 px-2 py-1"
              disabled={isActiveLoading}
            >
              <option value="direct">Direct answer</option>
              <option value="step-by-step">Step by step</option>
              <option value="self-prompt">Self-authored prompt</option>
              <option value="expert-panel">Expert panel</option>
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-pine">Model</span>
            <select
              value={settings.model}
              onChange={(event) => updateSettings(activeChat.id, { model: event.target.value })}
              className="rounded-md border border-black/10 px-2 py-1"
              disabled={isActiveLoading}
            >
              {MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-pine">Temperature</span>
            <select
              value={settings.temperature}
              onChange={(event) => updateSettings(activeChat.id, { temperature: event.target.value })}
              className="rounded-md border border-black/10 px-2 py-1"
              disabled={isActiveLoading}
            >
              <option value="0">0</option>
              <option value="0.7">0.7</option>
              <option value="1">1 (default)</option>
              <option value="1.2">1.2</option>
              <option value="1.7">1.7</option>
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-pine">Response format</span>
            <select
              value={settings.format}
              onChange={(event) => updateSettings(activeChat.id, { format: event.target.value as Format })}
              className="rounded-md border border-black/10 px-2 py-1"
              disabled={isActiveLoading}
            >
              <option value="text">Plain text</option>
              <option value="json">JSON</option>
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-pine">Max output tokens</span>
            <input
              type="number"
              min={1}
              value={settings.maxOutputTokens}
              onChange={(event) => updateSettings(activeChat.id, { maxOutputTokens: event.target.value })}
              placeholder="No limit"
              className="w-32 rounded-md border border-black/10 px-2 py-1"
              disabled={isActiveLoading}
            />
          </label>

          <label className="flex flex-1 min-w-[12rem] flex-col gap-1">
            <span className="text-xs text-pine">Stop sequence / instruction</span>
            <input
              type="text"
              value={settings.stopSequence}
              onChange={(event) => updateSettings(activeChat.id, { stopSequence: event.target.value })}
              placeholder='e.g. "###" or "stop after the summary"'
              className="rounded-md border border-black/10 px-2 py-1"
              disabled={isActiveLoading}
            />
          </label>

          <label className="flex flex-col gap-1 justify-end">
            <span className="flex items-center gap-1 text-xs text-pine">
              <input
                type="checkbox"
                checked={settings.compressionEnabled}
                onChange={(event) => updateSettings(activeChat.id, { compressionEnabled: event.target.checked })}
                disabled={isActiveLoading}
              />
              Сжатие истории
            </span>
            <input
              type="number"
              min={0}
              value={settings.keepLastN}
              onChange={(event) => updateSettings(activeChat.id, { keepLastN: event.target.value })}
              placeholder="Хранить как есть, N сообщений"
              className="w-40 rounded-md border border-black/10 px-2 py-1"
              disabled={isActiveLoading || !settings.compressionEnabled}
            />
          </label>
        </div>

        <div className="flex flex-1 flex-col gap-3 overflow-y-auto rounded-lg border border-black/10 bg-white p-4 text-sm">
          {activeChat.messages.length === 0 && (
            <p className="text-[#5c5c5c]">Ask the LLM something to get started.</p>
          )}
          {activeChat.messages.map((message, index) => (
            <div
              key={index}
              className={message.role === 'user' ? 'self-end text-right' : 'self-start text-left'}
            >
              <span className="mb-1 block text-xs text-pine">
                {message.role === 'user' ? 'You' : 'Assistant'}
              </span>
              <p className="inline-block whitespace-pre-wrap rounded-lg bg-paper px-3 py-2">
                {message.content}
              </p>
              {message.meta && (
                <>
                  <p className="mt-1 text-xs text-[#5c5c5c]">
                    {message.meta.model} · {(message.meta.responseTimeMs / 1000).toFixed(1)}с
                    {message.meta.usage && <> · {message.meta.usage.totalTokens} токенов</>}
                    {message.meta.costByn !== undefined && (
                      <> · {message.meta.costByn.toFixed(5)} BYN</>
                    )}
                  </p>
                  <p className="text-xs text-[#5c5c5c]">
                    запрос: {message.meta.tokens.requestTokens} · ответ: {message.meta.tokens.responseTokens} токенов
                  </p>
                </>
              )}
            </div>
          ))}
          {isActiveLoading && <p className="text-[#5c5c5c]">Thinking…</p>}
        </div>

        {activeChat.messages.length > 0 && (
          <p className="shrink-0 text-xs text-[#5c5c5c]">
            Итого по чату: {chatTotals.apiTokens} токенов (по данным API) · {chatTotals.costByn.toFixed(5)} BYN
          </p>
        )}

        {settings.compressionEnabled && latestCompression && (
          <p className="shrink-0 text-xs text-[#5c5c5c]">
            Сжатие истории: как есть — {latestCompression.recentMessageCount} сообщ. · обобщено —{' '}
            {latestCompression.summarizedMessageCount} сообщ.
            {latestCompression.summary && ` · summary: ${latestCompression.summary.slice(0, 120)}${latestCompression.summary.length > 120 ? '…' : ''}`}
          </p>
        )}

        {activeError && <p className="shrink-0 text-sm text-red-600">{activeError}</p>}

        <form onSubmit={sendMessage} className="shrink-0 flex gap-2">
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Type a message…"
            className="flex-1 rounded-lg border border-black/10 px-3 py-2 outline-none focus:border-pine"
            disabled={isActiveLoading}
          />
          <button
            type="submit"
            disabled={isActiveLoading || !input.trim()}
            className="rounded-lg bg-pine px-4 py-2 text-white disabled:opacity-50"
          >
            Send
          </button>
        </form>
      </div>

      <aside className="flex w-96 shrink-0 flex-col gap-2 overflow-hidden">
        <h2 className="shrink-0 text-sm font-medium text-pine">
          Фактический запрос {latestRequests && latestRequests.length > 1 ? `(${latestRequests.length})` : ''}
        </h2>
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto rounded-lg border border-black/10 bg-white p-3 text-xs">
          {!latestRequests && <p className="text-[#5c5c5c]">Здесь появится последний запрос к модели.</p>}
          {latestRequests?.map((req, reqIndex) => (
            <div key={reqIndex} className="rounded-md border border-black/10 p-2">
              <p className="mb-1 font-mono font-semibold text-pine">{req.label}</p>
              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-ink">
                {JSON.stringify(req.body, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      </aside>
    </main>
  );
}
