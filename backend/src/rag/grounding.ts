import { SearchHit } from './rag.types';

// Day 24: grounded answers. With RAG the model must answer in a fixed shape —
// the answer, the sources it used ([n] of the excerpts) and verbatim quotes
// from them — or say it doesn't know. The server then checks the shape
// against the excerpts it actually sent:
// - sources are resolved from [n] to real chunk metadata (source, section,
//   chunk_id) — never taken from the model's text;
// - every quote is looked up in the excerpt it cites: exact (after
//   whitespace/quote/dash normalisation), approximate (≥ 85% of its words in
//   order inside one window of the excerpt), or not found;
// - an answer with no confirmed quote is not delivered as an answer: it
//   becomes "Не знаю" with a request to clarify;
// - when retrieval found nothing relevant enough (all below the threshold),
//   the LLM is not asked at all — the same "Не знаю" + clarification.

export const GROUNDED_FORMAT_INSTRUCTIONS = [
  'Answer ONLY from the excerpts below. Reply in exactly this format, in the language of the question:',
  'ОТВЕТ: <the answer — short, only what the excerpts support>',
  'ИСТОЧНИКИ: <the excerpt numbers you used, e.g. [1], [3]>',
  'ЦИТАТЫ:',
  '[n] «<a verbatim fragment of excerpt n, copied character for character, one or two sentences, that supports the answer>»',
  '(one to three quotes, each on its own line with its own [n]; every claim in the answer must be backed by a quote; do not paraphrase inside the quotes, do not join pieces of different sentences)',
  'If the excerpts answer only part of the question, answer that part in this format and say in ОТВЕТ what the excerpts do not cover.',
  'If the excerpts do not contain the answer at all, reply with a single line instead:',
  'НЕ ЗНАЮ: <what is missing and what the user could clarify — e.g. which character, chapter or event they mean>',
].join('\n');

export type QuoteMatch = 'exact' | 'approximate' | 'not-found';

export interface GroundedQuote {
  /** Excerpt number the model cited; corrected when the quote was found in a different excerpt. */
  n: number;
  text: string;
  match: QuoteMatch;
  chunk_id?: string;
}

export interface GroundedSource {
  n: number;
  chunk_id: string;
  source: string;
  title: string;
  section: string;
  file: string;
}

export type GroundingStatus = 'answered' | 'unknown';

/**
 * Why the assistant said "не знаю":
 * - low-relevance: retrieval found nothing above the threshold, the LLM was not asked;
 * - model: the model itself said the excerpts don't contain the answer;
 * - unverified: the model answered, but none of its quotes was found in the excerpts.
 */
export type UnknownReason = 'low-relevance' | 'model' | 'unverified';

export interface Grounding {
  status: GroundingStatus;
  reason?: UnknownReason;
  /** The answer part (or, for "unknown", the clarification text). */
  answer: string;
  sources: GroundedSource[];
  quotes: GroundedQuote[];
  /** Excerpt numbers the model cited that don't exist. */
  invalidRefs: number[];
  /** The model's own answer, when it was rejected for lack of confirmed quotes. */
  rejectedAnswer?: string;
  /** Best relevance among the candidates and the threshold, for "low-relevance". */
  topScore?: number;
  threshold?: number;
}

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"“”„'’`]/g, '')
    .replace(/[–—‑-]/g, '-')
    .replace(/\s*-\s*/g, '-')
    .replace(/[.…]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const words = (s: string) => normalize(s).match(/[\p{L}\d]+/gu) ?? [];

/** Share of the quote's words found in order inside the best window of the text. */
function inOrderCoverage(quote: string[], text: string[]): number {
  if (!quote.length) return 0;
  let best = 0;
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== quote[0] && quote.length > 1 && text[start] !== quote[1]) continue;
    let qi = 0;
    // A window a bit longer than the quote, so a skipped word or two still count.
    for (let ti = start; ti < Math.min(text.length, start + Math.ceil(quote.length * 1.3) + 2) && qi < quote.length; ti++) {
      if (text[ti] === quote[qi]) qi++;
      else if (qi + 1 < quote.length && text[ti] === quote[qi + 1]) qi += 2;
    }
    best = Math.max(best, qi / quote.length);
    if (best === 1) break;
  }
  return best;
}

function matchQuote(quote: string, hit: SearchHit | undefined): QuoteMatch {
  if (!hit) return 'not-found';
  // Very short quotes prove nothing.
  if (words(quote).length < 3) return 'not-found';
  if (normalize(hit.text).includes(normalize(quote))) return 'exact';
  return inOrderCoverage(words(quote), words(hit.text)) >= 0.85 ? 'approximate' : 'not-found';
}

const OPEN_QUOTES: Record<string, string> = { '«': '»', '“': '”', '„': '“' };

/**
 * Top-level quoted strings of a line. Quotes nest — a book quote is often
 * «… по кличке «Сектоид».» — so «…» / “…” are matched by depth; straight
 * "…" pair up only at the top level.
 */
function extractQuoted(line: string): string[] {
  const found: string[] = [];
  const stack: string[] = [];
  let start = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (stack.length && ch === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) found.push(line.slice(start, i));
    } else if (OPEN_QUOTES[ch]) {
      if (!stack.length) start = i + 1;
      stack.push(OPEN_QUOTES[ch]);
    } else if (ch === '"' && !stack.length) {
      start = i + 1;
      stack.push('"');
    }
  }
  return found.map((q) => q.replace(/\s+/g, ' ').trim()).filter((q) => q.length >= 3);
}

const ELISION = /\s*(?:\[\s*(?:\.{3}|…)\s*\]|\(\s*(?:\.{3}|…)\s*\)|\.{3}|…)\s*/;

/** Finds which excerpt holds the quote (the cited one first) and how closely. */
function locateQuote(text: string, cited: number, hits: SearchHit[]): { n: number; match: QuoteMatch } {
  const order = [cited - 1, ...hits.map((_, i) => i).filter((i) => i !== cited - 1)];
  for (const i of order) {
    const match = matchQuote(text, hits[i]);
    // The quote may be real but attributed to the wrong excerpt.
    if (match !== 'not-found') return { n: i + 1, match };
  }
  return { n: cited, match: 'not-found' };
}

/**
 * A quote "A […] B" joins verbatim pieces of one excerpt: every piece must be
 * found, and the whole counts as approximate at best — it isn't one verbatim run.
 */
function checkQuote(text: string, cited: number, hits: SearchHit[]): GroundedQuote {
  const pieces = text.split(ELISION).filter((p) => words(p).length >= 3);
  if (pieces.length > 1) {
    const located = pieces.map((p) => locateQuote(p, cited, hits));
    const n = located[0].n;
    const ok = located.every((l) => l.match !== 'not-found' && l.n === n);
    return { n, text, match: ok ? 'approximate' : 'not-found', chunk_id: ok ? hits[n - 1]?.metadata.chunk_id : undefined };
  }
  const { n, match } = locateQuote(text, cited, hits);
  return { n, text, match, chunk_id: match !== 'not-found' ? hits[n - 1]?.metadata.chunk_id : undefined };
}

function section(content: string, label: string, next: string[]): string | undefined {
  const re = new RegExp(`(?:^|\\n)\\s*${label}\\s*:?\\s*([\\s\\S]*?)(?=\\n\\s*(?:${next.join('|')})\\s*:|$)`, 'i');
  return re.exec(content)?.[1]?.trim();
}

function toSource(n: number, hit: SearchHit): GroundedSource {
  return {
    n,
    chunk_id: hit.metadata.chunk_id,
    source: hit.metadata.source,
    title: hit.metadata.title,
    section: hit.metadata.section,
    file: hit.metadata.file,
  };
}

/** Parses the model's reply in GROUNDED_FORMAT and checks it against the excerpts it was given. */
export function groundAnswer(reply: string, hits: SearchHit[]): Grounding {
  // Markdown emphasis around the labels ("**ОТВЕТ:**") is noise for parsing.
  const content = reply.replace(/\*\*/g, '');
  const dontKnow = /(?:^|\n)\s*НЕ ЗНАЮ\s*:?\s*([\s\S]*)/i.exec(content);
  const answerPart = section(content, 'ОТВЕТ', ['ИСТОЧНИКИ', 'ЦИТАТЫ']);
  if (dontKnow && !answerPart) {
    // The rule: "не знаю" is said explicitly and comes with a request to clarify.
    let text = dontKnow[1].trim();
    if (!/уточн/i.test(text)) text += `${text ? ' ' : ''}Уточните, пожалуйста, вопрос.`;
    return { status: 'unknown', reason: 'model', answer: `Не знаю: ${text}`, sources: [], quotes: [], invalidRefs: [] };
  }
  const answer = answerPart ?? content.split(/\n\s*(?:ИСТОЧНИКИ|ЦИТАТЫ)/i)[0].trim();
  const sourcesPart = section(content, 'ИСТОЧНИКИ', ['ЦИТАТЫ', 'ОТВЕТ']) ?? '';
  const quotesPart = section(content, 'ЦИТАТЫ', ['ИСТОЧНИКИ', 'ОТВЕТ']) ?? '';

  const quotes: GroundedQuote[] = [];
  let lastRef = 0;
  for (const line of quotesPart.split('\n')) {
    // "[n] «…»", several «…» after one [n], or a «…» continuing the previous [n].
    const ref = /^\s*\[(\d+)\]/.exec(line);
    if (ref) lastRef = Number(ref[1]);
    if (!lastRef) continue;
    for (const text of extractQuoted(line)) quotes.push(checkQuote(text, lastRef, hits));
  }

  // Sources: excerpts holding a confirmed quote, plus those the answer text cites.
  // An excerpt only listed under ИСТОЧНИКИ, with nothing from it quoted or
  // cited, is not shown as a source — nothing backs it.
  const listed = [...sourcesPart.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
  const backed = [
    ...[...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])),
    ...quotes.filter((q) => q.match !== 'not-found').map((q) => q.n),
  ];
  const valid = [...new Set(backed)].filter((n) => n >= 1 && n <= hits.length).sort((a, b) => a - b);
  const invalidRefs = [...new Set([...listed, ...backed].filter((n) => n < 1 || n > hits.length))];
  const sources = valid.map((n) => toSource(n, hits[n - 1]));

  const confirmed = quotes.filter((q) => q.match !== 'not-found');
  if (!confirmed.length) {
    return {
      status: 'unknown',
      reason: 'unverified',
      answer:
        'Не знаю: ответ не удалось подтвердить цитатами из найденных фрагментов. ' +
        'Уточните, пожалуйста, вопрос — о каком персонаже, эпизоде или главе речь.',
      sources,
      quotes,
      invalidRefs,
      rejectedAnswer: answer,
    };
  }
  return { status: 'answered', answer: answer.replace(/\s+\[\d+\](?:\s*,\s*\[\d+\])*\s*$/, '').trim() || answer, sources, quotes, invalidRefs };
}

/** "Не знаю" without asking the LLM: nothing relevant enough was found. */
export function lowRelevanceAnswer(candidates: (SearchHit & { rerankScore?: number })[], threshold: number): Grounding {
  const relevance = (c: SearchHit & { rerankScore?: number }) => c.rerankScore ?? c.score;
  const byRelevance = [...candidates].sort((a, b) => relevance(b) - relevance(a));
  const best = byRelevance.length ? relevance(byRelevance[0]) : 0;
  const nearest = [...new Set(byRelevance.slice(0, 3).map((c) => c.metadata.section.split(' › ').pop() || c.metadata.file))];
  const answer = candidates.length
    ? `Не знаю: в документах не нашлось фрагментов, достаточно близких к вопросу (лучшая релевантность ${best.toFixed(2)} при пороге ${threshold}). ` +
      `Уточните, пожалуйста, вопрос — назовите персонажа, место или событие, о котором речь, или переформулируйте его. ` +
      `Ближе всего по смыслу (но без ответа): ${nearest.map((s) => `«${s.replace(/\.$/, '')}»`).join(', ')}.`
    : 'Не знаю: в индексе нет документов, по которым можно ответить. Добавьте документы или уточните вопрос.';
  return {
    status: 'unknown',
    reason: 'low-relevance',
    answer,
    sources: [],
    quotes: [],
    invalidRefs: [],
    topScore: Math.round(best * 1e4) / 1e4,
    threshold,
  };
}

/** Human-readable form of a grounded answer — what the chat shows and keeps in history. */
export function renderGrounding(g: Grounding): string {
  if (g.status === 'unknown') return g.answer;
  const lines = [g.answer, '', 'Источники:'];
  for (const s of g.sources) lines.push(`[${s.n}] ${s.title} › ${s.section.split(' › ').slice(-2).join(' › ') || s.file} (${s.chunk_id})`);
  const confirmed = g.quotes.filter((q) => q.match !== 'not-found');
  if (confirmed.length) {
    lines.push('', 'Цитаты:');
    for (const q of confirmed) lines.push(`[${q.n}] «${q.text}»`);
  }
  return lines.join('\n');
}
