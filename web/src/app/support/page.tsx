'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { MODELS } from '@/app/models';
import { Markdown } from '@/components/ReviewMarkdown';

// Day 33: support assistant for Advent LLM. Pick a ticket from the CRM (MCP),
// ask the user's question; the answer is built from the ticket and the user's
// CRM data (plan, keys per device, gateway events) plus the FAQ (RAG). An
// answer can be sent to the user — written into the ticket through the CRM.

type TicketSummary = { id: string; subject: string; status: string; priority: string; channel: string; created_at: string; user_id: string; user_name?: string; messages: number };
type Message = { from: 'user' | 'agent' | 'assistant'; at: string; text: string };
type Ticket = TicketSummary & { messages: Message[]; internal_notes: string[] };
type Device = { client: string; device: string; key_last4: string; key_status: 'active' | 'revoked' | 'disabled'; key_issued_at: string; key_revoked_at?: string; disabled_reason?: string; last_ok_at?: string };
type User = { id: string; name: string; email: string; company: string | null; plan: string; subscription: Record<string, string>; devices: Device[] };
type Plan = { name: string; devices: number; rate_limit_per_minute: number; term: string };
type UserSummary = { id: string; name: string; email: string; plan_name?: string; subscription: string };
type Source = { n: number; file: string; section: string; score: number; cited: boolean; text: string };
type ToolCall = { name: string; tool?: string; arguments: Record<string, unknown>; result: string; isError: boolean; durationMs: number };
type Reply = {
  answer: string;
  escalate?: { needed: boolean; reason: string };
  ticketId?: string;
  userId?: string;
  context: { user?: string; ticket?: string; otherTickets?: string; events?: string; error?: string };
  sources: Source[];
  toolCalls?: ToolCall[];
  model?: string;
  usage?: { totalTokens: number };
  durationMs: number;
};
type Turn = { question: string; reply?: Reply; error?: string; sent?: boolean };

const STATUS: Record<string, string> = { open: 'открыт', pending: 'ждём пользователя', resolved: 'решён' };
const KEY: Record<Device['key_status'], { label: string; cls: string }> = {
  active: { label: 'активен', cls: 'bg-pine/10 text-pine' },
  revoked: { label: 'отозван', cls: 'bg-red-50 text-red-700' },
  disabled: { label: 'отключён', cls: 'bg-amber-50 text-amber-700' },
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/backend/support${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message ?? `HTTP ${response.status}`);
  return data as T;
}

/** Typical requests, to simulate a new one in a click. */
const TEMPLATES = [
  'Почему не работает авторизация?',
  'Ответ модели обрывается на полуслове, это баг?',
  'Приложение пишет «Сервер занят — очередь заполнена». Что делать?',
  'Кажется, мой ключ украли — коллега видел его в переписке. Что делать?',
  'Хочу подключить ещё один iPhone. Это возможно на моём тарифе?',
];

const fmt = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export default function SupportPage() {
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ ticket: Ticket; user: User; plan: Plan } | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState<string>(MODELS[0].value);
  const [creating, setCreating] = useState(false);

  const loadTickets = useCallback(() => {
    api<{ tickets: TicketSummary[] }>('/tickets')
      .then((r) => {
        // Newest first, so a just-created request is at the top.
        // (Dates come with different offsets — seed "+03:00", new ones "Z" — so compare as times.)
        setTickets([...r.tickets].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)));
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const loadDetail = useCallback((id: string) => {
    api<{ ticket: Ticket; user: User; plan: Plan }>(`/tickets/${id}`)
      .then(setDetail)
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(loadTickets, [loadTickets]);

  function open(id: string) {
    setSelected(id);
    setTurns([]);
    setDetail(null);
    loadDetail(id);
    setInput('');
  }

  // The ticket's own question is the natural first thing to ask.
  useEffect(() => {
    if (detail && !input && turns.length === 0) {
      const last = [...detail.ticket.messages].reverse().find((m) => m.from === 'user');
      if (last) setInput(last.text);
    }
    // Only when a ticket is loaded, not on every edit of the input.
  }, [detail?.ticket.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function ask(e: FormEvent) {
    e.preventDefault();
    const question = input.trim();
    if (!question || busy || !selected) return;
    const history = turns.flatMap((t) =>
      t.reply ? [{ role: 'user' as const, content: t.question }, { role: 'assistant' as const, content: t.reply.answer }] : [],
    );
    setTurns((prev) => [...prev, { question }]);
    setInput('');
    setBusy(true);
    try {
      const reply = await api<Reply>('/ask', { method: 'POST', body: JSON.stringify({ message: question, ticketId: selected, history, model }) });
      setTurns((prev) => prev.map((t, i) => (i === prev.length - 1 ? { ...t, reply } : t)));
    } catch (err) {
      setTurns((prev) => prev.map((t, i) => (i === prev.length - 1 ? { ...t, error: (err as Error).message } : t)));
    } finally {
      setBusy(false);
    }
  }

  async function send(index: number, text: string, escalate: boolean) {
    if (!selected) return;
    try {
      await api(`/tickets/${selected}/reply`, { method: 'POST', body: JSON.stringify({ text, status: escalate ? 'open' : 'pending' }) });
      setTurns((prev) => prev.map((t, i) => (i === index ? { ...t, sent: true } : t)));
      loadDetail(selected);
      loadTickets();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function created(id: string) {
    setCreating(false);
    loadTickets();
    open(id);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-7xl gap-4 bg-paper p-4 text-ink max-lg:flex-col lg:h-screen">
      <aside className="flex w-72 shrink-0 flex-col gap-2 overflow-y-auto max-lg:w-full">
        <Link href="/" className="text-sm text-pine underline">
          ← на главную
        </Link>
        <h1 className="text-xl font-medium">Поддержка Advent LLM</h1>
        <p className="text-xs text-[#5c5c5c]">Тикеты из CRM (MCP). Ответ строится по данным пользователя и тикета + FAQ (RAG).</p>
        {error && <p className="rounded bg-red-50 p-2 text-xs text-red-700">{error}</p>}
        {creating ? (
          <NewTicketForm onCreated={created} onCancel={() => setCreating(false)} onError={setError} />
        ) : (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-lg border border-dashed border-pine/50 px-3 py-2 text-sm text-pine hover:bg-pine/5"
            title="Имитировать новое обращение пользователя — тикет создаётся в CRM через MCP crm_create_ticket"
          >
            + Новое обращение
          </button>
        )}
        <ul className="space-y-1">
          {tickets.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => open(t.id)}
                className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${selected === t.id ? 'border-pine bg-white' : 'border-black/10 bg-white/60 hover:bg-white'}`}
              >
                <div className="flex items-center justify-between gap-2 text-xs text-[#5c5c5c]">
                  <span className="font-mono">{t.id}</span>
                  <span className={t.status === 'resolved' ? '' : t.status === 'open' ? 'text-amber-700' : 'text-pine'}>{STATUS[t.status] ?? t.status}</span>
                </div>
                <div className="font-medium">{t.subject}</div>
                <div className="text-xs text-[#5c5c5c]">
                  {t.user_name} · {fmt(t.created_at)}
                  {t.priority === 'high' && <span className="ml-1 text-red-700">· высокий</span>}
                </div>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col max-lg:h-[85vh]">
        {!detail ? (
          <div className="flex flex-1 items-center justify-center rounded-lg border border-black/10 bg-white text-sm text-[#5c5c5c]">
            {selected ? 'Загружаю тикет…' : 'Выберите тикет слева'}
          </div>
        ) : (
          <>
            <header className="mb-2">
              <div className="text-xs text-[#5c5c5c]">
                <span className="font-mono">{detail.ticket.id}</span> · {STATUS[detail.ticket.status] ?? detail.ticket.status} · {detail.ticket.channel}
              </div>
              <h2 className="text-lg font-medium">{detail.ticket.subject}</h2>
            </header>
            <div className="flex-1 space-y-3 overflow-y-auto rounded-lg border border-black/10 bg-white p-3">
              {detail.ticket.messages.map((m, i) => (
                <div key={i} className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${m.from === 'user' ? 'bg-black/5' : 'ml-auto bg-pine/10'}`}>
                  <div className="mb-0.5 text-[11px] text-[#5c5c5c]">
                    {m.from === 'user' ? detail.user.name : m.from === 'agent' ? 'Сотрудник' : 'Ассистент'} · {fmt(m.at)}
                  </div>
                  {m.from === 'assistant' ? <Markdown text={m.text} /> : <p className="whitespace-pre-wrap">{m.text}</p>}
                </div>
              ))}
              {turns.length > 0 && <div className="border-t border-dashed border-black/10 pt-2 text-center text-[11px] text-[#5c5c5c]">черновики ассистента — пользователь их ещё не видит</div>}
              {turns.map((t, i) => (
                <div key={i} className="space-y-2">
                  <div className="w-fit max-w-[85%] rounded-lg bg-black/5 px-3 py-2 text-sm">
                    <div className="mb-0.5 text-[11px] text-[#5c5c5c]">Вопрос</div>
                    {t.question}
                  </div>
                  {t.error && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{t.error}</p>}
                  {t.reply && <AnswerCard reply={t.reply} sent={!!t.sent} onSend={(text) => send(i, text, !!t.reply?.escalate?.needed)} />}
                </div>
              ))}
              {busy && <p className="text-sm text-[#5c5c5c]">Смотрю тикет, данные пользователя в CRM и FAQ…</p>}
            </div>
            <form onSubmit={ask} className="mt-2 flex gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                rows={2}
                placeholder="Почему не работает авторизация?"
                className="min-w-0 flex-1 rounded-lg border border-black/10 bg-white px-3 py-2 text-sm"
              />
              <div className="flex flex-col gap-1">
                <select value={model} onChange={(e) => setModel(e.target.value)} className="max-w-[10rem] rounded border border-black/10 p-1 text-xs">
                  {MODELS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <button type="submit" disabled={busy || !input.trim()} className="rounded-lg bg-pine px-4 py-2 text-sm text-white disabled:opacity-50">
                  Спросить
                </button>
              </div>
            </form>
          </>
        )}
      </section>

      {detail && (
        <aside className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto text-xs max-lg:w-full">
          <UserCard user={detail.user} plan={detail.plan} />
          {detail.ticket.internal_notes.length > 0 && (
            <section className="rounded-lg border border-amber-200 bg-amber-50 p-3">
              <h3 className="mb-1 font-medium text-amber-800">Внутренние заметки</h3>
              <ul className="list-disc pl-4 text-amber-900">
                {detail.ticket.internal_notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
              <p className="mt-1 text-[11px] text-amber-700">Ассистент учитывает их, но не пересказывает пользователю.</p>
            </section>
          )}
          {(() => {
            const last = [...turns].reverse().find((t) => t.reply)?.reply;
            return last?.context.events ? (
              <section className="rounded-lg border border-black/10 bg-white p-3">
                <h3 className="mb-1 font-medium text-pine">События шлюза (MCP crm)</h3>
                <pre className="whitespace-pre-wrap font-mono text-[10.5px] leading-snug">{last.context.events}</pre>
              </section>
            ) : null;
          })()}
        </aside>
      )}
    </main>
  );
}

function UserCard({ user, plan }: { user: User; plan: Plan }) {
  return (
    <section className="rounded-lg border border-black/10 bg-white p-3">
      <h3 className="text-sm font-medium">{user.name}</h3>
      <p className="text-[#5c5c5c]">
        {user.email}
        {user.company ? ` · ${user.company}` : ''}
      </p>
      <p className="mt-2">
        Тариф <b>{plan?.name ?? user.plan}</b>: до {plan?.devices} устройств, {plan?.rate_limit_per_minute} запросов/мин
      </p>
      <p>
        Подписка:{' '}
        <span className={user.subscription.status === 'active' ? 'text-pine' : 'text-red-700'}>{user.subscription.status}</span>
        {user.subscription.paid_until && ` до ${user.subscription.paid_until}`}
        {user.subscription.trial_ends && `, пробный до ${user.subscription.trial_ends}`}
      </p>
      <h4 className="mb-1 mt-2 font-medium">Устройства и ключи</h4>
      <ul className="space-y-1.5">
        {user.devices.map((d) => (
          <li key={d.client} className="rounded border border-black/5 p-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono">{d.client}</span>
              <span className={`rounded px-1.5 ${KEY[d.key_status].cls}`}>
                …{d.key_last4} {KEY[d.key_status].label}
              </span>
            </div>
            <div className="text-[#5c5c5c]">
              {d.device}
              {d.key_revoked_at && ` · отозван ${d.key_revoked_at}`}
              {d.disabled_reason && ` · ${d.disabled_reason}`}
            </div>
            <div className="text-[#5c5c5c]">последний успешный запрос: {d.last_ok_at ? fmt(d.last_ok_at) : '—'}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AnswerCard({ reply, sent, onSend }: { reply: Reply; sent: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState(reply.answer);
  const [editing, setEditing] = useState(false);
  return (
    <div className="ml-auto max-w-[92%] rounded-lg border border-pine/30 bg-pine/5 px-3 py-2 text-sm">
      <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-[#5c5c5c]">
        <span>Ассистент · черновик ответа</span>
        {reply.escalate && (
          <span className={`rounded px-1.5 ${reply.escalate.needed ? 'bg-amber-100 text-amber-800' : 'bg-pine/10 text-pine'}`}>
            {reply.escalate.needed ? `→ сотруднику: ${reply.escalate.reason || 'нужен человек'}` : 'сотрудник не нужен'}
          </span>
        )}
      </div>
      {editing ? (
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={10} className="w-full rounded border border-black/10 p-2 text-sm" />
      ) : (
        <Markdown text={text} />
      )}
      {reply.context.error && <p className="mt-1 text-xs text-red-700">CRM: {reply.context.error}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={sent}
          onClick={() => onSend(text)}
          className="rounded bg-pine px-3 py-1 text-xs text-white disabled:opacity-50"
          title="Записать ответ в тикет через MCP crm_add_ticket_reply"
        >
          {sent ? 'Отправлено в тикет ✓' : 'Отправить в тикет'}
        </button>
        {!sent && (
          <button type="button" onClick={() => setEditing((v) => !v)} className="text-xs text-[#5c5c5c] underline">
            {editing ? 'готово' : 'править'}
          </button>
        )}
      </div>
      <details className="mt-2 text-xs">
        <summary className="cursor-pointer text-[#5c5c5c]">
          FAQ и документация (RAG): {reply.sources.filter((s) => s.cited).length} использовано из {reply.sources.length}
        </summary>
        <ul className="mt-1 space-y-1">
          {reply.sources.map((s) => (
            <li key={s.n} className={s.cited ? '' : 'opacity-60'}>
              <details>
                <summary className="cursor-pointer">
                  {s.cited ? '●' : '○'} [{s.n}] <span className="font-mono">{s.file}</span> › {s.section.split(' › ').slice(-1)[0]}
                </summary>
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-white p-2 text-[11px]">{s.text}</pre>
              </details>
            </li>
          ))}
        </ul>
      </details>
      <details className="mt-1 text-xs">
        <summary className="cursor-pointer text-[#5c5c5c]">Данные CRM, с которыми отвечал ассистент</summary>
        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-white p-2 text-[11px]">
          {[reply.context.user, reply.context.ticket, reply.context.otherTickets && `Другие тикеты:\n${reply.context.otherTickets}`].filter(Boolean).join('\n\n')}
        </pre>
      </details>
      {reply.toolCalls && reply.toolCalls.length > 0 && (
        <details className="mt-1 text-xs">
          <summary className="cursor-pointer text-[#5c5c5c]">Модель сама запросила в CRM: {reply.toolCalls.length}</summary>
          <ul className="mt-1 space-y-1 font-mono">
            {reply.toolCalls.map((c, i) => (
              <li key={i}>
                ⚙ {c.tool ?? c.name}({JSON.stringify(c.arguments)})
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="mt-1 text-[11px] text-[#5c5c5c]">
        {reply.model} · {(reply.durationMs / 1000).toFixed(1)} с{reply.usage ? ` · ${reply.usage.totalTokens} токенов` : ''}
      </p>
    </div>
  );
}

function NewTicketForm({ onCreated, onCancel, onError }: { onCreated: (id: string) => void; onCancel: () => void; onError: (e: string) => void }) {
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [userId, setUserId] = useState('');
  const [text, setText] = useState('');
  const [subject, setSubject] = useState('');
  const [channel, setChannel] = useState('app');
  const [high, setHigh] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ users: UserSummary[] }>('/users')
      .then((r) => {
        setUsers(r.users);
        setUserId((prev) => prev || r.users[0]?.id || '');
      })
      .catch((e: Error) => onError(e.message));
  }, [onError]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!userId || !text.trim() || busy) return;
    setBusy(true);
    try {
      const ticket = await api<{ id: string }>('/tickets', {
        method: 'POST',
        body: JSON.stringify({ userId, text: text.trim(), subject: subject.trim() || undefined, channel, priority: high ? 'high' : 'normal' }),
      });
      onCreated(ticket.id);
    } catch (err) {
      onError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded-lg border border-pine/40 bg-white p-3 text-xs">
      <div className="text-sm font-medium">Новое обращение</div>
      <label className="block">
        От кого
        <select value={userId} onChange={(e) => setUserId(e.target.value)} className="mt-0.5 w-full rounded border border-black/10 p-1">
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name} — {u.plan_name}
              {u.subscription !== 'active' ? ` (${u.subscription})` : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        Сообщение
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          placeholder="Почему не работает авторизация?"
          className="mt-0.5 w-full rounded border border-black/10 p-1 text-sm"
          autoFocus
        />
      </label>
      <div className="flex flex-wrap gap-1">
        {TEMPLATES.map((t) => (
          <button key={t} type="button" onClick={() => setText(t)} className="rounded-full border border-black/10 px-2 py-0.5 text-[11px] hover:bg-black/5" title={t}>
            {t.length > 32 ? `${t.slice(0, 30)}…` : t}
          </button>
        ))}
      </div>
      <label className="block">
        Тема <span className="text-[#5c5c5c]">— необязательно, по умолчанию первая фраза</span>
        <input value={subject} onChange={(e) => setSubject(e.target.value)} className="mt-0.5 w-full rounded border border-black/10 p-1" />
      </label>
      <div className="flex items-center gap-3">
        <select value={channel} onChange={(e) => setChannel(e.target.value)} className="rounded border border-black/10 p-1">
          <option value="app">из приложения</option>
          <option value="email">email</option>
          <option value="chat">чат</option>
        </select>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={high} onChange={(e) => setHigh(e.target.checked)} /> высокий приоритет
        </label>
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={busy || !userId || !text.trim()} className="rounded bg-pine px-3 py-1 text-white disabled:opacity-50">
          {busy ? 'Создаю…' : 'Создать тикет'}
        </button>
        <button type="button" onClick={onCancel} className="text-[#5c5c5c] underline">
          отмена
        </button>
      </div>
    </form>
  );
}
