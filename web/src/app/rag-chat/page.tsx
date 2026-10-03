'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Grounding, GroundingView } from '@/components/GroundingView';

// Day 25: mini chat over the document index — history, RAG on every message,
// sources on every answer, and the task memory of the dialog (goal,
// clarifications, constraints, terms), kept on the backend.

type TaskMemory = { goal: string; clarified: string[]; constraints: string[]; terms: string[] };
type Kind = 'search' | 'dialog' | 'note';
type Rerank = 'none' | 'cross-encoder' | 'llm';

type Message = {
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  meta?: {
    kind: Kind;
    searchQuery: string;
    grounding: Grounding;
    candidates: number;
    hits: { chunk_id: string; score: number; rerankScore?: number; section: string; text: string }[];
    model: string;
    durationMs: number;
    tokens?: number;
    memory: TaskMemory;
  };
};

type Chat = {
  id: string;
  title: string;
  messages: Message[];
  memory: TaskMemory;
  settings: { rerank?: Rerank; minScore?: number; k?: number; candidates?: number; rewrite?: boolean };
};

type ChatSummary = { id: string; title: string; updatedAt: string; messages: number; goal: string };

const KIND_LABELS: Record<Kind, string> = {
  search: 'поиск по документам',
  dialog: 'по истории диалога',
  note: 'запись в память',
};

const MEMORY_FIELDS: { key: keyof Omit<TaskMemory, 'goal'>; label: string; hint: string }[] = [
  { key: 'clarified', label: 'Уточнено', hint: 'кого/что пользователь имеет в виду' },
  { key: 'constraints', label: 'Ограничения', hint: 'длина, формат, рамки' },
  { key: 'terms', label: 'Термины', hint: 'термин — значение' },
];

const RERANK_THRESHOLDS: Record<Rerank, number> = { none: 0, 'cross-encoder': 0.2, llm: 0.6 };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/backend/rag-chat${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message ?? `HTTP ${response.status}`);
  return body as T;
}

function AssistantMessage({ message }: { message: Message }) {
  const meta = message.meta;
  if (!meta) return <p className="whitespace-pre-wrap">{message.content}</p>;
  const g = meta.grounding;
  return (
    <div className="flex flex-col gap-1">
      <p className="whitespace-pre-wrap">{g.answer}</p>
      {meta.kind === 'search' && <GroundingView grounding={g} />}
      {meta.kind === 'dialog' && (
        <div className="rounded-md border border-black/10 bg-white px-2 py-1 text-[11px]">
          <p className="text-pine">Источники, собранные в этом диалоге ({g.sources.length}):</p>
          <ul className="pl-2">
            {g.sources.map((s) => (
              <li key={s.chunk_id}>
                [S{s.n}] {s.file} › {s.section.split(' › ').slice(-1)[0]} <span className="font-mono text-[#5c5c5c]">{s.chunk_id}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-[11px] text-[#5c5c5c]">
        {KIND_LABELS[meta.kind]}
        {meta.searchQuery && (
          <>
            {' '}
            · запрос: <span className="text-ink">«{meta.searchQuery}»</span>
          </>
        )}
        {meta.kind === 'search' && (
          <>
            {' '}
            · кандидатов {meta.candidates} → {meta.hits.length}
          </>
        )}{' '}
        · {(meta.durationMs / 1000).toFixed(1)} с{meta.tokens ? ` · ${meta.tokens} ток.` : ''} · {meta.model}
      </p>
      {meta.hits.length > 0 && (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-[#5c5c5c]">Фрагменты в контексте ({meta.hits.length})</summary>
          <ol className="mt-1 flex flex-col gap-1">
            {meta.hits.map((h, i) => (
              <li key={h.chunk_id} className="rounded border border-black/5 p-1">
                <span className="font-mono">[{i + 1}]</span> {h.section.split(' › ').slice(-1)[0]} · cos {h.score.toFixed(3)}
                {h.rerankScore !== undefined && <> · реранкер {h.rerankScore.toFixed(3)}</>}
                <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-[#5c5c5c]">{h.text}</p>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

export default function RagChatPage() {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chat, setChat] = useState<Chat | null>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [memoryDraft, setMemoryDraft] = useState<TaskMemory | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const refreshList = useCallback(async () => {
    const data = await api<{ chats: ChatSummary[] }>('');
    setChats(data.chats);
    return data.chats;
  }, []);

  const open = useCallback(async (id: string) => {
    setChat(await api<Chat>(`/${id}`));
    setMemoryDraft(null);
  }, []);

  useEffect(() => {
    refreshList()
      .then((list) => list[0] && open(list[0].id))
      .catch((e) => setError(e.message));
  }, [refreshList, open]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chat?.messages.length, sending]);

  async function createChat() {
    const created = await api<Chat>('', { method: 'POST', body: '{}' });
    await refreshList();
    setChat(created);
    setMemoryDraft(null);
  }

  async function deleteChat(id: string) {
    if (!confirm('Удалить диалог?')) return;
    await api(`/${id}`, { method: 'DELETE' });
    const list = await refreshList();
    if (chat?.id === id) {
      if (list[0]) await open(list[0].id);
      else setChat(null);
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || !chat || sending) return;
    setSending(true);
    setError(null);
    setInput('');
    // Shown right away; the backend returns the whole updated chat.
    setChat({ ...chat, messages: [...chat.messages, { role: 'user', content: text, createdAt: new Date().toISOString() }] });
    try {
      const { chat: updated } = await api<{ chat: Chat }>(`/${chat.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: text }),
      });
      setChat(updated);
      setMemoryDraft(null);
      refreshList();
    } catch (e) {
      setError((e as Error).message);
      setChat(chat);
      setInput(text);
    } finally {
      setSending(false);
    }
  }

  async function saveMemory(memory: TaskMemory) {
    if (!chat) return;
    setChat(await api<Chat>(`/${chat.id}/memory`, { method: 'PUT', body: JSON.stringify(memory) }));
    setMemoryDraft(null);
    refreshList();
  }

  async function saveSettings(settings: Chat['settings']) {
    if (!chat) return;
    setChat(await api<Chat>(`/${chat.id}/settings`, { method: 'PUT', body: JSON.stringify(settings) }));
  }

  const memory = memoryDraft ?? chat?.memory;
  const rerank = (chat?.settings.rerank ?? 'cross-encoder') as Rerank;
  const input_ = 'rounded border border-black/15 px-1.5 py-0.5';

  return (
    <main className="flex h-screen gap-4 bg-paper p-4 text-sm text-ink">
      <aside className="flex w-56 shrink-0 flex-col gap-2">
        <button type="button" onClick={createChat} className="rounded-md bg-pine px-3 py-2 text-white">
          + Новый диалог
        </button>
        <div className="flex flex-1 flex-col gap-1 overflow-y-auto">
          {chats.map((c) => (
            <div
              key={c.id}
              onClick={() => open(c.id)}
              className={`group cursor-pointer rounded-md border px-2 py-1.5 ${
                c.id === chat?.id ? 'border-pine bg-white' : 'border-black/10 bg-white/50 hover:bg-white'
              }`}
            >
              <div className="flex items-start justify-between gap-1">
                <span className="line-clamp-2 font-medium">{c.title}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteChat(c.id);
                  }}
                  className="text-[#5c5c5c] opacity-0 hover:text-red-600 group-hover:opacity-100"
                >
                  ×
                </button>
              </div>
              {c.goal && <p className="line-clamp-2 text-[11px] text-[#5c5c5c]">🎯 {c.goal}</p>}
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-1 text-[12px]">
          <Link href="/rag" className="text-pine underline">
            Документы и индекс →
          </Link>
          <Link href="/chat" className="text-pine underline">
            Основной чат →
          </Link>
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col gap-2">
        <h1 className="truncate text-xl font-medium">{chat?.title ?? 'Мини-чат с RAG'}</h1>
        {error && <div className="rounded-md border border-red-300 bg-red-50 px-3 py-1 text-red-700">{error}</div>}
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto rounded-lg border border-black/10 bg-white p-3">
          {!chat ? (
            <p className="text-[#5c5c5c]">Создайте диалог.</p>
          ) : !chat.messages.length ? (
            <p className="text-[#5c5c5c]">
              Задайте цель и первый вопрос — например: «Хочу собрать досье на Ника Завадски. Откуда он родом?». Каждое сообщение
              ищется в документах, ответ приходит с источниками и цитатами, а цель, уточнения, ограничения и термины копятся в
              памяти задачи справа.
            </p>
          ) : (
            chat.messages.map((m, i) => (
              <div key={i} className={m.role === 'user' ? 'max-w-[80%] self-end' : 'max-w-[92%] self-start'}>
                <span className="mb-0.5 block text-[11px] text-pine">{m.role === 'user' ? 'Вы' : 'Ассистент'}</span>
                <div className={`rounded-lg px-3 py-2 ${m.role === 'user' ? 'bg-pine/10' : 'bg-paper'}`}>
                  {m.role === 'user' ? <p className="whitespace-pre-wrap">{m.content}</p> : <AssistantMessage message={m} />}
                </div>
              </div>
            ))
          )}
          {sending && <p className="text-[#5c5c5c]">Ищу в документах и отвечаю…</p>}
          <div ref={bottom} />
        </div>
        <form onSubmit={send} className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={chat ? 'Вопрос, уточнение или ограничение…' : 'Сначала создайте диалог'}
            disabled={!chat || sending}
            className="min-w-0 flex-1 rounded-md border border-black/15 px-3 py-2"
          />
          <button type="submit" disabled={!chat || sending || !input.trim()} className="rounded-md bg-pine px-4 py-2 text-white disabled:opacity-40">
            Отправить
          </button>
        </form>
      </section>

      <aside className="flex w-72 shrink-0 flex-col gap-3 overflow-y-auto">
        {chat && memory && (
          <section className="rounded-lg border border-black/10 bg-white p-3 text-xs">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-medium text-pine">Память задачи</h2>
              {memoryDraft ? (
                <span className="flex gap-2">
                  <button type="button" className="text-pine underline" onClick={() => saveMemory(memoryDraft)}>
                    сохранить
                  </button>
                  <button type="button" className="text-[#5c5c5c] underline" onClick={() => setMemoryDraft(null)}>
                    отмена
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="text-[#5c5c5c] underline"
                  onClick={() => saveMemory({ goal: '', clarified: [], constraints: [], terms: [] })}
                >
                  сбросить
                </button>
              )}
            </div>
            <label className="mb-2 block">
              <span className="font-medium">🎯 Цель диалога</span>
              <textarea
                value={memory.goal}
                placeholder="задаётся первым сообщением"
                onChange={(e) => setMemoryDraft({ ...memory, goal: e.target.value })}
                className="mt-1 w-full rounded border border-black/10 p-1"
                rows={2}
              />
            </label>
            {MEMORY_FIELDS.map((f) => (
              <label key={f.key} className="mb-2 block">
                <span className="font-medium">{f.label}</span> <span className="text-[#5c5c5c]">— {f.hint}, по строке</span>
                <textarea
                  value={memory[f.key].join('\n')}
                  onChange={(e) => setMemoryDraft({ ...memory, [f.key]: e.target.value.split('\n') })}
                  className="mt-1 w-full rounded border border-black/10 p-1"
                  rows={Math.max(2, memory[f.key].length)}
                />
              </label>
            ))}
            <p className="text-[11px] text-[#5c5c5c]">
              Обновляется после каждого сообщения; правку вручную увидит следующий ответ.
            </p>
          </section>
        )}
        {chat && (
          <section className="rounded-lg border border-black/10 bg-white p-3 text-xs">
            <h2 className="mb-2 text-sm font-medium text-pine">Поиск</h2>
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center justify-between gap-2">
                реранкер
                <select
                  value={rerank}
                  onChange={(e) => {
                    const r = e.target.value as Rerank;
                    saveSettings({ rerank: r, minScore: RERANK_THRESHOLDS[r] });
                  }}
                  className={input_}
                >
                  <option value="cross-encoder">cross-encoder</option>
                  <option value="llm">LLM</option>
                  <option value="none">нет</option>
                </select>
              </label>
              <label className="flex items-center justify-between gap-2" title="ниже порога — «не знаю» без вызова LLM">
                порог релевантности
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={chat.settings.minScore ?? 0}
                  onChange={(e) => saveSettings({ minScore: Number(e.target.value) })}
                  className={`${input_} w-16`}
                />
              </label>
              <label className="flex items-center justify-between gap-2">
                фрагментов в ответ (top-K)
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={chat.settings.k ?? 5}
                  onChange={(e) => saveSettings({ k: Number(e.target.value) })}
                  className={`${input_} w-16`}
                />
              </label>
              <label className="flex items-center justify-between gap-2">
                query rewrite
                <input type="checkbox" checked={!!chat.settings.rewrite} onChange={(e) => saveSettings({ rewrite: e.target.checked })} />
              </label>
            </div>
          </section>
        )}
      </aside>
    </main>
  );
}
