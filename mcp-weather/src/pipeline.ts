import { createHash, createHmac, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

// Pipeline (Day 19): search -> summarize -> save_to_file as separate MCP
// tools that hand data over *by reference*. Every step stores its output as
// an artifact and returns its id; the next step takes that id, not the text.
// The model never retypes content between steps (so it can't alter it or
// burn tokens on it), and each artifact records its parent's id and sha256,
// so the chain can be verified end to end.

const DATA_DIR = process.env.PIPELINE_DIR ?? path.join(process.cwd(), 'data');
const STORE_PATH = path.join(DATA_DIR, 'pipeline.json');
export const FILES_DIR = path.join(DATA_DIR, 'files');
const MAX_ARTIFACTS = 500;
const REQUEST_TIMEOUT_MS = 12_000;
const USER_AGENT = 'advent-mcp/0.3 (https://github.com/Mikhail-Ivanou/ai_advent)';
/** Per-document text cap — keeps artifacts (and anything a model reads back) bounded. */
const MAX_DOC_CHARS = 20_000;

export type SearchSource = 'wikipedia' | 'habr' | 'hackernews';
export type SummaryStyle = 'brief' | 'bullets' | 'detailed';
export type FileFormat = 'md' | 'txt' | 'json';

export const SOURCE_LABELS: Record<SearchSource, string> = { wikipedia: 'Wikipedia', habr: 'Habr', hackernews: 'Hacker News' };

export interface SearchItem {
  /** Which service this came from — one search can span several. */
  source: SearchSource;
  title: string;
  url: string;
  text: string;
  publishedAt?: string;
  author?: string;
}

interface ArtifactBase {
  id: string;
  createdAt: string;
  /** sha256 of `content` — what the next step checks it received. */
  sha256: string;
  /** The text payload handed to the next step. */
  content: string;
  parentId?: string;
  parentSha256?: string;
  ownerId?: string;
}

export interface SearchArtifact extends ArtifactBase {
  kind: 'search';
  query: string;
  sources: SearchSource[];
  lang: string;
  /** Results per source. */
  limit: number;
  items: SearchItem[];
  /** Services that failed while the others succeeded — the search is partial, not lost. */
  failures: { source: SearchSource; error: string }[];
}

export interface SummaryArtifact extends ArtifactBase {
  kind: 'summary';
  style: SummaryStyle;
  method: 'extractive';
  query?: string;
  sources: { source?: SearchSource; title: string; url: string }[];
  sentencesPicked: number;
  sentencesTotal: number;
}

export interface FileArtifact extends ArtifactBase {
  kind: 'file';
  filename: string;
  format: FileFormat;
  bytes: number;
  /** sha256 of the bytes actually written — re-read from disk after writing. */
  fileSha256: string;
}

export type Artifact = SearchArtifact | SummaryArtifact | FileArtifact;

export class PipelineError extends Error {}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf-8').digest('hex');
const shortHash = (hash: string) => hash.slice(0, 12);

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** HTML -> plain text, keeping paragraph breaks and dropping code blocks (noise for a summary). */
function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|pre|code|figure)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|blockquote|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

async function getJson(url: string): Promise<any> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new PipelineError(`Источник недоступен (${new URL(url).host}): ${(error as Error).message}`);
  }
  if (!response.ok) throw new PipelineError(`Источник ${new URL(url).host} вернул ${response.status}`);
  return response.json();
}

// --- search -----------------------------------------------------------------

async function searchWikipedia(query: string, lang: string, limit: number): Promise<RawItem[]> {
  const api = `https://${lang}.wikipedia.org/w/api.php`;
  const found = await getJson(
    `${api}?action=query&list=search&format=json&utf8=1&srlimit=${limit}&srsearch=${encodeURIComponent(query)}`,
  );
  const hits: { title: string; pageid: number }[] = found.query?.search ?? [];
  if (hits.length === 0) return [];
  // One batched call for all intros, instead of one per page.
  const pages = await getJson(
    `${api}?action=query&prop=extracts&exintro=1&explaintext=1&format=json&utf8=1&pageids=${hits.map((h) => h.pageid).join('|')}`,
  );
  return hits
    .map((hit) => ({
      title: hit.title,
      url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, '_'))}`,
      text: String(pages.query?.pages?.[hit.pageid]?.extract ?? '').trim(),
    }))
    .filter((item) => item.text);
}

async function searchHabr(query: string, lang: string, limit: number): Promise<RawItem[]> {
  // Habr has no public API; this is the JSON API its own site uses.
  const found = await getJson(
    `https://habr.com/kek/v2/articles/?query=${encodeURIComponent(query)}&order=relevance&fl=${lang}&hl=${lang}&page=1`,
  );
  const ids: string[] = (found.publicationIds ?? []).slice(0, limit);
  const items = await Promise.all(
    ids.map(async (id) => {
      const ref = found.publicationRefs?.[id] ?? {};
      // Full text needs a second call per article; fall back to the lead if it fails.
      const article = await getJson(`https://habr.com/kek/v2/articles/${id}/`).catch(() => null);
      const html = article?.textHtml ?? ref.leadData?.textHtml ?? '';
      return {
        title: htmlToText(ref.titleHtml ?? article?.titleHtml ?? `Статья ${id}`),
        url: `https://habr.com/ru/articles/${id}/`,
        text: htmlToText(html),
        publishedAt: ref.timePublished,
        author: ref.author?.alias,
      };
    }),
  );
  return items.filter((item) => item.text);
}

async function searchHackerNews(query: string, _lang: string, limit: number): Promise<RawItem[]> {
  const found = await getJson(
    `https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=${limit}&query=${encodeURIComponent(query)}`,
  );
  return (found.hits ?? [])
    .map((hit: any) => ({
      title: hit.title ?? '(без названия)',
      url: hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`,
      // Most HN stories are just links; the text is the title plus the self-post body if any.
      text: [hit.title, hit.story_text ? htmlToText(hit.story_text) : '']
        .filter(Boolean)
        .join('. ')
        .concat(`. ${hit.points ?? 0} points, ${hit.num_comments ?? 0} comments.`),
      publishedAt: hit.created_at,
      author: hit.author,
    }))
    .filter((item: RawItem) => item.text);
}

type RawItem = Omit<SearchItem, 'source'>;

const SEARCHERS: Record<SearchSource, (q: string, lang: string, limit: number) => Promise<RawItem[]>> = {
  wikipedia: searchWikipedia,
  habr: searchHabr,
  hackernews: searchHackerNews,
};

// --- summarize (keyless, extractive) ---------------------------------------

const STOPWORDS = new Set(
  (
    'и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между это также которые который которая которое является используется ' +
    'the a an and or but of to in on for with as by at from is are was were be been being this that these those it its into than then there their they them he she his her we you your our not no so if can will would should could has have had do does did about over also more most such which who whom what when where why how all any each other some only own same very just'
  ).split(' '),
);

const tokenize = (text: string) =>
  (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 2 && !STOPWORDS.has(w));

/** Crude stemming: word forms share their first 6 letters often enough for frequency counting in both ru and en. */
const stem = (word: string) => word.slice(0, 6);

function splitSentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((para) => para.match(/[^.!?…]+(?:[.!?…]+["»)]*|$)/g) ?? [])
    .map((s) => s.trim())
    .filter(
      (s) =>
        s.length >= 25 &&
        s.length <= 600 &&
        tokenize(s).length >= 4 &&
        // Real sentences, not list items / captions / headings cut out of the markup.
        /^["«(\p{Lu}\p{N}]/u.test(s) &&
        (/[.!?…]["»)]*$/.test(s) || s.length >= 80),
    );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let common = 0;
  for (const x of a) if (b.has(x)) common++;
  return common / (a.size + b.size - common || 1);
}

interface Candidate {
  doc: number;
  index: number;
  text: string;
  stems: Set<string>;
  score: number;
}

const STYLE_BUDGET: Record<SummaryStyle, number> = { brief: 90, bullets: 160, detailed: 320 };

export function extractiveSummary(
  items: SearchItem[],
  style: SummaryStyle,
  maxWords: number | undefined,
  query?: string,
): { text: string; picked: Candidate[]; total: number } {
  const perDoc = items.map((item) => splitSentences(item.text));
  const candidates: Candidate[] = [];
  const freq = new Map<string, number>();
  perDoc.forEach((sentences) =>
    sentences.forEach((s) => new Set(tokenize(s).map(stem)).forEach((t) => freq.set(t, (freq.get(t) ?? 0) + 1))),
  );
  const maxFreq = Math.max(1, ...freq.values());
  const queryStems = new Set(tokenize(query ?? '').map(stem));

  perDoc.forEach((sentences, doc) =>
    sentences.forEach((text, index) => {
      const stems = new Set(tokenize(text).map(stem));
      const tf = [...stems].reduce((sum, t) => sum + (freq.get(t) ?? 0) / maxFreq, 0) / Math.sqrt(stems.size || 1);
      const position = index === 0 ? 0.6 : index < 3 ? 0.3 : 0; // leads tend to carry the gist
      const queryHit = [...queryStems].filter((q) => stems.has(q)).length * 0.4;
      const docRank = 0.3 / (doc + 1); // search results come ordered by relevance
      candidates.push({ doc, index, text, stems, score: tf + position + queryHit + docRank });
    }),
  );

  const budget = maxWords ?? STYLE_BUDGET[style];
  const picked: Candidate[] = [];
  let words = 0;
  const pool = [...candidates].sort((a, b) => b.score - a.score);
  // Coverage first: the best sentence from every source service, so a long
  // Habr article can't crowd Wikipedia out of a multi-source summary.
  for (const source of new Set(items.map((i) => i.source))) {
    const best = pool.find((c) => items[c.doc].source === source);
    if (!best) continue;
    picked.push(best);
    words += best.text.split(/\s+/).length;
  }
  // Then greedy by score, skipping near-duplicates (common across several articles on one topic).
  for (const c of pool) {
    if (picked.includes(c)) continue;
    if (picked.some((p) => jaccard(p.stems, c.stems) > 0.5)) continue;
    const w = c.text.split(/\s+/).length;
    if (picked.length > 0 && words + w > budget) continue;
    picked.push(c);
    words += w;
    if (words >= budget) break;
  }
  // Back into reading order: by source, then by position within it.
  picked.sort((a, b) => a.doc - b.doc || a.index - b.index);

  const text =
    style === 'bullets'
      ? picked.map((p) => `• ${p.text}`).join('\n')
      : style === 'detailed'
        ? items
            .map((item, doc) => ({ item, sentences: picked.filter((p) => p.doc === doc) }))
            .filter((g) => g.sentences.length)
            .map((g) => `${SOURCE_LABELS[g.item.source]} — ${g.item.title}:\n${g.sentences.map((p) => p.text).join(' ')}`)
            .join('\n\n')
        : picked.map((p) => p.text).join(' ');
  return { text, picked, total: candidates.length };
}

// --- store + steps -----------------------------------------------------------

function safeFilename(name: string, format: FileFormat): string {
  const base = name
    .replace(/\.(md|txt|json)$/i, '')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${base || 'result'}.${format}`;
}

export class Pipeline {
  private artifacts: Artifact[] = [];
  private writeQueue: Promise<void> = Promise.resolve();

  async load(): Promise<void> {
    try {
      this.artifacts = JSON.parse(await fs.readFile(STORE_PATH, 'utf-8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await fs.mkdir(FILES_DIR, { recursive: true });
  }

  get(id: string, ownerId?: string): Artifact {
    const artifact = this.artifacts.find((a) => a.id === id);
    // Owner check: a chat can only chain from its own artifacts.
    if (!artifact || (artifact.ownerId && ownerId && artifact.ownerId !== ownerId)) {
      throw new PipelineError(`Артефакт ${id} не найден — передай id, который вернул предыдущий шаг`);
    }
    // Integrity check on every read: what we hand over must be what was stored.
    if (sha256(artifact.content) !== artifact.sha256) {
      throw new PipelineError(`Артефакт ${id} повреждён: контрольная сумма не совпадает`);
    }
    return artifact;
  }

  async search(input: {
    query: string;
    sources: SearchSource[];
    lang: string;
    /** Per source. */
    limit: number;
    ownerId?: string;
  }): Promise<SearchArtifact> {
    const sources = [...new Set(input.sources)];
    if (sources.length === 0) throw new PipelineError('Укажи хотя бы один источник поиска');
    // All services in parallel; one failing (down, blocked, rate-limited)
    // leaves a partial result rather than failing the whole search.
    const settled = await Promise.allSettled(sources.map((s) => SEARCHERS[s](input.query, input.lang, input.limit)));
    const perSource: SearchItem[][] = [];
    const failures: SearchArtifact['failures'] = [];
    settled.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        perSource.push(result.value.map((item) => ({ ...item, source: sources[i], text: item.text.slice(0, MAX_DOC_CHARS) })));
      } else {
        failures.push({ source: sources[i], error: (result.reason as Error).message });
      }
    });
    // Interleave by rank (habr#1, wiki#1, habr#2, …) so no source crowds out
    // the other — summarize favours earlier documents.
    const items: SearchItem[] = [];
    for (let rank = 0; perSource.some((list) => rank < list.length); rank++) {
      for (const list of perSource) if (rank < list.length) items.push(list[rank]);
    }
    if (items.length === 0) {
      const why = failures.length ? `: ${failures.map((f) => `${SOURCE_LABELS[f.source]} — ${f.error}`).join('; ')}` : '';
      throw new PipelineError(`По запросу «${input.query}» ничего не найдено (${sources.map((s) => SOURCE_LABELS[s]).join(', ')})${why}`);
    }
    const content = items
      .map((item, i) => `[${i + 1}] ${SOURCE_LABELS[item.source]}: ${item.title}\n${item.url}\n${item.text}`)
      .join('\n\n');
    return this.add<SearchArtifact>({
      kind: 'search',
      query: input.query,
      sources,
      lang: input.lang,
      limit: input.limit,
      ownerId: input.ownerId,
      items,
      failures,
      content,
    } as Omit<SearchArtifact, 'id' | 'createdAt' | 'sha256'>);
  }

  async summarize(input: {
    sourceId: string;
    style: SummaryStyle;
    maxWords?: number;
    ownerId?: string;
  }): Promise<SummaryArtifact> {
    const source = this.get(input.sourceId, input.ownerId);
    if (source.kind !== 'search') {
      throw new PipelineError(`summarize принимает результат search, а ${source.id} — это ${source.kind}`);
    }
    const summary = extractiveSummary(source.items, input.style, input.maxWords, source.query);
    if (!summary.text) throw new PipelineError('В найденных текстах нет подходящих предложений для резюме');
    return this.add<SummaryArtifact>({
      kind: 'summary',
      style: input.style,
      method: 'extractive',
      query: source.query,
      sources: source.items.map((i) => ({ source: i.source, title: i.title, url: i.url })),
      sentencesPicked: summary.picked.length,
      sentencesTotal: summary.total,
      content: summary.text,
      parentId: source.id,
      parentSha256: source.sha256,
      ownerId: input.ownerId,
    });
  }

  async saveToFile(input: {
    sourceId: string;
    format: FileFormat;
    filename?: string;
    ownerId?: string;
  }): Promise<FileArtifact> {
    const source = this.get(input.sourceId, input.ownerId);
    if (source.kind === 'file') throw new PipelineError(`${source.id} уже файл — передай id результата search или summarize`);

    const title = source.kind === 'search' ? source.query : (source.query ?? 'Резюме');
    const sources =
      source.kind === 'search'
        ? source.items.map((i) => ({ source: i.source, title: i.title, url: i.url }))
        : source.sources;
    const label = (s: { source?: SearchSource }) => (s.source ? `${SOURCE_LABELS[s.source]}: ` : '');
    const meta = {
      artifactId: source.id,
      kind: source.kind,
      sha256: source.sha256,
      parentId: source.parentId,
      createdAt: source.createdAt,
    };
    const body =
      input.format === 'json'
        ? JSON.stringify({ title, content: source.content, sources, meta }, null, 2)
        : input.format === 'md'
          ? [
              `# ${title}`,
              '',
              source.content,
              '',
              '## Источники',
              ...sources.map((s) => `- ${label(s)}[${s.title}](${s.url})`),
              '',
              `<!-- ${source.kind} ${source.id} sha256=${source.sha256} -->`,
              '',
            ].join('\n')
          : [title, '', source.content, '', 'Источники:', ...sources.map((s) => `- ${label(s)}${s.title}: ${s.url}`), ''].join('\n');

    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const filename = safeFilename(input.filename ?? `${title}-${stamp}`, input.format);
    const fullPath = path.join(FILES_DIR, filename);
    await fs.writeFile(fullPath, body, 'utf-8');
    // Re-read from disk: the hash we report is of what's really there.
    const written = await fs.readFile(fullPath, 'utf-8');
    if (!written.includes(input.format === 'json' ? JSON.stringify(source.content) : source.content)) {
      throw new PipelineError('Проверка записи не прошла: в файле нет переданного содержимого');
    }
    return this.add<FileArtifact>({
      kind: 'file',
      filename,
      format: input.format,
      bytes: Buffer.byteLength(written, 'utf-8'),
      fileSha256: sha256(written),
      content: source.content,
      parentId: source.id,
      parentSha256: source.sha256,
      ownerId: input.ownerId,
    });
  }

  /** The fixed chain in one call: each step's output id feeds the next, with a hash check at every handoff. */
  async run(input: {
    query: string;
    sources: SearchSource[];
    lang: string;
    limit: number;
    style: SummaryStyle;
    maxWords?: number;
    format: FileFormat;
    filename?: string;
    ownerId?: string;
  }): Promise<{ steps: PipelineStep[]; file: FileArtifact }> {
    const steps: PipelineStep[] = [];
    const step = async <T extends Artifact>(name: string, fn: () => Promise<T>): Promise<T> => {
      const started = Date.now();
      const artifact = await fn();
      const parentOk = artifact.parentId ? this.get(artifact.parentId).sha256 === artifact.parentSha256 : undefined;
      steps.push({
        tool: name,
        artifactId: artifact.id,
        parentId: artifact.parentId,
        sha256: artifact.sha256,
        chars: artifact.content.length,
        handoffOk: parentOk,
        ms: Date.now() - started,
      });
      return artifact;
    };
    const found = await step('search', () => this.search(input));
    const summary = await step('summarize', () =>
      this.summarize({ sourceId: found.id, style: input.style, maxWords: input.maxWords, ownerId: input.ownerId }),
    );
    const file = await step('save_to_file', () =>
      this.saveToFile({ sourceId: summary.id, format: input.format, filename: input.filename, ownerId: input.ownerId }),
    );
    return { steps, file };
  }

  private async add<T extends Artifact>(fields: Omit<T, 'id' | 'createdAt' | 'sha256'>): Promise<T> {
    const artifact = {
      id: randomUUID().slice(0, 8),
      createdAt: new Date().toISOString(),
      sha256: sha256((fields as { content: string }).content),
      ...fields,
    } as T;
    this.artifacts.push(artifact);
    if (this.artifacts.length > MAX_ARTIFACTS) this.artifacts.splice(0, this.artifacts.length - MAX_ARTIFACTS);
    await this.persist();
    return artifact;
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.artifacts);
    const write = async () => {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.writeFile(`${STORE_PATH}.tmp`, snapshot, 'utf-8');
      await fs.rename(`${STORE_PATH}.tmp`, STORE_PATH);
    };
    const current = this.writeQueue.then(write, write);
    this.writeQueue = current.catch(() => {});
    return current;
  }
}

export interface PipelineStep {
  tool: string;
  artifactId: string;
  parentId?: string;
  sha256: string;
  chars: number;
  /** Parent's current hash equals the one recorded at handoff — undefined for the first step. */
  handoffOk?: boolean;
  ms: number;
}

export function describeStep(s: PipelineStep): string {
  const handoff = s.parentId ? ` ← ${s.parentId} ${s.handoffOk ? '✓' : '✗'}` : '';
  return `${s.tool}#${s.artifactId}${handoff} · ${s.chars} симв. · sha256 ${shortHash(s.sha256)} · ${s.ms} мс`;
}

export { shortHash };

/**
 * Per-file download signature: HMAC of the filename keyed by the server's
 * bearer token. A browser can't send an Authorization header when the user
 * clicks a link, and putting the token itself in a URL would leak it; a
 * signature opens exactly one file and reveals nothing about the token.
 */
export function signFilename(filename: string, secret: string): string {
  return createHmac('sha256', secret).update(filename, 'utf-8').digest('hex').slice(0, 32);
}
