'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { MODELS } from '@/app/models';
import { ReviewMarkdown } from '@/components/ReviewMarkdown';

// Day 31: developer assistant — /help answers questions about this project
// from its documentation (RAG over README, docs/, the API and data schemas)
// and its live state (git through the MCP server): current branch, files,
// diff. The dialog lives on the page; the backend is stateless.

type Branch = { branch: string; detached: boolean; head: { sha: string; subject: string; date: string }; upstream?: string; ahead: number; behind: number };
type Source = { n: number; file: string; section: string; score: number; cited: boolean; text: string };
type ToolCall = { round: number; name: string; tool?: string; arguments: Record<string, unknown>; result: string; isError: boolean; durationMs: number };

type Reply = {
  command: string;
  question?: string;
  answer: string;
  branch?: Branch;
  gitError?: string;
  sources?: Source[];
  toolCalls?: ToolCall[];
  model?: string;
  usage?: { totalTokens: number };
  durationMs: number;
};

type Status = {
  branch?: Branch;
  gitError?: string;
  mcpUrl: string;
  mcpTools: string[];
  docs: { builtAt: string; embeddingModel: string; chunks: number; files: { path: string; group: string; chunks: number }[] };
  commands: { name: string; args?: string; description: string }[];
};

type Entry = { role: 'user'; content: string } | { role: 'assistant'; reply: Reply } | { role: 'error'; content: string };

const EXAMPLES = [
  '/help',
  '/help как запустить проект локально и какие порты занимает каждая часть?',
  '/help какие эндпоинты у rag-chat и где лежит их код?',
  '/help что изменено в текущей ветке и зачем?',
  '/branch',
  '/files backend/src',
  '/review main',
];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/backend/dev-assistant${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message ?? `HTTP ${response.status}`);
  return data as T;
}

export default function DevAssistantPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState<string>(MODELS[0].value);
  const bottom = useRef<HTMLDivElement>(null);

  const loadStatus = useCallback(() => {
    api<Status>('')
      .then((s) => {
        setStatus(s);
        setStatusError(null);
      })
      .catch((e: Error) => setStatusError(e.message));
  }, []);

  useEffect(loadStatus, [loadStatus]);
  // Keep the branch badge fresh while the page is open.
  useEffect(() => {
    setInterval(loadStatus, 5000);
  }, [loadStatus]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries, busy]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    // Only /help turns are a dialog; git shortcuts would just be noise for the model.
    const history = entries.flatMap((e) =>
      e.role === 'assistant' && e.reply.command === '/help'
        ? [
            { role: 'user' as const, content: e.reply.question ?? '' },
            { role: 'assistant' as const, content: e.reply.answer },
          ]
        : [],
    );
    setEntries((prev) => [...prev, { role: 'user', content: message }]);
    setInput('');
    setBusy(true);
    try {
      const reply = await api<Reply>('/ask', { method: 'POST', body: JSON.stringify({ message, history, model }) });
      setEntries((prev) => [...prev, { role: 'assistant', reply }]);
      if (reply.branch) setStatus((s) => (s ? { ...s, branch: reply.branch, gitError: undefined } : s));
      if (reply.command === '/reindex') loadStatus();
    } catch (e) {
      setEntries((prev) => [...prev, { role: 'error', content: (e as Error).message }]);
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send(input);
  }

  const commandHints = input.startsWith('/') && !input.includes(' ') ? (status?.commands ?? []).filter((c) => c.name.startsWith(input)) : [];

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl gap-4 bg-paper p-4 text-ink max-md:flex-col md:h-screen">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col max-md:h-[80vh]">
        <header className="mb-3 flex flex-wrap items-center gap-3">
          <Link href="/" className="text-sm text-pine underline">
            ← на главную
          </Link>
          <h1 className="text-xl font-medium">Ассистент разработчика</h1>
          <BranchBadge branch={status?.branch} error={status?.gitError ?? statusError ?? undefined} />
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto rounded-lg border border-black/10 bg-white p-3">
          {entries.length === 0 && (
            <div className="text-sm text-[#5c5c5c]">
              <p className="mb-2">
                Спросите о проекте командой <code className="rounded bg-black/5 px-1">/help &lt;вопрос&gt;</code>. Ответ строится по
                документации проекта (RAG) и его текущему состоянию в git (MCP). Попробуйте:
              </p>
              <div className="flex flex-wrap gap-2">
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    type="button"
                    onClick={() => void send(ex)}
                    className="rounded-full border border-pine/30 px-3 py-1 text-xs text-pine hover:bg-pine/5"
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          )}
          {entries.map((entry, i) =>
            entry.role === 'user' ? (
              <div key={i} className="ml-auto w-fit max-w-[85%] rounded-lg bg-pine px-3 py-2 font-mono text-sm text-white">
                {entry.content}
              </div>
            ) : entry.role === 'error' ? (
              <div key={i} className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {entry.content}
              </div>
            ) : (
              <AssistantReply key={i} reply={entry.reply} />
            ),
          )}
          {busy && <p className="text-sm text-[#5c5c5c]">{entries[entries.length - 1]?.role === 'user' && (entries[entries.length - 1] as { content: string }).content.startsWith('/review') ? 'Читаю diff, подбираю контекст из документации и кода, ревьюю… (обычно 30–90 с)' : 'Смотрю документацию и репозиторий…'}</p>}
          <div ref={bottom} />
        </div>

        <form onSubmit={onSubmit} className="relative mt-3 flex gap-2">
          {commandHints.length > 0 && (
            <ul className="absolute bottom-full mb-1 w-full rounded-lg border border-black/10 bg-white p-1 text-sm shadow">
              {commandHints.map((c) => (
                <li key={c.name}>
                  <button
                    type="button"
                    onClick={() => setInput(`${c.name} `)}
                    className="w-full rounded px-2 py-1 text-left hover:bg-black/5"
                  >
                    <span className="font-mono text-pine">
                      {c.name}
                      {c.args ? ` ${c.args}` : ''}
                    </span>{' '}
                    <span className="text-[#5c5c5c]">— {c.description}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="/help где лежит RAG-пайплайн?"
            className="min-w-0 flex-1 rounded-lg border border-black/10 bg-white px-3 py-2 font-mono text-sm"
            autoFocus
          />
          <button type="submit" disabled={busy || !input.trim()} className="rounded-lg bg-pine px-4 py-2 text-sm text-white disabled:opacity-50">
            Отправить
          </button>
        </form>
      </section>

      <aside className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto text-xs max-md:w-full">
        <section className="rounded-lg border border-black/10 bg-white p-3">
          <h2 className="mb-2 text-sm font-medium text-pine">Модель</h2>
          <select value={model} onChange={(e) => setModel(e.target.value)} className="w-full rounded border border-black/10 p-1">
            {MODELS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </section>
        <section className="rounded-lg border border-black/10 bg-white p-3">
          <h2 className="mb-2 text-sm font-medium text-pine">MCP: git</h2>
          {status ? (
            <>
              <p className="font-mono text-[#5c5c5c]">{status.mcpUrl}</p>
              <p className="mt-1">{status.mcpTools.length ? status.mcpTools.join(', ') : 'нет подключения'}</p>
            </>
          ) : (
            <p className="text-[#5c5c5c]">{statusError ?? 'загрузка…'}</p>
          )}
        </section>
        <section className="rounded-lg border border-black/10 bg-white p-3">
          <h2 className="mb-2 flex items-center justify-between text-sm font-medium text-pine">
            RAG: документация
            <button type="button" onClick={() => void send('/reindex')} className="text-xs font-normal text-[#5c5c5c] underline">
              переиндексировать
            </button>
          </h2>
          {status ? (
            <>
              <p className="mb-1 text-[#5c5c5c]">
                {status.docs.files.length} файлов, {status.docs.chunks} чанков · {status.docs.embeddingModel}
              </p>
              <ul className="max-h-80 space-y-0.5 overflow-y-auto">
                {status.docs.files.map((f) => (
                  <li key={f.path} className="flex justify-between gap-2">
                    <span className="truncate font-mono" title={f.path}>
                      {f.path}
                    </span>
                    <span className="shrink-0 text-[#5c5c5c]">{f.chunks}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-[#5c5c5c]">загрузка…</p>
          )}
        </section>
        {status && (
          <section className="rounded-lg border border-black/10 bg-white p-3">
            <h2 className="mb-2 text-sm font-medium text-pine">Команды</h2>
            <ul className="space-y-1">
              {status.commands.map((c) => (
                <li key={c.name}>
                  <span className="font-mono text-pine">
                    {c.name}
                    {c.args ? ` ${c.args}` : ''}
                  </span>{' '}
                  — {c.description}
                </li>
              ))}
            </ul>
          </section>
        )}
      </aside>
    </main>
  );
}

function BranchBadge({ branch, error }: { branch?: Branch; error?: string }) {
  if (error) return <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700" title={error}>git недоступен</span>;
  if (!branch) return null;
  return (
    <span className="rounded-full bg-pine/10 px-2 py-0.5 font-mono text-xs text-pine" title={`HEAD ${branch.head.sha} «${branch.head.subject}»`}>
      ⎇ {branch.detached ? 'detached HEAD' : branch.branch} · {branch.head.sha}
    </span>
  );
}

function AssistantReply({ reply }: { reply: Reply }) {
  return (
    <div className="max-w-[95%] rounded-lg border border-black/10 bg-paper px-3 py-2 text-sm">
      {reply.command === '/review' ? <ReviewMarkdown text={reply.answer} /> : <p className="whitespace-pre-wrap">{reply.answer}</p>}
      {reply.gitError && <p className="mt-1 text-xs text-amber-700">git: {reply.gitError}</p>}
      {reply.sources && reply.sources.length > 0 && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-[#5c5c5c]">
            Источники RAG: {reply.sources.filter((s) => s.cited).length} процитировано из {reply.sources.length}
          </summary>
          <ul className="mt-1 space-y-1">
            {reply.sources.map((s) => (
              <li key={s.n} className={s.cited ? '' : 'opacity-60'}>
                <details>
                  <summary className="cursor-pointer">
                    {s.cited ? '●' : '○'} [{s.n}] <span className="font-mono">{s.file}</span>
                    {s.section && <span className="text-[#5c5c5c]"> › {s.section.split(' › ').slice(-2).join(' › ')}</span>}{' '}
                    <span className="text-[#5c5c5c]">cos {s.score.toFixed(3)}</span>
                  </summary>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-white p-2 text-[11px]">{s.text}</pre>
                </details>
              </li>
            ))}
          </ul>
        </details>
      )}
      {reply.toolCalls && reply.toolCalls.length > 0 && (
        <details className="mt-1 text-xs">
          <summary className="cursor-pointer text-[#5c5c5c]">Вызовы MCP git: {reply.toolCalls.length}</summary>
          <ul className="mt-1 space-y-1">
            {reply.toolCalls.map((c, i) => (
              <li key={i}>
                <details>
                  <summary className={`cursor-pointer font-mono ${c.isError ? 'text-red-600' : ''}`}>
                    ⚙ {c.tool ?? c.name}({JSON.stringify(c.arguments)}) · {c.durationMs} мс
                  </summary>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-white p-2 text-[11px]">{c.result}</pre>
                </details>
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="mt-1 text-[11px] text-[#5c5c5c]">
        {reply.command} · {reply.model ?? 'без LLM'} · {(reply.durationMs / 1000).toFixed(1)} с
        {reply.usage ? ` · ${reply.usage.totalTokens} токенов` : ''}
      </p>
    </div>
  );
}
