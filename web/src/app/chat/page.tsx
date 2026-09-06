'use client';

import { FormEvent, useState } from 'react';

type Message = {
  role: 'user' | 'assistant';
  content: string;
};

type Format = 'text' | 'json';
type ReasoningMode = 'direct' | 'step-by-step' | 'self-prompt' | 'expert-panel';

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [format, setFormat] = useState<Format>('text');
  const [maxOutputTokens, setMaxOutputTokens] = useState('');
  const [stopSequence, setStopSequence] = useState('');
  const [reasoningMode, setReasoningMode] = useState<ReasoningMode>('direct');
  const [temperature, setTemperature] = useState('1');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function resetChat() {
    setMessages([]);
    setInput('');
    setError(null);
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const prompt = input.trim();
    if (!prompt || loading) return;

    setMessages((prev) => [...prev, { role: 'user', content: prompt }]);
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
        }),
      });

      if (!response.ok) {
        throw new Error(`Backend error: ${response.status} ${await response.text()}`);
      }

      const data: { answer: string } = await response.json();
      setMessages((prev) => [...prev, { role: 'assistant', content: data.answer }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto flex h-screen max-w-2xl flex-col gap-4 overflow-hidden bg-paper px-6 py-10 text-ink">
      <div className="shrink-0 flex items-center justify-between">
        <h1 className="text-2xl font-medium">Chat</h1>
        <button
          type="button"
          onClick={resetChat}
          disabled={loading || messages.length === 0}
          className="rounded-md border border-black/10 px-3 py-1 text-sm text-ink hover:bg-black/5 disabled:opacity-50"
        >
          Reset
        </button>
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
        {messages.length === 0 && (
          <p className="text-[#5c5c5c]">Ask the LLM something to get started.</p>
        )}
        {messages.map((message, index) => (
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
    </main>
  );
}
