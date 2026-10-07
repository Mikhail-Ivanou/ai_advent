import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { answerQuestion } from './rag-answer';
import {
  avg,
  ControlQuestion,
  flag,
  ModeResult,
  oneLine,
  QuestionSet,
  score,
  Support,
  SUPPORT_MARK,
  Verdict,
  VERDICT_MARK,
} from './rag-eval-scoring';
import { PipelineConfig } from './rag-pipeline';
import { RagService } from './rag.service';

// Control questions over the indexed book, answered without RAG and with
// RAG in several retrieval modes, then scored (Day 22, modes — Day 23):
// - retrieval: is the passage that holds the answer in what the LLM got,
//   at which rank; how many chunks went in (top-K after) out of how many
//   candidates (top-K before); for "negative" questions (no answer in the
//   book) the ideal is that the filter leaves nothing;
// - facts: how many of the key facts the answer contains (literal stems);
// - judge: an LLM compares the answer with the expected one —
//   correct / partial / wrong, and whether it invents facts;
// - citations: does the answer cite [n] of a chunk holding the answer;
// - grounding (Day 24): does the answer come with sources and with quotes
//   confirmed in the excerpts, and does an LLM — shown only the answer and
//   the quotes — find the answer supported by them; "не знаю" answers and
//   their reason (weak context / the model / unconfirmed quotes).
//
// npm run rag-eval --workspace=backend -- [--modes baseline,ce,llm] [--questions file.json]
//   [--model deepseek-v4-flash] [--judge deepseek-v4-pro] [--only q1,n1] [--title "…"] [--report ../docs/day24-grounded.md]

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

interface QuestionResult {
  q: ControlQuestion;
  modes: Record<string, ModeResult>;
}

function renderReport(
  set: QuestionSet,
  modes: Mode[],
  results: QuestionResult[],
  cfg: { model: string; judge: string },
  title: string,
): string {
  const positive = results.filter((r) => !r.q.negative);
  const negative = results.filter((r) => r.q.negative);
  const totalFacts = positive.reduce((a, r) => a + r.q.mustInclude.length, 0);
  const of = (rs: QuestionResult[], id: string, f: (m: ModeResult) => boolean) => rs.filter((r) => f(r.modes[id])).length;

  const lines: string[] = [
    `# ${title}`,
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
    '## Источники, цитаты, «не знаю»',
    '',
    'Ответ с RAG обязан содержать источники (source + section + chunk_id из реально найденных чанков) и цитаты; каждая цитата ищется в тексте чанка, на который ссылается. ' +
      'Ответ без подтверждённой цитаты не выдаётся — вместо него «не знаю» с просьбой уточнить; при слабом контексте (ничего выше порога) LLM не вызывается. ' +
      '«Смысл совпадает с цитатами» — отдельная проверка LLM, которой показаны только ответ и цитаты.',
    '',
    `| Режим | Дан ответ | …с источниками | …с цитатами | Цитат подтверждено | Смысл совпадает с цитатами | «Не знаю» на вопросах с ответом | «Не знаю» на вопросах без ответа (из ${negative.length}) |`,
    '|---|---|---|---|---|---|---|---|',
    ...modes
      .filter((m) => m.pipeline)
      .map((m) => {
        const all = results.map((r) => r.modes[m.id]);
        const answered = all.filter((x) => x.answer.grounding?.status === 'answered');
        const quotes = all.flatMap((x) => (x.answer.grounding?.status === 'answered' ? x.answer.grounding.quotes : []));
        const confirmed = quotes.filter((x) => x.match !== 'not-found').length;
        const unknownPositive = positive.map((r) => r.modes[m.id].answer.grounding).filter((g) => g?.status === 'unknown');
        const reasons = ['low-relevance', 'model', 'unverified']
          .map((reason) => [reason, unknownPositive.filter((g) => g!.reason === reason).length] as const)
          .filter(([, n]) => n)
          .map(([reason, n]) => `${reason}: ${n}`)
          .join(', ');
        return `| ${m.id} | ${answered.length}/${all.length} | ${answered.filter((x) => x.answer.grounding!.sources.length).length}/${answered.length} | ${answered.filter((x) => x.answer.grounding!.quotes.some((y) => y.match !== 'not-found')).length}/${answered.length} | ${confirmed}/${quotes.length} (точно ${quotes.filter((x) => x.match === 'exact').length}) | ${answered.filter((x) => x.support === 'supported').length} да, ${answered.filter((x) => x.support === 'partial').length} частично, ${answered.filter((x) => x.support === 'unsupported').length} нет | ${unknownPositive.length}${reasons ? ` (${reasons})` : ''} | ${of(negative, m.id, (x) => x.answer.grounding?.status === 'unknown')} |`;
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
        const g = x.answer.grounding;
        const grounded = !g ? '' : g.status === 'unknown' ? ' · не знаю' : ` · цит. ${g.quotes.filter((y) => y.match !== 'not-found').length}/${g.quotes.length}${x.support ? ` ${SUPPORT_MARK[x.support]}` : ''}`;
        return `${VERDICT_MARK[x.judgement.verdict]}${rank}${grounded}`;
      });
      return `| ${r.q.id} | ${r.q.question} | ${cells.join(' | ')} |`;
    }),
    '',
    'В ячейке: вердикт судьи · ранг фрагмента с ответом в контексте LLM (— нет в контексте; для вопросов без ответа — сколько фрагментов прошло фильтр) · подтверждённых цитат из приведённых и согласие ответа с ними (✔ да, ½ частично, ✘ нет) или «не знаю».',
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
        ...x.answer.answer.split('\n').map((l) => `> ${l}`),
      );
      const g = x.answer.grounding;
      const bad = g?.quotes.filter((y) => y.match === 'not-found') ?? [];
      if (g?.status === 'answered' || bad.length) {
        lines.push(
          '',
          `Проверка: источников ${g!.sources.length}, цитат подтверждено ${g!.quotes.length - bad.length}/${g!.quotes.length}` +
            (x.support ? `, смысл ответа и цитат: ${x.support}` : '') +
            (bad.length ? `; не найдены в тексте: ${bad.map((y) => `[${y.n}] «${y.text}»`).join('; ')}` : '') +
            (g!.rejectedAnswer ? `; отклонённый ответ модели: «${oneLine(g!.rejectedAnswer)}»` : ''),
        );
      }
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

  const title = flag(args, 'title') ?? 'RAG: режимы поиска, источники и цитаты';
  const report = renderReport(set, modes, results, { model, judge: judgeModel }, title);
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
