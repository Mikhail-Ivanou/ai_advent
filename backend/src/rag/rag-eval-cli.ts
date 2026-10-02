import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { callLlm } from '../llm/llm.client';
import { answerQuestion, RagAnswer } from './rag-answer';
import { RagService } from './rag.service';
import { ChunkingStrategy, SearchHit, SearchMode } from './rag.types';

// Day 22: control questions over the indexed book, each answered without and
// with RAG, then scored:
// - retrieval: is the passage that holds the answer among the retrieved
//   chunks (and at which rank), is the right chapter there;
// - facts: how many of the key facts the answer contains (literal stems);
// - judge: an LLM compares the answer with the expected one —
//   correct / partial / wrong, and whether it invents facts;
// - citations: does the RAG answer cite [n] of a chunk holding the answer.
//
// npm run rag-eval --workspace=backend -- [--questions file.json] [--strategy structural] [--search hybrid|vector] [--k 5]
//   [--model deepseek-v4-flash] [--judge deepseek-v4-pro] [--only q1,q2] [--report ../docs/day22-rag-eval.md]

interface ControlQuestion {
  id: string;
  question: string;
  /** What a correct answer must say. */
  expected: string;
  /** Stems of the key facts, matched case-insensitively in the answer; "a|b" accepts either. */
  mustInclude: string[];
  /** Where the answer is in the book: the chapter, and a verbatim quote of the passage. */
  sources: { chapter: string; quote: string }[];
}

interface QuestionSet {
  document: string;
  /** Prepended to every question in both modes, so the model without RAG knows which book is meant. */
  prefix: string;
  questions: ControlQuestion[];
}

type Verdict = 'correct' | 'partial' | 'wrong';

interface Judgement {
  verdict: Verdict;
  hallucination: boolean;
  comment: string;
}

interface Scored {
  answer: RagAnswer;
  facts: number;
  judgement: Judgement;
  /** RAG only: cited [n] numbers, and whether one of them is a chunk with the answer. */
  cited?: number[];
  citedSource?: boolean;
}

interface QuestionResult {
  q: ControlQuestion;
  retrieval: { quoteRank: number; chapterRank: number; hits: SearchHit[] };
  plain: Scored;
  rag: Scored;
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
    'correct — ответ содержит суть эталона и не противоречит ему; partial — верна только часть; wrong — неверно, не по существу или модель отказалась отвечать.',
    'hallucination — ответ уверенно утверждает конкретные факты (имена, места, числа), которых нет в эталоне и которые ему противоречат или выдуманы.',
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

async function score(q: ControlQuestion, answer: RagAnswer, judgeModel: string): Promise<Scored> {
  const text = norm(answer.answer);
  // A key fact may list alternative spellings: "сорок тысяч|40 000".
  const facts = q.mustInclude.filter((f) => f.split('|').some((alt) => text.includes(norm(alt)))).length;
  const judgement = await judge(q, answer.answer, judgeModel);
  if (answer.mode === 'plain') return { answer, facts, judgement };
  const cited = [...new Set([...answer.answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))].filter(
    (n) => n >= 1 && n <= answer.hits.length,
  );
  const citedSource = cited.some((n) => q.sources.some((s) => holdsQuote(answer.hits[n - 1], s.quote)));
  return { answer, facts, judgement, cited, citedSource };
}

const VERDICT_MARK: Record<Verdict, string> = { correct: '✅', partial: '🟡', wrong: '❌' };
const pct = (n: number, total: number) => `${Math.round((n / Math.max(1, total)) * 100)}%`;
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

function renderReport(set: QuestionSet, results: QuestionResult[], cfg: { strategy: ChunkingStrategy; k: number; search: SearchMode; model: string; judge: string }): string {
  const n = results.length;
  const count = (f: (r: QuestionResult) => boolean) => results.filter(f).length;
  const sum = (f: (r: QuestionResult) => number) => results.reduce((a, r) => a + f(r), 0);
  const totalFacts = sum((r) => r.q.mustInclude.length);
  const modeRow = (label: string, pick: (r: QuestionResult) => Scored) => [
    label,
    `${count((r) => pick(r).judgement.verdict === 'correct')}/${n}`,
    `${count((r) => pick(r).judgement.verdict === 'partial')}/${n}`,
    `${count((r) => pick(r).judgement.verdict === 'wrong')}/${n}`,
    `${pct(sum((r) => pick(r).facts), totalFacts)} (${sum((r) => pick(r).facts)}/${totalFacts})`,
    `${count((r) => pick(r).judgement.hallucination)}/${n}`,
    `${(sum((r) => pick(r).answer.durationMs) / n / 1000).toFixed(1)} с`,
    `${sum((r) => pick(r).answer.usage?.totalTokens ?? 0)}`,
  ];
  const lines: string[] = [
    `# RAG: сравнение ответов без RAG и с RAG`,
    '',
    `Документ: ${set.document}. Модель ответов: \`${cfg.model}\`, судья: \`${cfg.judge}\`. ` +
      `RAG: стратегия \`${cfg.strategy}\`, поиск \`${cfg.search}\`, top-${cfg.k}. Каждый вопрос задаётся с префиксом «${set.prefix.trim()}».`,
    '',
    '## Итог',
    '',
    '| Режим | Верно | Частично | Неверно | Ключевые факты | Выдумки | Время ответа (сред.) | Токенов всего |',
    '|---|---|---|---|---|---|---|---|',
    `| ${modeRow('Без RAG', (r) => r.plain).join(' | ')} |`,
    `| ${modeRow('С RAG', (r) => r.rag).join(' | ')} |`,
    '',
    `Поиск: нужный фрагмент найден в top-${cfg.k} — ${count((r) => r.retrieval.quoteRank > 0)}/${n} ` +
      `(на 1-м месте — ${count((r) => r.retrieval.quoteRank === 1)}), нужная глава в top-${cfg.k} — ${count((r) => r.retrieval.chapterRank > 0)}/${n}. ` +
      `Ответ с RAG ссылается [n] на фрагмент с ответом — ${count((r) => !!r.rag.citedSource)}/${n}.`,
    '',
    '| # | Вопрос | Фрагмент (ранг) | Без RAG | С RAG | Факты без / с |',
    '|---|---|---|---|---|---|',
    ...results.map((r) => {
      const ok = (s: Scored) => `${VERDICT_MARK[s.judgement.verdict]}${s.judgement.hallucination ? ' выдумка' : ''}`;
      return `| ${r.q.id} | ${r.q.question} | ${r.retrieval.quoteRank || '—'} | ${ok(r.plain)} | ${ok(r.rag)} | ${r.plain.facts}/${r.q.mustInclude.length} · ${r.rag.facts}/${r.q.mustInclude.length} |`;
    }),
    '',
    '## Вопросы и ответы',
  ];
  for (const r of results) {
    const s = r.q.sources[0];
    lines.push(
      '',
      `### ${r.q.id}. ${r.q.question}`,
      '',
      `**Ожидание:** ${r.q.expected}`,
      '',
      `**Ключевые факты:** ${r.q.mustInclude.map((f) => `«${f.replace(/\|/g, '» / «')}»`).join(', ')}`,
      '',
      `**Источник:** ${r.q.sources.map((x) => x.chapter).join('; ')} — «${s.quote}»`,
      '',
      `**Поиск (top-${cfg.k}):** ` +
        r.retrieval.hits
          .map((h, i) => {
            const mark = r.q.sources.some((x) => holdsQuote(h, x.quote)) ? ' ← ответ' : '';
            return `[${i + 1}] ${h.score.toFixed(3)} ${h.metadata.section.split(' › ').pop()}${h.metadata.part ? ` (ч. ${h.metadata.part})` : ''}${mark}`;
          })
          .join('; '),
      '',
      `**Без RAG** — ${VERDICT_MARK[r.plain.judgement.verdict]} ${r.plain.judgement.verdict}${r.plain.judgement.hallucination ? ', выдумка' : ''}, факты ${r.plain.facts}/${r.q.mustInclude.length}. Судья: ${r.plain.judgement.comment}`,
      '',
      `> ${oneLine(r.plain.answer.answer)}`,
      '',
      `**С RAG** — ${VERDICT_MARK[r.rag.judgement.verdict]} ${r.rag.judgement.verdict}${r.rag.judgement.hallucination ? ', выдумка' : ''}, факты ${r.rag.facts}/${r.q.mustInclude.length}, ссылки ${r.rag.cited?.length ? r.rag.cited.map((c) => `[${c}]`).join('') : 'нет'}${r.rag.citedSource ? ' (на фрагмент с ответом)' : ''}. Судья: ${r.rag.judgement.comment}`,
      '',
      `> ${oneLine(r.rag.answer.answer)}`,
    );
  }
  return lines.join('\n') + '\n';
}

async function main() {
  const args = process.argv.slice(2);
  const file = path.resolve(flag(args, 'questions') ?? path.join(__dirname, 'eval/ufo-questions.json'));
  const set = JSON.parse(fs.readFileSync(file, 'utf8')) as QuestionSet;
  const cfg = {
    strategy: (flag(args, 'strategy') === 'fixed' ? 'fixed' : 'structural') as ChunkingStrategy,
    k: Number(flag(args, 'k')) || 5,
    search: (flag(args, 'search') === 'vector' ? 'vector' : 'hybrid') as SearchMode,
    model: flag(args, 'model') ?? process.env.LLM_MODEL ?? 'deepseek-v4-flash',
    judge: flag(args, 'judge') ?? 'deepseek-v4-pro',
  };
  const only = flag(args, 'only')?.split(',');
  const questions = set.questions.filter((q) => !only || only.includes(q.id));
  const rag = new RagService();
  const results: QuestionResult[] = [];

  for (const q of questions) {
    const asked = `${set.prefix}${q.question}`;
    // Both modes get the same question at temperature 0; the only difference is the retrieved context.
    const [plain, withRag] = await Promise.all([
      answerQuestion(rag, asked, 'plain', { model: cfg.model, temperature: 0 }),
      // The book-name prefix is for the LLM; searching with it would only blur the query embedding.
      answerQuestion(rag, asked, 'rag', { model: cfg.model, temperature: 0, strategy: cfg.strategy, k: cfg.k, search: cfg.search, searchQuery: q.question }),
    ]);
    const hits = withRag.hits;
    const retrieval = {
      hits,
      quoteRank: firstRank(hits, (h) => q.sources.some((s) => holdsQuote(h, s.quote))),
      chapterRank: firstRank(hits, (h) => q.sources.some((s) => norm(h.metadata.section).includes(norm(s.chapter)))),
    };
    const [plainScored, ragScored] = await Promise.all([score(q, plain, cfg.judge), score(q, withRag, cfg.judge)]);
    results.push({ q, retrieval, plain: plainScored, rag: ragScored });
    console.log(
      `${q.id}: фрагмент ${retrieval.quoteRank || '—'} · без RAG ${VERDICT_MARK[plainScored.judgement.verdict]} ${plainScored.facts}/${q.mustInclude.length}` +
        ` · с RAG ${VERDICT_MARK[ragScored.judgement.verdict]} ${ragScored.facts}/${q.mustInclude.length}${ragScored.citedSource ? ' [ссылка]' : ''}`,
    );
  }

  const report = renderReport(set, results, cfg);
  const out = flag(args, 'report');
  if (out) {
    const target = path.resolve(process.cwd(), out);
    fs.writeFileSync(target, report);
    console.log(`\nОтчёт: ${target}`);
  } else {
    console.log(`\n${report.split('## Вопросы и ответы')[0]}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
