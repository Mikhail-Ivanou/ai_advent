'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';

// Day 29: the local model (qwen2.5:7b in Ollama) on one task — a customer's
// e-mail -> the order as JSON. One chat per configuration: the same e-mail
// sent to each shows what temperature, max tokens, the context window and
// the quantization change. The prompt is the same in every chat.

const FIELDS = ['customer', 'phone', 'city', 'items', 'delivery_date', 'payment', 'urgent'] as const;
type Field = (typeof FIELDS)[number];

const FIELD_LABELS: Record<Field, string> = {
  customer: 'покупатель',
  phone: 'телефон',
  city: 'город',
  items: 'товары',
  delivery_date: 'дата доставки',
  payment: 'оплата',
  urgent: 'срочно',
};

type Params = { temperature?: number; num_predict?: number; num_ctx?: number };
type Config = { id: string; label: string; modelName: string; quant: string; params: Params };
type Expected = { customer: string; phone: string; city: string; items: Record<string, number>; delivery_date: string | null; payment: string; urgent: boolean };
type Example = { id: string; about: string; date: string; text: string; expected: Expected };
type Meta = { systemPrompt: string; opt: Params; configs: Config[]; examples: Example[] };

type Metrics = {
  totalMs: number;
  loadMs: number;
  promptTokens: number;
  promptEstimate: number;
  promptMs: number;
  outputTokens: number;
  outputMs: number;
  doneReason: string;
  memoryBytes: number;
  contextLength: number;
};

type Message = {
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  date?: string;
  exampleId?: string;
  order?: Record<string, unknown>;
  check?: Record<Field, boolean>;
  metrics?: Metrics;
  error?: string;
};

type Chat = { id: string; title: string; configId: string; model: string; quant: string; params: Params; messages: Message[] };
type ChatSummary = Omit<Chat, 'messages'> & { messages: number };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/backend/order-extract${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message ?? `HTTP ${response.status}`);
  return body as T;
}

const sec = (ms: number) => `${(ms / 1000).toFixed(1)} с`;
const gib = (b: number) => `${(b / 2 ** 30).toFixed(1)} ГиБ`;

/** The chat's parameters as chips: what is sent, or the default that applies instead. */
function ParamChips({ chat, opt }: { chat: Chat | ChatSummary; opt: Params }) {
  const fromModelfile = chat.model === 'order-extractor';
  const value = (key: keyof Params, fallback: string) =>
    chat.params[key] !== undefined ? { text: String(chat.params[key]), set: true } : fromModelfile ? { text: `${opt[key]} (Modelfile)`, set: true } : { text: `${fallback} (по умолч.)`, set: false };
  const chips = [
    { label: 'модель', text: `${chat.model} · ${chat.quant}`, set: true },
    { label: 'temperature', ...value('temperature', '0.7') },
    { label: 'max tokens', ...value('num_predict', 'без лимита') },
    { label: 'окно', ...value('num_ctx', '32768') },
  ];
  return (
    <div className="flex flex-wrap gap-1 text-[11px]">
      {chips.map((c) => (
        <span key={c.label} className={`rounded-full border px-2 py-0.5 ${c.set ? 'border-pine/40 bg-pine/10' : 'border-black/10 bg-black/5 text-[#5c5c5c]'}`}>
          {c.label}: <b className="font-medium">{c.text}</b>
        </span>
      ))}
    </div>
  );
}

function show(v: unknown): string {
  if (v === undefined) return '—';
  if (Array.isArray(v)) return v.map((it) => `${it?.sku ?? '?'} × ${it?.qty ?? '?'}`).join(', ') || '[]';
  if (v === null) return 'null';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

function showExpected(field: Field, e: Expected): string {
  if (field === 'items') return Object.entries(e.items).map(([sku, qty]) => `${sku} × ${qty}`).join(', ');
  return show(e[field]);
}

function UserMessage({ message, example }: { message: Message; example?: Example }) {
  const [open, setOpen] = useState(false);
  const long = message.content.length > 600;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[11px] text-[#5c5c5c]">
        Дата письма: {message.date}
        {example && (
          <>
            {' '}
            · контрольное письмо <b>{example.id}</b> — {example.about}
          </>
        )}
        {long && ` · ${message.content.length.toLocaleString('ru')} символов`}
      </p>
      <p className={`whitespace-pre-wrap ${long && !open ? 'max-h-32 overflow-hidden' : ''}`}>{message.content}</p>
      {long && (
        <button type="button" onClick={() => setOpen(!open)} className="self-start text-[11px] text-pine underline">
          {open ? 'свернуть' : 'показать письмо целиком'}
        </button>
      )}
    </div>
  );
}

function AssistantMessage({ message, example }: { message: Message; example?: Example }) {
  const [raw, setRaw] = useState(false);
  if (message.error) return <p className="text-red-700">Ошибка: {message.error}</p>;
  const m = message.metrics;
  const truncatedPrompt = m && m.promptTokens < m.promptEstimate * 0.75;
  const correct = message.check ? FIELDS.filter((f) => message.check![f]).length : undefined;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {message.order ? (
          <span className="rounded bg-pine/15 px-2 py-0.5 text-[12px] text-pine">JSON разобран</span>
        ) : (
          <span className="rounded bg-red-100 px-2 py-0.5 text-[12px] text-red-700">Не JSON — заказ не получен</span>
        )}
        {correct !== undefined && (
          <span className={`rounded px-2 py-0.5 text-[12px] font-medium ${correct === FIELDS.length ? 'bg-pine text-white' : 'bg-amber-100 text-amber-800'}`}>
            верно {correct} из {FIELDS.length} полей
          </span>
        )}
        {!message.order && example && (
          <span className="rounded bg-red-600 px-2 py-0.5 text-[12px] font-medium text-white">верно 0 из {FIELDS.length} полей</span>
        )}
        {m?.doneReason === 'length' && <span className="rounded bg-red-100 px-2 py-0.5 text-[12px] text-red-700">ответ оборван: упёрся в max tokens</span>}
        {truncatedPrompt && (
          <span className="rounded bg-red-100 px-2 py-0.5 text-[12px] text-red-700">
            промпт не влез в окно: прочитано {m!.promptTokens} из ≈{m!.promptEstimate} токенов
          </span>
        )}
      </div>

      {message.order && (
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr className="text-left text-[#5c5c5c]">
              <th className="border-b border-black/10 py-0.5 pr-2 font-normal">поле</th>
              <th className="border-b border-black/10 py-0.5 pr-2 font-normal">ответ модели</th>
              {example && <th className="border-b border-black/10 py-0.5 pr-2 font-normal">ожидалось</th>}
              {message.check && <th className="border-b border-black/10 py-0.5 font-normal" />}
            </tr>
          </thead>
          <tbody>
            {FIELDS.map((f) => (
              <tr key={f} className={message.check && !message.check[f] ? 'bg-red-50' : ''}>
                <td className="py-0.5 pr-2 text-[#5c5c5c]">{FIELD_LABELS[f]}</td>
                <td className="py-0.5 pr-2 font-mono">{show(message.order![f])}</td>
                {example && <td className="py-0.5 pr-2 font-mono text-[#5c5c5c]">{showExpected(f, example.expected)}</td>}
                {message.check && <td className="py-0.5">{message.check[f] ? '✅' : '❌'}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {(!message.order || raw) && <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-black/5 p-2 text-[12px]">{message.content || '(пусто)'}</pre>}
      {message.order && (
        <button type="button" onClick={() => setRaw(!raw)} className="self-start text-[11px] text-pine underline">
          {raw ? 'скрыть ответ как есть' : 'ответ модели как есть'}
        </button>
      )}

      {m && (
        <p className="text-[11px] text-[#5c5c5c]">
          ⏱ {sec(m.totalMs)}
          {m.loadMs > 500 && ` (+ загрузка модели ${sec(m.loadMs)})`} · промпт: прочитано {m.promptTokens} ток. за {sec(m.promptMs)} · ответ: {m.outputTokens} ток.,{' '}
          {(m.outputTokens / Math.max(0.001, m.outputMs / 1000)).toFixed(1)} ток/с · остановка: {m.doneReason === 'length' ? 'лимит max tokens' : 'модель закончила'} · в памяти{' '}
          {gib(m.memoryBytes)}, окно {m.contextLength}
        </p>
      )}
    </div>
  );
}

export default function OrderExtractPage() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chat, setChat] = useState<Chat | null>(null);
  const [newConfig, setNewConfig] = useState('q4-default');
  const [text, setText] = useState('');
  const [date, setDate] = useState('2026-10-08');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  const refreshList = useCallback(async () => setChats(await api<ChatSummary[]>('/chats')), []);

  useEffect(() => {
    api<Meta>('/meta').then(setMeta).catch((e) => setError((e as Error).message));
    refreshList().catch((e) => setError((e as Error).message));
  }, [refreshList]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chat?.messages.length, sending]);

  async function open(id: string) {
    setError(null);
    setChat(await api<Chat>(`/chats/${id}`));
  }

  async function createChat() {
    setError(null);
    const created = await api<Chat>('/chats', { method: 'POST', body: JSON.stringify({ configId: newConfig }) });
    setChat(created);
    refreshList();
  }

  async function deleteChat(id: string) {
    await api(`/chats/${id}`, { method: 'DELETE' });
    if (chat?.id === id) setChat(null);
    refreshList();
  }

  function pickExample(id: string) {
    const e = meta?.examples.find((x) => x.id === id);
    if (!e) return;
    setText(e.text);
    setDate(e.date);
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!chat || !text.trim() || sending) return;
    setSending(true);
    setError(null);
    const now = new Date().toISOString();
    setChat({ ...chat, messages: [...chat.messages, { role: 'user', content: text, date, createdAt: now }] });
    try {
      setChat(await api<Chat>(`/chats/${chat.id}/messages`, { method: 'POST', body: JSON.stringify({ text, date }) }));
      refreshList();
    } catch (e) {
      setError((e as Error).message);
      setChat(chat);
    } finally {
      setSending(false);
    }
  }

  const exampleOf = (m: Message) => meta?.examples.find((e) => e.id === m.exampleId);
  const userBefore = (i: number) => chat?.messages[i - 1];

  return (
    <main className="flex h-screen gap-4 overflow-hidden bg-paper p-4 text-sm text-ink">
      <aside className="flex w-64 shrink-0 flex-col gap-2">
        <div className="flex flex-col gap-1 rounded-md border border-black/10 bg-white p-2">
          <span className="text-[11px] text-[#5c5c5c]">Настройки нового чата</span>
          <select value={newConfig} onChange={(e) => setNewConfig(e.target.value)} className="rounded border border-black/15 px-1.5 py-1 text-[12px]">
            {meta?.configs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          <button type="button" onClick={createChat} disabled={!meta} className="rounded-md bg-pine px-3 py-1.5 text-white disabled:opacity-40">
            + Новый чат
          </button>
        </div>
        <div className="flex flex-1 flex-col gap-1 overflow-y-auto">
          {chats.map((c, i) => (
            <div
              key={c.id}
              onClick={() => open(c.id)}
              className={`group cursor-pointer rounded-md border px-2 py-1.5 ${c.id === chat?.id ? 'border-pine bg-white' : 'border-black/10 bg-white/50 hover:bg-white'}`}
            >
              <div className="flex items-start justify-between gap-1">
                <span className="line-clamp-2 font-medium">
                  {i + 1}. {c.title}
                </span>
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
              <p className="text-[11px] text-[#5c5c5c]">
                {c.quant} · {c.messages / 2} писем
              </p>
            </div>
          ))}
        </div>
        <Link href="/chat" className="text-[12px] text-pine underline">
          Основной чат →
        </Link>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-col gap-1">
          <h1 className="truncate text-xl font-medium">{chat?.title ?? 'Письмо клиента → заказ в JSON'}</h1>
          {chat && meta && <ParamChips chat={chat} opt={meta.opt} />}
          <p className="text-[11px] text-[#5c5c5c]">
            Локальная qwen2.5:7b в Ollama. Системный промпт с каталогом и правилами одинаков во всех чатах — отличаются только квантование и параметры. Каждое письмо разбирается
            отдельно, история чата модели не передаётся.{' '}
            <button type="button" onClick={() => setPromptOpen(!promptOpen)} className="text-pine underline">
              {promptOpen ? 'скрыть промпт' : 'показать промпт'}
            </button>
          </p>
          {promptOpen && meta && <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded border border-black/10 bg-white p-2 text-[11px]">{meta.systemPrompt}</pre>}
        </div>
        {error && <div className="rounded-md border border-red-300 bg-red-50 px-3 py-1 text-red-700">{error}</div>}
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto rounded-lg border border-black/10 bg-white p-3">
          {!chat ? (
            <p className="text-[#5c5c5c]">Выберите настройки слева и создайте чат — по одному на каждый вариант, затем отправьте в каждый одно и то же письмо.</p>
          ) : !chat.messages.length ? (
            <p className="text-[#5c5c5c]">Вставьте письмо клиента или выберите контрольное письмо ниже.</p>
          ) : (
            chat.messages.map((m, i) => (
              <div key={i} className={m.role === 'user' ? 'max-w-[80%] self-end' : 'w-[92%] self-start'}>
                <span className="mb-0.5 block text-[11px] text-pine">{m.role === 'user' ? 'Письмо клиента' : 'Модель'}</span>
                <div className={`rounded-lg px-3 py-2 ${m.role === 'user' ? 'bg-pine/10' : 'bg-paper'}`}>
                  {m.role === 'user' ? <UserMessage message={m} example={exampleOf(m)} /> : <AssistantMessage message={m} example={exampleOf(userBefore(i) ?? m)} />}
                </div>
              </div>
            ))
          )}
          {sending && <p className="text-[#5c5c5c]">Модель разбирает письмо… длинное письмо читается ≈ 25–30 с.</p>}
          <div ref={bottom} />
        </div>
        <form onSubmit={send} className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <select value="" onChange={(e) => pickExample(e.target.value)} disabled={!chat || sending} className="max-w-full rounded border border-black/15 px-1.5 py-1">
              <option value="">Контрольное письмо…</option>
              {meta?.examples.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.id} — {e.about}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1">
              дата письма
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="rounded border border-black/15 px-1.5 py-0.5" />
            </label>
          </div>
          <div className="flex gap-2">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={chat ? 'Текст письма клиента…' : 'Сначала создайте чат'}
              disabled={!chat || sending}
              rows={3}
              className="min-w-0 flex-1 rounded-md border border-black/15 px-3 py-2"
            />
            <button type="submit" disabled={!chat || sending || !text.trim()} className="self-end rounded-md bg-pine px-4 py-2 text-white disabled:opacity-40">
              Отправить
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}
