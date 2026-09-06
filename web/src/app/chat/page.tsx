'use client';

import { FormEvent, useState } from 'react';

type Message = {
  role: 'user' | 'assistant';
  content: string;
};

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const prompt = input.trim();
    if (!prompt || loading) return;

    setMessages((prev) => [...prev, { role: 'user', content: prompt }]);
    setInput('');
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/backend/llm/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
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
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-4 bg-paper px-6 py-10 text-ink">
      <h1 className="text-2xl font-medium">Chat</h1>

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto rounded-lg border border-black/10 bg-white p-4">
        {messages.length === 0 && (
          <p className="text-sm text-[#5c5c5c]">Ask the LLM something to get started.</p>
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
        {loading && <p className="text-sm text-[#5c5c5c]">Thinking…</p>}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <form onSubmit={sendMessage} className="flex gap-2">
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
