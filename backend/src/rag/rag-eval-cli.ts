import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { callLlm } from '../llm/llm.client';
import { answerQuestion, RagAnswer } from './rag-answer';
import { PipelineConfig } from './rag-pipeline';
import { RagService } from './rag.service';
import { SearchHit } from './rag.types';

// Control questions over the indexed book, answered without RAG and with
// RAG in several retrieval modes, then scored (Day 22, modes — Day 23):
// - retrieval: is the passage that holds the answer in what the LLM got,
//   at which rank; how many chunks went in (top-K after) out of how many
//   candidates (top-K before); for "negative" questions (no answer in the
//   book) the ideal is that the filter leaves nothing;
// - facts: how many of the key facts the answer contains (literal stems);
// - judge: an LLM compares the answer with the expected one —
//   correct / partial / wrong, and whether it invents facts;
// - citations: does the answer cite [n] of a chunk holding the answer.
//
// npm run rag-eval --workspace=backend -- [--modes baseline,ce,llm] [--questions file.json]
//   [--model deepseek-v4-flash] [--judge deepseek-v4-pro] [--only q1,n1] [--report ../docs/day23-rag-modes.md]

interface ControlQuestion {
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

interface QuestionSet {
  document: string;
  /** Prepended to every question sent to the LLM, so the model without RAG knows which book is meant. Not used for search. */
  prefix: string;
  questions: ControlQuestion[];
}

interface Mode {
  id: string;
  label: string;
  /** undefined = no RAG at all. */
  pipeline?: Partial<PipelineConfig>;
}

// Thresholds are calibrated on this book: cross-encoder relevance of the best
// chunk is ≤ 0.12 for off-topic questions and ≥ 0.24 for answerable ones;
// the LLM reranker gives 0 / 0.5 ("on topic, no answer") / 1.
const MODES: Mode[] = [
  { id: 'plain', label: 'Без RAG' },
  { id: 'baseline', label: 'RAG: поиск top-5, без фильтра', pipeline: { search: 'hybrid', k: 5 } },
  { id: 'cosine', label: 'RAG: top-5, порог cosine ≥ 0.82', pipeline: { search: 'hybrid', k: 5, minScore: 0.82 } },
  { id: 'ce', label: 'RAG: 20 → cross-encoder → порог 0.2 → top-5', pipeline: { search: 'hybrid', rerank: 'cross-encoder', candidates: 20, k: 5, minScore: 0.2 } },
  { id: 'rewrite-ce', label: 'RAG: rewrite + 20 → cross-encoder → 0.2 → top-5', pipeline: { search: 'hybrid', rewrite: true, rerank: 'cross-encoder', candidates: 20, k: 5, minScore: 0.2 } },
  { id: 'llm', label: 'RAG: 20 → LLM-реранкер → порог 0.6 → top-5', pipeline: { search: 'hybrid', rerank: 'llm', candidates: 20, k: 5, minScore: 0.6 } },
  { id: 'rewrite-llm', label: 'RAG: rewrite + 20 → LLM-реранкер → 0.6 → top-5', pipeline: { search: 'hybrid', rewrite: true, rerank: 'llm', candidates: 20, k: 5, minScore: 0.6 } },
];

type Verdict = 'correct' | 'partial' | 'wrong';

interface Judgement {
  verdict: Verdict;
  hallucination: boolean;
  comment: string;
}

interface ModeResult {
  answer: RagAnswer;
  facts: number;
  judgement: Judgement;
  /** Rank of the first chunk holding the answer among the chunks given to the LLM (0 = not there). */
  sourceRank: number;
  /** Same, among the first-stage candidates (before reranking/filtering). */
  candidateRank: number;
  citedSource: boolean;
}

interface QuestionResult {
  q: ControlQuestion;
  modes: Record<string, ModeResult>;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[«»"“”„]/g, '').replace(/\s+/g, ' ');

/** A chunk holds the answer when it contains the start of the source quote (chunk borders may cut the rest). */
function holdsQuote(hit: SearchHit, quote: string): boolean {
  const probe = norm(quote).replace(/[–—-]\s*/g, '').slice(0, 50).trim();
  return norm(hit.text).replace(/[–—-]\s*/g, '').includes(probe);
}

const holdsAnswer = (q: ControlQuestion) => (h: SearchHit) => q.sources.some((s) => holdsQuote(h, s.quote));

function firstRank(hits: SearchHit[], pred: (h: SearchHit) => boolean): number {
  const i = hits.findIndex(pred);
  return i < 0 ? 0 : i + 1;
}

async function judge(q: ControlQuestion, answer: string, model: string): Promise<Judgement> {
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

async function score(q: ControlQuestion, answer: RagAnswer, judgeModel: string): Promise<ModeResult> {
  const text = norm(answer.answer);
  // A key fact may list alternative spellings: "сорок тысяч|40 000".
  const facts = q.mustInclude.filter((f) => f.split('|').some((alt) => text.includes(norm(alt)))).length;
  const judgement = await judge(q, answer.answer, judgeModel);
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
  };
}

const VERDICT_MARK: Record<Verdict, string> = { correct: '✅', partial: '🟡', wrong: '❌' };
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function renderReport(set: QuestionSet, modes: Mode[], results: QuestionResult[], cfg: { model: string; judge: string }): string {
  const positive = results.filter((r) => !r.q.negative);
  const negative = results.filter((r) => r.q.negative);
  const totalFacts = positive.reduce((a, r) => a + r.q.mustInclude.length, 0);
  const of = (rs: QuestionResult[], id: string, f: (m: ModeResult) => boolean) => rs.filter((r) => f(r.modes[id])).length;

  const lines: string[] = [
    '# RAG: режимы поиска — фильтрация, реранкинг, query rewrite',
    '',
    `Документ: ${set.document}. Модель ответов: \`${cfg.model}\`, судья: \`${cfg.judge}\`. ` +
      `Поиск — гибридный (векторы + BM25), чанкинг по структуре. ${positive.length} контрольных вопросов с ответом в книге ` +
      `и ${negative.length} — без ответа в книге (правильно: сказать, что в документах этого нет). ` +
      `Каждый вопрос уходит в LLM с префиксом «${set.prefix.trim()}»; поиск — по самому вопросу.`,
    '',
    '## Режимы',
    '',
    ...modes.map((m) => `- **${m.id}** — ${m.label}`),
    '',
    '## Качество ответов',
    '',
    `| Режим | Верно (из ${positive.length}) | Частично | Неверно | Ключевые факты | Выдумки | Без ответа в книге: верно (из ${negative.length}) |`,
    '|---|---|---|---|---|---|---|',
    ...modes.map((m) => {
      const facts = positive.reduce((a, r) => a + r.modes[m.id].facts, 0);
      return `| ${m.id} | ${of(positive, m.id, (x) => x.judgement.verdict === 'correct')} | ${of(positive, m.id, (x) => x.judgement.verdict === 'partial')} | ${of(positive, m.id, (x) => x.judgement.verdict === 'wrong')} | ${Math.round((facts / Math.max(1, totalFacts)) * 100)}% | ${of(results, m.id, (x) => x.judgement.hallucination)} | ${of(negative, m.id, (x) => x.judgement.verdict === 'correct')} |`;
    }),
    '',
    '## Поиск и фильтрация',
    '',
    '«Фрагмент с ответом» — чанк, содержащий цитату-источник вопроса. top-K до — кандидатов из поиска, top-K после — ушло в LLM.',
    '',
    `| Режим | Фрагмент с ответом в контексте (из ${positive.length}) | …на 1-м месте | Ссылка [n] на него | top-K до → после (сред.) | Отсечено порогом (сред.) | Пусто для вопросов без ответа (из ${negative.length}) | Токенов на вопрос | Время (сред.) |`,
    '|---|---|---|---|---|---|---|---|---|',
    ...modes
      .filter((m) => m.pipeline)
      .map((m) => {
        const all = results.map((r) => r.modes[m.id]);
        const before = avg(all.map((x) => x.answer.pipeline?.candidates.length ?? 0));
        const after = avg(all.map((x) => x.answer.hits.length));
        return `| ${m.id} | ${of(positive, m.id, (x) => x.sourceRank > 0)} | ${of(positive, m.id, (x) => x.sourceRank === 1)} | ${of(positive, m.id, (x) => x.citedSource)} | ${before.toFixed(1)} → ${after.toFixed(1)} | ${avg(all.map((x) => x.answer.pipeline?.filteredOut ?? 0)).toFixed(1)} | ${of(negative, m.id, (x) => x.answer.hits.length === 0)} | ${Math.round(avg(all.map((x) => x.answer.usage?.totalTokens ?? 0)))} | ${(avg(all.map((x) => x.answer.durationMs)) / 1000).toFixed(1)} с |`;
      }),
    '',
    '## По вопросам',
    '',
    `| # | Вопрос | ${modes.map((m) => m.id).join(' | ')} |`,
    `|---|---|${modes.map(() => '---').join('|')}|`,
    ...results.map((r) => {
      const cells = modes.map((m) => {
        const x = r.modes[m.id];
        const rank = m.pipeline ? (r.q.negative ? ` · ${x.answer.hits.length} фр.` : ` · ${x.sourceRank || '—'}`) : '';
        return `${VERDICT_MARK[x.judgement.verdict]}${rank}`;
      });
      return `| ${r.q.id} | ${r.q.question} | ${cells.join(' | ')} |`;
    }),
    '',
    'В ячейке: вердикт судьи · ранг фрагмента с ответом в контексте LLM (— нет в контексте); для вопросов без ответа — сколько фрагментов прошло фильтр.',
    '',
    '## Вопросы и ответы',
  ];
  for (const r of results) {
    lines.push('', `### ${r.q.id}. ${r.q.question}`, '', `**Ожидание:** ${r.q.expected}`);
    if (r.q.mustInclude.length) lines.push('', `**Ключевые факты:** ${r.q.mustInclude.map((f) => `«${f.replace(/\|/g, '» / «')}»`).join(', ')}`);
    if (r.q.sources.length) lines.push('', `**Источник:** ${r.q.sources.map((x) => x.chapter).join('; ')} — «${r.q.sources[0].quote}»`);
    for (const m of modes) {
      const x = r.modes[m.id];
      const p = x.answer.pipeline;
      const retrieval = p
        ? ` · кандидатов ${p.candidates.length} → в контексте ${x.answer.hits.length}` +
          (p.filteredOut ? ` (отсечено ${p.filteredOut})` : '') +
          (r.q.negative ? '' : ` · фрагмент с ответом: среди кандидатов ${x.candidateRank || '—'}, в контексте ${x.sourceRank || '—'}`) +
          (p.rewritten ? ` · запрос: «${p.rewritten}»` : '')
        : '';
      lines.push(
        '',
        `**${m.id}** — ${VERDICT_MARK[x.judgement.verdict]} ${x.judgement.verdict}${x.judgement.hallucination ? ', выдумка' : ''}` +
          (r.q.mustInclude.length ? `, факты ${x.facts}/${r.q.mustInclude.length}` : '') +
          `${retrieval}. Судья: ${x.judgement.comment}`,
        '',
        `> ${oneLine(x.answer.answer)}`,
      );
    }
  }
  return lines.join('\n') + '\n';
}

async function main() {
  const args = process.argv.slice(2);
  const file = path.resolve(flag(args, 'questions') ?? path.join(__dirname, 'eval/ufo-questions.json'));
  const set = JSON.parse(fs.readFileSync(file, 'utf8')) as QuestionSet;
  const model = flag(args, 'model') ?? process.env.LLM_MODEL ?? 'deepseek-v4-flash';
  const judgeModel = flag(args, 'judge') ?? 'deepseek-v4-pro';
  const wanted = flag(args, 'modes')?.split(',');
  const modes = MODES.filter((m) => m.id === 'plain' || !wanted || wanted.includes(m.id));
  const only = flag(args, 'only')?.split(',');
  const questions = set.questions.filter((q) => !only || only.includes(q.id));
  const rag = new RagService();
  const results: QuestionResult[] = [];

  for (const q of questions) {
    const asked = `${set.prefix}${q.question}`;
    // Every mode gets the same question at temperature 0; only the retrieved context differs.
    const answers = await Promise.all(
      modes.map((m) =>
        m.pipeline
          ? answerQuestion(rag, asked, 'rag', { ...m.pipeline, model, temperature: 0, searchQuery: q.question })
          : answerQuestion(rag, asked, 'plain', { model, temperature: 0 }),
      ),
    );
    const scored = await Promise.all(answers.map((a) => score(q, a, judgeModel)));
    const byMode = Object.fromEntries(modes.map((m, i) => [m.id, scored[i]]));
    results.push({ q, modes: byMode });
    console.log(
      `${q.id}: ` +
        modes
          .map((m) => {
            const x = byMode[m.id];
            const extra = m.pipeline ? (q.negative ? `(${x.answer.hits.length})` : `(${x.sourceRank || '—'})`) : '';
            return `${m.id} ${VERDICT_MARK[x.judgement.verdict]}${extra}`;
          })
          .join(' · '),
    );
  }

  const report = renderReport(set, modes, results, { model, judge: judgeModel });
  const out = flag(args, 'report');
  if (out) {
    const target = path.resolve(process.cwd(), out);
    fs.writeFileSync(target, report);
    console.log(`\nОтчёт: ${target}`);
  } else {
    console.log(`\n${report.split('## По вопросам')[0]}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
