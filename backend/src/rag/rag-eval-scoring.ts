import { callLlm } from '../llm/llm.client';
import { RagAnswer } from './rag-answer';
import { SearchHit } from './rag.types';

// Scoring of RAG answers against the control questions — shared by the
// mode comparison (rag-eval-cli, Days 22–24) and the model comparison
// (rag-local-cli, Day 28).

export interface ControlQuestion {
  id: string;
  question: string;
  /** No answer in the documents: the right behaviour is to say so. */
  negative?: boolean;
  /** What a correct answer must say. */
  expected: string;
  /** Stems of the key facts, matched case-insensitively in the answer; "a|b" accepts either. */
  mustInclude: string[];
  /** Where the answer is in the book: the chapter, and a verbatim quote of the passage. */
  sources: { chapter: string; quote: string }[];
}

export interface QuestionSet {
  document: string;
  /** Prepended to every question sent to the LLM, so the model without RAG knows which book is meant. Not used for search. */
  prefix: string;
  questions: ControlQuestion[];
}

export type Verdict = 'correct' | 'partial' | 'wrong';

export interface Judgement {
  verdict: Verdict;
  hallucination: boolean;
  comment: string;
}

export interface ModeResult {
  answer: RagAnswer;
  facts: number;
  judgement: Judgement;
  /** Rank of the first chunk holding the answer among the chunks given to the LLM (0 = not there). */
  sourceRank: number;
  /** Same, among the first-stage candidates (before reranking/filtering). */
  candidateRank: number;
  citedSource: boolean;
  /** RAG answers that were delivered (not "не знаю"): is the answer backed by its confirmed quotes. */
  support?: Support;
}

export type Support = 'supported' | 'partial' | 'unsupported';

export function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

export const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[«»"“”„]/g, '').replace(/\s+/g, ' ');

/** A chunk holds the answer when it contains the start of the source quote (chunk borders may cut the rest). */
export function holdsQuote(hit: SearchHit, quote: string): boolean {
  const probe = norm(quote).replace(/[–—-]\s*/g, '').slice(0, 50).trim();
  return norm(hit.text).replace(/[–—-]\s*/g, '').includes(probe);
}

export const holdsAnswer = (q: ControlQuestion) => (h: SearchHit) => q.sources.some((s) => holdsQuote(h, s.quote));

export function firstRank(hits: SearchHit[], pred: (h: SearchHit) => boolean): number {
  const i = hits.findIndex(pred);
  return i < 0 ? 0 : i + 1;
}

export async function judge(q: ControlQuestion, answer: string, model: string): Promise<Judgement> {
  const prompt = [
    'Ты проверяешь ответ на вопрос по книге. Сравни ответ с эталоном.',
    `Вопрос: ${q.question}`,
    `Эталон: ${q.expected}`,
    `Ответ: ${answer}`,
    'Верни JSON: {"verdict": "correct" | "partial" | "wrong", "hallucination": true|false, "comment": "одно предложение"}.',
    'correct — ответ содержит суть эталона и не противоречит ему; partial — верна только часть; wrong — неверно, не по существу или модель отказалась отвечать, хотя ответ есть.',
    'Если по эталону ответа в книге нет: correct — ответ ясно говорит, что в книге/документах этого нет (допустимы общие знания с явной пометкой); wrong — ответ выдаёт что-то за содержание книги.',
    'hallucination — ответ уверенно приписывает книге конкретные факты (имена, места, числа), которых нет в эталоне и которые ему противоречат или выдуманы.',
  ].join('\n');
  const result = await callLlm(prompt, { format: 'json', temperature: 0, model }, 'rag-eval:judge');
  try {
    const parsed = JSON.parse(result.content);
    const verdict: Verdict = ['correct', 'partial', 'wrong'].includes(parsed.verdict) ? parsed.verdict : 'wrong';
    return { verdict, hallucination: !!parsed.hallucination, comment: String(parsed.comment ?? '') };
  } catch {
    return { verdict: 'wrong', hallucination: false, comment: `judge returned non-JSON: ${result.content.slice(0, 100)}` };
  }
}

/** Is the answer backed by the quotes alone? The checker sees no book and no expected answer. */
export async function checkSupport(answer: string, quotes: string[], model: string): Promise<Support> {
  const prompt = [
    'Проверь, следует ли ответ из цитат. Других знаний не используй — только цитаты.',
    `Ответ: ${answer}`,
    'Цитаты:',
    ...quotes.map((q, i) => `${i + 1}. «${q}»`),
    'Верни JSON {"support": "supported" | "partial" | "unsupported"}: supported — всё утверждаемое в ответе есть в цитатах; partial — часть утверждений цитатами не подтверждена; unsupported — цитаты ответ не подтверждают.',
  ].join('\n');
  const result = await callLlm(prompt, { format: 'json', temperature: 0, model }, 'rag-eval:support');
  try {
    const v = JSON.parse(result.content).support;
    return ['supported', 'partial', 'unsupported'].includes(v) ? v : 'unsupported';
  } catch {
    return 'unsupported';
  }
}

export async function score(q: ControlQuestion, answer: RagAnswer, judgeModel: string): Promise<ModeResult> {
  const text = norm(answer.answer);
  // A key fact may list alternative spellings: "сорок тысяч|40 000".
  const facts = q.mustInclude.filter((f) => f.split('|').some((alt) => text.includes(norm(alt)))).length;
  const g = answer.grounding;
  const confirmedQuotes = g?.quotes.filter((x) => x.match !== 'not-found').map((x) => x.text) ?? [];
  const [judgement, support] = await Promise.all([
    judge(q, answer.answer, judgeModel),
    g?.status === 'answered' && confirmedQuotes.length ? checkSupport(g.answer, confirmedQuotes, judgeModel) : undefined,
  ]);
  const isSource = holdsAnswer(q);
  const cited = [...new Set([...answer.answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))].filter(
    (n) => n >= 1 && n <= answer.hits.length,
  );
  return {
    answer,
    facts,
    judgement,
    sourceRank: firstRank(answer.hits, isSource),
    candidateRank: firstRank(answer.pipeline?.candidates ?? [], isSource),
    citedSource: cited.some((n) => isSource(answer.hits[n - 1])),
    support,
  };
}

export const VERDICT_MARK: Record<Verdict, string> = { correct: '✅', partial: '🟡', wrong: '❌' };
export const SUPPORT_MARK: Record<Support, string> = { supported: '✔', partial: '½', unsupported: '✘' };
export const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
export const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
