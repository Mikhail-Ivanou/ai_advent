'use client';

import { FormEvent, useEffect, useState } from 'react';

type Usage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

type Message = {
  role: 'user' | 'assistant';
  content: string;
  meta?: {
    model: string;
    responseTimeMs: number;
    usage?: Usage;
    costByn?: number;
  };
};

type Chat = {
  id: string;
  title: string;
  createdAt: number;
  messages: Message[];
};

type Format = 'text' | 'json';
type ReasoningMode = 'direct' | 'step-by-step' | 'self-prompt' | 'expert-panel';

const MODELS = [
  { value: 'deepseek-v4-flash', label: 'Слабая (deepseek-v4-flash)' },
  { value: 'deepseek-chat-v3', label: 'Средняя (deepseek-chat-v3)' },
  { value: 'kimi-k2.5', label: 'Средняя (kimi-k2.5)' },
  { value: 'deepseek-v4-pro', label: 'Сильная (deepseek-v4-pro)' },
] as const;

const STORAGE_KEY = 'advent.chats';

function createChat(): Chat {
  return {
    id: crypto.randomUUID(),
    title: 'Новый чат',
    createdAt: Date.now(),
    messages: [],
  };
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

  const [input, setInput] = useState('');
  const [format, setFormat] = useState<Format>('text');
  const [maxOutputTokens, setMaxOutputTokens] = useState('');
  const [stopSequence, setStopSequence] = useState('');
  const [reasoningMode, setReasoningMode] = useState<ReasoningMode>('direct');
  const [temperature, setTemperature] = useState('1');
  const [model, setModel] = useState<string>(MODELS[0].value);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  function newChat() {
    const chat = createChat();
    setChats((prev) => [chat, ...prev]);
    setActiveChatId(chat.id);
    setError(null);
  }

  function deleteChat(id: string) {
    setChats((prev) => {
      const next = prev.filter((c) => c.id !== id);
      if (activeChatId === id) {
        setActiveChatId(next[0]?.id ?? null);
      }
      return next.length > 0 ? next : [createChat()];
    });
  }

  function switchChat(id: string) {
    if (id === activeChatId) return;
    setActiveChatId(id);
    setError(null);
  }

  function updateActiveMessages(updater: (messages: Message[]) => Message[]) {
    setChats((prev) =>
      prev.map((c) => (c.id === activeChatId ? { ...c, messages: updater(c.messages) } : c)),
    );
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const prompt = input.trim();
    if (!prompt || loading || !activeChatId) return;

    updateActiveMessages((messages) => [...messages, { role: 'user', content: prompt }]);
    setInput('');
    setLoading(true);
    setError(null);

    const parsedMaxTokens = parseInt(maxOutputTokens, 10);

    try {
      const response = await fetch('/api/backend/llm/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          format,
          maxOutputTokens: Number.isFinite(parsedMaxTokens) && parsedMaxTokens > 0 ? parsedMaxTokens : undefined,
          stopSequence: stopSequence.trim() || undefined,
          reasoningMode,
          temperature: parseFloat(temperature),
          model,
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
      } = await response.json();

      updateActiveMessages((messages) => [
        ...messages,
        {
          role: 'assistant',
          content: data.answer,
          meta: {
            model: data.model,
            responseTimeMs: data.responseTimeMs,
            usage: data.usage,
            costByn: data.costByn,
          },
        },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  if (!hydrated || !activeChat) {
    return null;
  }

  return (
    <main className="mx-auto flex h-screen max-w-5xl gap-4 overflow-hidden bg-paper px-6 py-10 text-ink">
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
              <span className="truncate">{chatTitle(chat)}</span>
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
              value={reasoningMode}
              onChange={(event) => setReasoningMode(event.target.value as ReasoningMode)}
              className="rounded-md border border-black/10 px-2 py-1"
              disabled={loading}
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
              value={model}
              onChange={(event) => setModel(event.target.value)}
              className="rounded-md border border-black/10 px-2 py-1"
              disabled={loading}
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
              value={temperature}
              onChange={(event) => setTemperature(event.target.value)}
              className="rounded-md border border-black/10 px-2 py-1"
              disabled={loading}
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
              value={format}
              onChange={(event) => setFormat(event.target.value as Format)}
              className="rounded-md border border-black/10 px-2 py-1"
              disabled={loading}
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
              value={maxOutputTokens}
              onChange={(event) => setMaxOutputTokens(event.target.value)}
              placeholder="No limit"
              className="w-32 rounded-md border border-black/10 px-2 py-1"
              disabled={loading}
            />
          </label>

          <label className="flex flex-1 min-w-[12rem] flex-col gap-1">
            <span className="text-xs text-pine">Stop sequence / instruction</span>
            <input
              type="text"
              value={stopSequence}
              onChange={(event) => setStopSequence(event.target.value)}
              placeholder='e.g. "###" or "stop after the summary"'
              className="rounded-md border border-black/10 px-2 py-1"
              disabled={loading}
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
                <p className="mt-1 text-xs text-[#5c5c5c]">
                  {message.meta.model} · {(message.meta.responseTimeMs / 1000).toFixed(1)}с
                  {message.meta.usage && <> · {message.meta.usage.totalTokens} токенов</>}
                  {message.meta.costByn !== undefined && (
                    <> · {message.meta.costByn.toFixed(5)} BYN</>
                  )}
                </p>
              )}
            </div>
          ))}
          {loading && <p className="text-[#5c5c5c]">Thinking…</p>}
        </div>

        {error && <p className="shrink-0 text-sm text-red-600">{error}</p>}

        <form onSubmit={sendMessage} className="shrink-0 flex gap-2">
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Type a message…"
            className="flex-1 rounded-lg border border-black/10 px-3 py-2 outline-none focus:border-pine"
            disabled={loading}
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="rounded-lg bg-pine px-4 py-2 text-white disabled:opacity-50"
          >
            Send
          </button>
        </form>
      </div>
    </main>
  );
}
