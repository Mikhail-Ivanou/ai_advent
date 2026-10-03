'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';

// Day 21: document indexing — add documents by URL or file, chunk them with
// two strategies, embed locally, inspect chunks and compare the strategies.

type Strategy = 'fixed' | 'structural';
const STRATEGIES: Strategy[] = ['fixed', 'structural'];
const STRATEGY_LABELS: Record<Strategy, string> = {
  fixed: 'Фиксированный размер',
  structural: 'По структуре',
};

type Params = {
  fixed: { size: number; overlap: number };
  structural: { maxSize: number; minSize: number };
};

type RagDocument = {
  id: string;
  source: string;
  title: string;
  file: string;
  kind: string;
  chars: number;
  sections: number;
  indexedAt: string;
  chunks: Record<Strategy, number>;
};

type Status = { busy: boolean; phase?: string; done?: number; total?: number; error?: string };

type ChunkMetadata = {
  chunk_id: string;
  source: string;
  title: string;
  file: string;
  section: string;
  strategy: Strategy;
  index: number;
  start: number;
  end: number;
  sectionsSpanned: number;
  part?: string;
};

type Chunk = { metadata: ChunkMetadata; text: string; tokens: number };
type SearchHit = { score: number; lexical?: number; metadata: ChunkMetadata; text: string };
type SearchMode = 'hybrid' | 'vector';
const SEARCH_LABELS: Record<SearchMode, string> = { hybrid: 'гибридный (векторы + BM25)', vector: 'только векторы' };

type RankedHit = SearchHit & { firstRank: number; rerankScore?: number };
type Rerank = 'none' | 'cross-encoder' | 'llm';
// Thresholds calibrated on the indexed book (Day 23): the scale depends on the reranker.
const RERANK_THRESHOLDS: Record<Rerank, number> = { none: 0, 'cross-encoder': 0.2, llm: 0.6 };
const RERANK_LABELS: Record<Rerank, string> = { 'cross-encoder': 'cross-encoder (локально)', llm: 'LLM', none: 'нет' };

type RagAnswer = {
  mode: 'rag' | 'plain';
  answer: string;
  model: string;
  hits: RankedHit[];
  pipeline?: {
    rewritten?: string;
    candidates: RankedHit[];
    filteredOut: number;
    timings: { rewriteMs: number; searchMs: number; rerankMs: number };
  };
  usage?: { totalTokens: number };
  costByn?: number;
  durationMs: number;
};

type StrategyStats = {
  strategy: Strategy;
  params: Record<string, number>;
  documents: number;
  chunks: number;
  chars: { avg: number; median: number; min: number; max: number; stdDev: number };
  tokens: { avg: number; max: number };
  truncatedShare: number;
  crossSectionShare: number;
  brokenEndShare: number;
  redundancy: number;
  tinyShare: number;
  embedMs: number;
  indexBytes: number;
};

type RetrievalEval = {
  kind: 'sentence' | 'heading';
  strategy: Strategy;
  queries: number;
  hitAt1: number;
  hitAt3: number;
  hitAt5: number;
  mrr: number;
};

type CompareResult = {
  stats: StrategyStats[];
  evaluation?: { sample: number; seed: number; results: RetrievalEval[] };
};

const EVAL_LABELS: Record<RetrievalEval['kind'], string> = {
  sentence: 'Предложение → его место',
  heading: 'Заголовок → его раздел',
};

// Roughly 1800 characters per printed page.
const pages = (chars: number) => (chars / 1800).toFixed(1);
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/backend/rag${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message ?? `HTTP ${response.status}`);
  return body as T;
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function ChunkCard({ metadata, text, tokens, score }: { metadata: ChunkMetadata; text: string; tokens?: number; score?: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-black/10 bg-white p-2 text-xs">
      <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[#5c5c5c]">
        {score !== undefined && <span className="font-medium text-pine">{score.toFixed(4)}</span>}
        <span className="font-mono">{metadata.chunk_id}</span>
        <span>
          {metadata.start}–{metadata.end} ({text.length} симв.{tokens !== undefined ? `, ${tokens} ток.` : ''})
        </span>
        {metadata.part && <span>часть {metadata.part}</span>}
        {metadata.sectionsSpanned > 1 && <span className="text-amber-600">разделов: {metadata.sectionsSpanned}</span>}
        {tokens !== undefined && tokens > 512 && <span className="text-red-600">обрезан моделью</span>}
      </div>
      <div className="mb-1 text-[11px]">
        <span className="text-[#5c5c5c]">{metadata.file}</span>
        {metadata.section && <span className="text-pine"> › {metadata.section}</span>}
      </div>
      <p className={`whitespace-pre-wrap ${open ? '' : 'line-clamp-4'}`}>{text}</p>
      <button type="button" onClick={() => setOpen(!open)} className="mt-1 text-[11px] text-pine underline">
        {open ? 'свернуть' : 'полностью'}
      </button>
    </div>
  );
}

export default function RagPage() {
  const [documents, setDocuments] = useState<RagDocument[]>([]);
  const [params, setParams] = useState<Params | null>(null);
  const [embedding, setEmbedding] = useState<{ model: string; dim: number; maxTokens: number } | null>(null);
  const [status, setStatus] = useState<Status>({ busy: false });
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const [viewDoc, setViewDoc] = useState<string>('');
  const [viewOffset, setViewOffset] = useState(0);
  const [viewChunks, setViewChunks] = useState<Record<Strategy, { total: number; chunks: Chunk[] }> | null>(null);

  const [compare, setCompare] = useState<CompareResult | null>(null);
  const [sample, setSample] = useState(60);
  const [comparing, setComparing] = useState(false);

  const [query, setQuery] = useState('');
  const [k, setK] = useState(5);
  const [hits, setHits] = useState<Record<Strategy, SearchHit[]> | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchMode, setSearchMode] = useState<SearchMode>('hybrid');

  // Day 22: one question, two LLM answers — without and with RAG.
  const [askQuestion, setAskQuestion] = useState('');
  const [askStrategy, setAskStrategy] = useState<Strategy>('structural');
  const [askK, setAskK] = useState(5);
  const [askRewrite, setAskRewrite] = useState(false);
  const [askRerank, setAskRerank] = useState<Rerank>('cross-encoder');
  const [askCandidates, setAskCandidates] = useState(20);
  const [askMinScore, setAskMinScore] = useState(RERANK_THRESHOLDS['cross-encoder']);
  const [askResult, setAskResult] = useState<{ plain: RagAnswer; rag: RagAnswer } | null>(null);
  const [asking, setAsking] = useState(false);

  const refresh = useCallback(async () => {
    const data = await api<{ documents: RagDocument[]; params: Params; embedding?: typeof embedding; status: Status }>('');
    setDocuments(data.documents);
    setParams((current) => current ?? data.params);
    setEmbedding(data.embedding ?? null);
    setStatus(data.status);
    return data;
  }, []);

  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, [refresh]);

  // While a job runs, poll its progress (embedding a book takes a while).
  useEffect(() => {
    if (!status.busy) return;
    const timer = setInterval(() => {
      api<Status>('/status').then(setStatus).catch(() => undefined);
    }, 800);
    return () => clearInterval(timer);
  }, [status.busy]);

  async function runJob(job: () => Promise<unknown>) {
    setError(null);
    setStatus({ busy: true, phase: 'запуск…' });
    try {
      await job();
      setCompare(null);
      setHits(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      await refresh().catch(() => undefined);
      setStatus((s) => ({ ...s, busy: false }));
    }
  }

  function addUrl(event: FormEvent) {
    event.preventDefault();
    if (!url.trim()) return;
    runJob(async () => {
      await api('/documents', { method: 'POST', body: JSON.stringify({ url: url.trim() }) });
      setUrl('');
    });
  }

  function addFiles(files: FileList | null) {
    if (!files?.length) return;
    const list = Array.from(files);
    runJob(async () => {
      for (const file of list) {
        await api('/documents', {
          method: 'POST',
          body: JSON.stringify({ name: file.name, contentBase64: await readAsBase64(file) }),
        });
      }
      if (fileInput.current) fileInput.current.value = '';
    });
  }

  function saveParams(event: FormEvent) {
    event.preventDefault();
    if (!params) return;
    runJob(() => api('/params', { method: 'PUT', body: JSON.stringify(params) }));
  }

  function removeDocument(id: string) {
    if (!confirm('Удалить документ из обоих индексов?')) return;
    runJob(async () => {
      await api(`/documents/${id}`, { method: 'DELETE' });
      if (viewDoc === id) setViewDoc('');
    });
  }

  useEffect(() => {
    if (!viewDoc) {
      setViewChunks(null);
      return;
    }
    Promise.all(
      STRATEGIES.map((s) =>
        api<{ total: number; chunks: Chunk[] }>(`/documents/${viewDoc}/chunks?strategy=${s}&offset=${viewOffset}&limit=10`),
      ),
    )
      .then(([fixed, structural]) => setViewChunks({ fixed, structural }))
      .catch((e) => setError(e.message));
  }, [viewDoc, viewOffset, documents]);

  async function runCompare() {
    setComparing(true);
    setError(null);
    try {
      setCompare(await api<CompareResult>(`/compare?sample=${sample}`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setComparing(false);
    }
  }

  async function runSearch(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setError(null);
    try {
      setHits(
        await api<Record<Strategy, SearchHit[]>>('/search', {
          method: 'POST',
          body: JSON.stringify({ query, k, mode: searchMode }),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSearching(false);
    }
  }

  async function runAsk(event: FormEvent) {
    event.preventDefault();
    if (!askQuestion.trim()) return;
    setAsking(true);
    setError(null);
    try {
      setAskResult(
        await api('/ask', {
          method: 'POST',
          body: JSON.stringify({
            question: askQuestion,
            strategy: askStrategy,
            k: askK,
            search: searchMode,
            rewrite: askRewrite,
            rerank: askRerank,
            candidates: askCandidates,
            minScore: askMinScore,
          }),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAsking(false);
    }
  }

  const totalChars = documents.reduce((a, d) => a + d.chars, 0);
  const maxTotal = viewChunks ? Math.max(viewChunks.fixed.total, viewChunks.structural.total) : 0;
  const busy = status.busy;

  const section = 'rounded-lg border border-black/10 bg-white p-4';
  const input = 'rounded-md border border-black/15 px-2 py-1';
  const button = 'rounded-md bg-pine px-3 py-1 text-white disabled:opacity-40';

  return (
    <main className="min-h-screen bg-paper px-4 py-6 text-sm text-ink">
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
        <header className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h1 className="text-2xl font-medium">Индексация документов</h1>
            <p className="text-[#5c5c5c]">
              Чанкинг двумя стратегиями → локальные эмбеддинги → JSON-индекс с метаданными.
              {embedding && (
                <>
                  {' '}
                  Модель: <span className="font-mono">{embedding.model}</span> ({embedding.dim} измерений, до{' '}
                  {embedding.maxTokens} токенов).
                </>
              )}
            </p>
          </div>
          <Link href="/chat" className="text-pine underline">
            ← к чату
          </Link>
        </header>

        {error && <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-red-700">{error}</div>}

        <div className="grid gap-4 md:grid-cols-2">
          <section className={section}>
            <h2 className="mb-2 font-medium">Добавить документ</h2>
            <form onSubmit={addUrl} className="mb-3 flex gap-2">
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://… (статья, README, PDF, fb2)"
                className={`${input} min-w-0 flex-1`}
                disabled={busy}
              />
              <button type="submit" className={button} disabled={busy || !url.trim()}>
                По ссылке
              </button>
            </form>
            <label className="flex flex-col gap-1">
              <span className="text-[#5c5c5c]">или файлы: .fb2, .pdf, .md, .html, .txt, исходный код</span>
              <input
                ref={fileInput}
                type="file"
                multiple
                disabled={busy}
                accept=".fb2,.pdf,.md,.markdown,.mdx,.html,.htm,.txt,.ts,.tsx,.js,.jsx,.py,.java,.kt,.go,.rs,.rb,.php,.cs,.c,.cpp,.h,.swift,.sql,.css,.sh"
                onChange={(e) => addFiles(e.target.files)}
              />
            </label>
            {busy && (
              <div className="mt-3">
                <p className="text-pine">{status.phase ?? 'индексация…'}</p>
                {!!status.total && (
                  <div className="mt-1 h-1.5 overflow-hidden rounded bg-black/10">
                    <div className="h-full bg-pine transition-all" style={{ width: `${((status.done ?? 0) / status.total) * 100}%` }} />
                  </div>
                )}
              </div>
            )}
          </section>

          <section className={section}>
            <h2 className="mb-2 font-medium">Параметры чанкинга</h2>
            {params && (
              <form onSubmit={saveParams} className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="w-44">{STRATEGY_LABELS.fixed}:</span>
                  <label>
                    размер{' '}
                    <input
                      type="number"
                      className={`${input} w-20`}
                      value={params.fixed.size}
                      onChange={(e) => setParams({ ...params, fixed: { ...params.fixed, size: Number(e.target.value) } })}
                    />
                  </label>
                  <label>
                    перекрытие{' '}
                    <input
                      type="number"
                      className={`${input} w-20`}
                      value={params.fixed.overlap}
                      onChange={(e) => setParams({ ...params, fixed: { ...params.fixed, overlap: Number(e.target.value) } })}
                    />
                  </label>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="w-44">{STRATEGY_LABELS.structural}:</span>
                  <label>
                    макс.{' '}
                    <input
                      type="number"
                      className={`${input} w-20`}
                      value={params.structural.maxSize}
                      onChange={(e) =>
                        setParams({ ...params, structural: { ...params.structural, maxSize: Number(e.target.value) } })
                      }
                    />
                  </label>
                  <label>
                    мин.{' '}
                    <input
                      type="number"
                      className={`${input} w-20`}
                      value={params.structural.minSize}
                      onChange={(e) =>
                        setParams({ ...params, structural: { ...params.structural, minSize: Number(e.target.value) } })
                      }
                    />
                  </label>
                </div>
                <p className="text-[11px] text-[#5c5c5c]">
                  Размеры в символах. Сохранение переиндексирует все документы обеими стратегиями.
                </p>
                <div>
                  <button type="submit" className={button} disabled={busy}>
                    Сохранить и переиндексировать
                  </button>
                </div>
              </form>
            )}
          </section>
        </div>

        <section className={section}>
          <h2 className="mb-2 font-medium">
            Документы ({documents.length}, {totalChars.toLocaleString('ru')} симв. ≈ {pages(totalChars)} стр.)
          </h2>
          {!documents.length ? (
            <p className="text-[#5c5c5c]">Пока пусто — добавьте документ по ссылке или файлом.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-[#5c5c5c]">
                  <tr>
                    <th className="py-1 pr-2">Документ</th>
                    <th className="pr-2">Тип</th>
                    <th className="pr-2 text-right">Символов</th>
                    <th className="pr-2 text-right">≈ стр.</th>
                    <th className="pr-2 text-right">Разделов</th>
                    <th className="pr-2 text-right">fixed</th>
                    <th className="pr-2 text-right">structural</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {documents.map((d) => (
                    <tr key={d.id} className="border-t border-black/5">
                      <td className="max-w-xs py-1 pr-2">
                        <div className="truncate font-medium" title={d.title}>
                          {d.title}
                        </div>
                        <div className="truncate text-[11px] text-[#5c5c5c]" title={d.source}>
                          {d.source}
                        </div>
                      </td>
                      <td className="pr-2">{d.kind}</td>
                      <td className="pr-2 text-right">{d.chars.toLocaleString('ru')}</td>
                      <td className="pr-2 text-right">{pages(d.chars)}</td>
                      <td className="pr-2 text-right">{d.sections}</td>
                      <td className="pr-2 text-right">{d.chunks.fixed}</td>
                      <td className="pr-2 text-right">{d.chunks.structural}</td>
                      <td className="whitespace-nowrap text-right">
                        <button
                          type="button"
                          className="mr-2 text-pine underline"
                          onClick={() => {
                            setViewDoc(d.id);
                            setViewOffset(0);
                          }}
                        >
                          чанки
                        </button>
                        <button type="button" className="text-red-600 underline disabled:opacity-40" disabled={busy} onClick={() => removeDocument(d.id)}>
                          удалить
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {viewDoc && viewChunks && (
          <section className={section}>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-medium">Чанки: {documents.find((d) => d.id === viewDoc)?.title}</h2>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="rounded-md border border-black/10 px-2 py-0.5 disabled:opacity-40"
                  disabled={viewOffset === 0}
                  onClick={() => setViewOffset(Math.max(0, viewOffset - 10))}
                >
                  ←
                </button>
                <span className="text-[#5c5c5c]">
                  {viewOffset + 1}–{Math.min(viewOffset + 10, maxTotal)} из {maxTotal}
                </span>
                <button
                  type="button"
                  className="rounded-md border border-black/10 px-2 py-0.5 disabled:opacity-40"
                  disabled={viewOffset + 10 >= maxTotal}
                  onClick={() => setViewOffset(viewOffset + 10)}
                >
                  →
                </button>
                <button type="button" className="text-[#5c5c5c] underline" onClick={() => setViewDoc('')}>
                  закрыть
                </button>
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {STRATEGIES.map((s) => (
                <div key={s} className="flex flex-col gap-2">
                  <h3 className="font-medium text-pine">
                    {STRATEGY_LABELS[s]} — {viewChunks[s].total} чанков
                  </h3>
                  {viewChunks[s].chunks.map((c) => (
                    <ChunkCard key={c.metadata.chunk_id} {...c} />
                  ))}
                </div>
              ))}
            </div>
          </section>
        )}

        <section className={section}>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h2 className="font-medium">Сравнение стратегий</h2>
            <label className="ml-auto text-[#5c5c5c]">
              запросов для проверки{' '}
              <input type="number" className={`${input} w-16`} value={sample} min={0} max={500} onChange={(e) => setSample(Number(e.target.value))} />
            </label>
            <button type="button" className={button} disabled={comparing || busy || !documents.length} onClick={runCompare}>
              {comparing ? 'Считаю…' : 'Сравнить'}
            </button>
          </div>
          {compare && (
            <div className="flex flex-col gap-4 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-[#5c5c5c]">
                  <tr>
                    <th className="py-1 pr-2">Метрика</th>
                    {compare.stats.map((s) => (
                      <th key={s.strategy} className="pr-2">
                        {STRATEGY_LABELS[s.strategy]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      ['Параметры', (s) => Object.entries(s.params).map(([k, v]) => `${k}=${v}`).join(', ')],
                      ['Чанков', (s) => s.chunks],
                      ['Длина, симв.: среднее / медиана', (s) => `${s.chars.avg} / ${s.chars.median}`],
                      ['Длина: min–max (σ)', (s) => `${s.chars.min}–${s.chars.max} (σ ${s.chars.stdDev})`],
                      ['Токенов: среднее / max', (s) => `${s.tokens.avg} / ${s.tokens.max}`],
                      ['Обрезано моделью (> лимита токенов)', (s) => pct(s.truncatedShare)],
                      ['Чанк захватывает > 1 раздела', (s) => pct(s.crossSectionShare)],
                      ['Обрыв посреди предложения', (s) => pct(s.brokenEndShare)],
                      ['Мелкие чанки (< 200 симв.)', (s) => pct(s.tinyShare)],
                      ['Избыточность (символы чанков / текста)', (s) => `×${s.redundancy}`],
                      ['Время эмбеддингов', (s) => `${(s.embedMs / 1000).toFixed(1)} с`],
                      ['Размер индекса', (s) => `${(s.indexBytes / 1024 / 1024).toFixed(2)} МБ`],
                    ] as [string, (s: StrategyStats) => string | number][]
                  ).map(([label, f]) => (
                    <tr key={label} className="border-t border-black/5">
                      <td className="py-1 pr-2 text-[#5c5c5c]">{label}</td>
                      {compare.stats.map((s) => (
                        <td key={s.strategy} className="pr-2">
                          {f(s)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>

              {compare.evaluation && (
                <div>
                  <h3 className="mb-1 font-medium">Качество поиска без разметки</h3>
                  <p className="mb-2 text-[11px] text-[#5c5c5c]">
                    «Предложение → его место»: запрос — случайное предложение из документа; попадание — чанк с этим местом
                    текста в top-k. «Заголовок → его раздел»: запрос — заголовок раздела; попадание — чанк, минимум
                    наполовину состоящий из этого раздела (проверяет, держит ли чанк одну тему). Seed {compare.evaluation.seed}.
                  </p>
                  <table className="w-full text-left text-xs">
                    <thead className="text-[#5c5c5c]">
                      <tr>
                        <th className="py-1 pr-2">Проверка</th>
                        <th className="pr-2">Стратегия</th>
                        <th className="pr-2 text-right">Запросов</th>
                        <th className="pr-2 text-right">Hit@1</th>
                        <th className="pr-2 text-right">Hit@3</th>
                        <th className="pr-2 text-right">Hit@5</th>
                        <th className="pr-2 text-right">MRR</th>
                      </tr>
                    </thead>
                    <tbody>
                      {compare.evaluation.results.map((r) => {
                        const best = Math.max(
                          ...compare.evaluation!.results.filter((x) => x.kind === r.kind).map((x) => x.mrr),
                        );
                        return (
                          <tr key={`${r.kind}-${r.strategy}`} className="border-t border-black/5">
                            <td className="py-1 pr-2 text-[#5c5c5c]">{EVAL_LABELS[r.kind]}</td>
                            <td className="pr-2">{STRATEGY_LABELS[r.strategy]}</td>
                            <td className="pr-2 text-right">{r.queries}</td>
                            <td className="pr-2 text-right">{pct(r.hitAt1)}</td>
                            <td className="pr-2 text-right">{pct(r.hitAt3)}</td>
                            <td className="pr-2 text-right">{pct(r.hitAt5)}</td>
                            <td className={`pr-2 text-right ${r.mrr === best ? 'font-medium text-pine' : ''}`}>{r.mrr.toFixed(3)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </section>

        <section className={section}>
          <form onSubmit={runSearch} className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="mr-2 font-medium">Поиск по индексу</h2>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Вопрос к документам…"
              className={`${input} min-w-0 flex-1`}
            />
            <label className="text-[#5c5c5c]">
              k <input type="number" className={`${input} w-14`} value={k} min={1} max={50} onChange={(e) => setK(Number(e.target.value))} />
            </label>
            <select value={searchMode} onChange={(e) => setSearchMode(e.target.value as SearchMode)} className={input}>
              {(Object.keys(SEARCH_LABELS) as SearchMode[]).map((m) => (
                <option key={m} value={m}>
                  {SEARCH_LABELS[m]}
                </option>
              ))}
            </select>
            <button type="submit" className={button} disabled={searching || !query.trim() || !documents.length}>
              {searching ? 'Ищу…' : 'Найти'}
            </button>
          </form>
          {hits && (
            <div className="grid gap-3 md:grid-cols-2">
              {STRATEGIES.map((s) => (
                <div key={s} className="flex flex-col gap-2">
                  <h3 className="font-medium text-pine">{STRATEGY_LABELS[s]}</h3>
                  {hits[s].map((h) => (
                    <ChunkCard key={h.metadata.chunk_id} metadata={h.metadata} text={h.text} score={h.score} />
                  ))}
                </div>
              ))}
            </div>
          )}
        </section>

        <section className={section}>
          <form onSubmit={runAsk} className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="mr-2 font-medium">Вопрос к LLM: без RAG и с RAG</h2>
            <input
              value={askQuestion}
              onChange={(e) => setAskQuestion(e.target.value)}
              placeholder="Например: как звали молодого финна из Тампере?"
              className={`${input} min-w-0 flex-1`}
            />
            <select value={askStrategy} onChange={(e) => setAskStrategy(e.target.value as Strategy)} className={input}>
              {STRATEGIES.map((s) => (
                <option key={s} value={s}>
                  {STRATEGY_LABELS[s]}
                </option>
              ))}
            </select>
            <button type="submit" className={button} disabled={asking || !askQuestion.trim()}>
              {asking ? 'Спрашиваю…' : 'Спросить'}
            </button>
          </form>
          <div className="mb-2 flex flex-wrap items-center gap-3 text-[#5c5c5c]">
            <label className="flex items-center gap-1" title="LLM переписывает вопрос в поисковый запрос; ищется по обоим, рейтинги сливаются">
              <input type="checkbox" checked={askRewrite} onChange={(e) => setAskRewrite(e.target.checked)} />
              query rewrite
            </label>
            <label className="flex items-center gap-1">
              реранкер
              <select
                value={askRerank}
                onChange={(e) => {
                  const rerank = e.target.value as Rerank;
                  setAskRerank(rerank);
                  setAskMinScore(RERANK_THRESHOLDS[rerank]);
                }}
                className={input}
              >
                {(Object.keys(RERANK_LABELS) as Rerank[]).map((r) => (
                  <option key={r} value={r}>
                    {RERANK_LABELS[r]}
                  </option>
                ))}
              </select>
            </label>
            {askRerank !== 'none' && (
              <label title="сколько кандидатов взять из поиска до реранкинга и фильтра">
                top-K до{' '}
                <input
                  type="number"
                  className={`${input} w-14`}
                  value={askCandidates}
                  min={1}
                  max={50}
                  onChange={(e) => setAskCandidates(Number(e.target.value))}
                />
              </label>
            )}
            <label title="сколько фрагментов максимум уйдёт в LLM">
              top-K после{' '}
              <input type="number" className={`${input} w-14`} value={askK} min={1} max={20} onChange={(e) => setAskK(Number(e.target.value))} />
            </label>
            <label title={askRerank === 'none' ? 'порог по cosine, 0 — без фильтра' : 'порог по оценке реранкера 0..1, 0 — без фильтра'}>
              порог{' '}
              <input
                type="number"
                className={`${input} w-16`}
                value={askMinScore}
                min={0}
                max={1}
                step={0.05}
                onChange={(e) => setAskMinScore(Number(e.target.value))}
              />
            </label>
          </div>
          <p className="mb-2 text-[11px] text-[#5c5c5c]">
            Один и тот же вопрос уходит в LLM дважды: как есть и вместе с найденными фрагментами ({SEARCH_LABELS[searchMode]} поиск,
            режим выбирается рядом с поиском выше). Контрольные вопросы с оценкой — <span className="font-mono">npm run rag-eval</span>.
          </p>
          {askResult && (
            <div className="grid gap-3 md:grid-cols-2">
              {([['Без RAG', askResult.plain], ['С RAG', askResult.rag]] as [string, RagAnswer][]).map(([label, a]) => (
                <div key={label} className="flex flex-col gap-2">
                  <h3 className="font-medium text-pine">{label}</h3>
                  <p className="whitespace-pre-wrap rounded-md bg-paper p-2 text-xs">{a.answer}</p>
                  <p className="text-[11px] text-[#5c5c5c]">
                    {a.model} · {(a.durationMs / 1000).toFixed(1)} с{a.usage && <> · {a.usage.totalTokens} токенов</>}
                    {a.costByn !== undefined && <> · {a.costByn.toFixed(5)} BYN</>}
                  </p>
                  {a.pipeline && (
                    <div className="text-[11px] text-[#5c5c5c]">
                      {a.pipeline.rewritten && (
                        <p>
                          Запрос после rewrite: <span className="text-ink">«{a.pipeline.rewritten}»</span>
                        </p>
                      )}
                      <p>
                        Кандидатов {a.pipeline.candidates.length} → в контексте {a.hits.length}
                        {a.pipeline.filteredOut > 0 && <> (отсечено порогом: {a.pipeline.filteredOut})</>}
                        {!a.hits.length && <> — модели сказано, что релевантных фрагментов нет</>} · поиск {a.pipeline.timings.searchMs} мс
                        {a.pipeline.timings.rewriteMs > 0 && <>, rewrite {a.pipeline.timings.rewriteMs} мс</>}
                        {a.pipeline.timings.rerankMs > 0 && <>, реранкинг {a.pipeline.timings.rerankMs} мс</>}
                      </p>
                      <details className="mt-1">
                        <summary className="cursor-pointer">Все кандидаты до фильтра</summary>
                        <ol className="mt-1 list-decimal pl-5">
                          {a.pipeline.candidates.map((c) => {
                            const kept = a.hits.findIndex((h) => h.metadata.chunk_id === c.metadata.chunk_id);
                            const scored = a.hits[kept]?.rerankScore;
                            return (
                              <li key={c.metadata.chunk_id} className={kept >= 0 ? 'text-ink' : ''}>
                                {c.metadata.section.split(' › ').pop()}
                                {c.metadata.part && ` (ч. ${c.metadata.part})`} · cos {c.score.toFixed(3)}
                                {kept >= 0 ? <> → [{kept + 1}]{scored !== undefined && <>, реранкер {scored.toFixed(3)}</>}</> : ' · не вошёл (ниже порога или за top-K)'}
                              </li>
                            );
                          })}
                        </ol>
                      </details>
                    </div>
                  )}
                  {a.hits.length > 0 && (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-[#5c5c5c]">Фрагменты в запросе ({a.hits.length})</summary>
                      <div className="mt-1 flex flex-col gap-2">
                        {a.hits.map((h, i) => (
                          <div key={h.metadata.chunk_id}>
                            <span className="font-mono text-[11px]">[{i + 1}]</span>
                            <ChunkCard metadata={h.metadata} text={h.text} score={h.rerankScore ?? h.score} />
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
