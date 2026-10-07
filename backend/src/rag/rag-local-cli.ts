import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { callLlm, isLocalModel } from '../llm/llm.client';
import { answerQuestion, RagAnswer } from './rag-answer';
import {
  avg,
  ControlQuestion,
  flag,
  ModeResult,
  oneLine,
  QuestionSet,
  score,
  SUPPORT_MARK,
  Verdict,
  VERDICT_MARK,
} from './rag-eval-scoring';
import { PipelineConfig } from './rag-pipeline';
import { RagService } from './rag.service';

// Day 28: the RAG pipeline run fully locally — the Week 6 index (chunks +
// e5 embeddings in data/rag), hybrid search (vectors + BM25), the local
// cross-encoder reranker and threshold, and the answer from a local model
// through Ollama — compared with a cloud model on the same control
// questions:
// - quality: the same judge, facts, quotes and "не знаю" checks as Days 22–24;
// - speed: model load, answer time (retrieval and generation separately),
//   generation speed;
// - stability: every question asked --runs times at temperature 0 — do the
//   verdict and the answer hold, does the model keep the ОТВЕТ / ИСТОЧНИКИ /
//   ЦИТАТЫ format and the language of the question, any errors.
// Models run one after another and questions one at a time, so local
// timings aren't skewed by Ollama queueing parallel requests or swapping
// models in and out of memory.
//
// npm run rag-local --workspace=backend -- [--models ollama/gemma3:12b,ollama/qwen2.5:7b,deepseek-v4-flash]
//   [--runs 3] [--judge deepseek-v4-pro] [--only q1,n1] [--report ../docs/day28-local-rag.md]
//   [--save data/rag-local-results.json]   raw results, to re-render the report later without re-running:
//   [--from data/rag-local-results.json]

// Retrieval without any LLM call: hybrid search -> cross-encoder -> threshold
// 0.2 -> top-5 (the "ce" mode of Day 23, the best one there).
const PIPELINE: Partial<PipelineConfig> = { search: 'hybrid', rerank: 'cross-encoder', candidates: 20, k: 5, minScore: 0.2 };
const PIPELINE_LABEL = 'гибридный поиск (e5 + BM25) → 20 кандидатов → cross-encoder → порог 0.2 → top-5';

interface Attempt {
  run: number;
  /** Absent when the request failed. */
  answer?: RagAnswer;
  error?: string;
  scored?: ModeResult;
  /** Retrieval (search + rerank) time — local in every case. */
  retrievalMs: number;
  /** The model's reply follows the ОТВЕТ / ИСТОЧНИКИ / ЦИТАТЫ or НЕ ЗНАЮ shape. */
  formatOk?: boolean;
  /** The reply contains CJK characters — the model drifted off the question's language. */
  langDrift?: boolean;
}

interface ModelRun {
  model: string;
  local: boolean;
  /** First request: loading the model into memory (local) or connection warm-up (cloud). */
  warmupMs: number;
  /** Attempts per question id, one per run. */
  byQuestion: Record<string, Attempt[]>;
}

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;

/** The labels the grounding parser looks for, each at the start of a line (markdown emphasis ignored, as there). */
function formatOk(raw: string): boolean {
  const content = raw.replace(/\*\*/g, '');
  const label = (name: string) => new RegExp(`(?:^|\\n)\\s*${name}\\s*:`, 'i').test(content);
  return label('НЕ ЗНАЮ') || (label('ОТВЕТ') && label('ЦИТАТЫ'));
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const percentile = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const sec = (ms: number) => `${(ms / 1000).toFixed(1)} с`;

async function warmUp(model: string): Promise<number> {
  const started = Date.now();
  await callLlm('Ответь одним словом: ок', { model, temperature: 0, maxOutputTokens: 5 }, 'rag-local:warmup');
  return Date.now() - started;
}

async function runModel(
  rag: RagService,
  set: QuestionSet,
  questions: ControlQuestion[],
  model: string,
  runs: number,
  judgeModel: string,
): Promise<ModelRun> {
  const local = isLocalModel(model);
  const warmupMs = await warmUp(model);
  console.log(`\n${model}: прогрев ${sec(warmupMs)}`);
  const byQuestion: Record<string, Attempt[]> = Object.fromEntries(questions.map((q) => [q.id, []]));
  // The judge is a cloud model, so scoring runs alongside the next local
  // answer without competing with it; a local judge is awaited in turn.
  const scoring: Promise<void>[] = [];

  for (let run = 1; run <= runs; run++) {
    for (const q of questions) {
      const attempt: Attempt = { run, retrievalMs: 0 };
      byQuestion[q.id].push(attempt);
      try {
        const answer = await answerQuestion(rag, `${set.prefix}${q.question}`, 'rag', {
          ...PIPELINE,
          model,
          temperature: 0,
          searchQuery: q.question,
        });
        attempt.answer = answer;
        const t = answer.pipeline?.timings;
        attempt.retrievalMs = t ? t.searchMs + t.rerankMs + t.rewriteMs : 0;
        if (answer.rawAnswer !== undefined) {
          attempt.formatOk = formatOk(answer.rawAnswer);
          attempt.langDrift = CJK.test(answer.rawAnswer);
        }
        const p = score(q, answer, judgeModel).then((s) => {
          attempt.scored = s;
        });
        if (isLocalModel(judgeModel)) await p;
        else scoring.push(p);
      } catch (error) {
        attempt.error = error instanceof Error ? error.message : String(error);
      }
      const a = attempt.answer;
      console.log(
        `  run ${run} ${q.id}: ${attempt.error ? `ОШИБКА ${attempt.error.slice(0, 80)}` : `${sec(a!.durationMs)}${a!.model === 'rag-guard' ? ' (не знаю без LLM)' : ''}${attempt.formatOk === false ? ' · формат!' : ''}${attempt.langDrift ? ' · язык!' : ''}`}`,
      );
    }
  }
  await Promise.all(scoring);
  return { model, local, warmupMs, byQuestion };
}

function renderReport(
  set: QuestionSet,
  questions: ControlQuestion[],
  results: ModelRun[],
  cfg: { runs: number; judge: string },
): string {
  const positive = questions.filter((q) => !q.negative);
  const negative = questions.filter((q) => q.negative);
  const totalFacts = positive.reduce((a, q) => a + q.mustInclude.length, 0);
  const attempts = (r: ModelRun, qs: ControlQuestion[] = questions) => qs.flatMap((q) => r.byQuestion[q.id]);
  const ok = (xs: Attempt[]) => xs.filter((x) => x.scored);
  // Per-run average of a count, so the tables read as "out of 10", whatever --runs was.
  const perRun = (n: number) => {
    const v = n / cfg.runs;
    return Number.isInteger(v) ? String(v) : v.toFixed(1);
  };
  const verdicts = (r: ModelRun, qs: ControlQuestion[], v: Verdict) => ok(attempts(r, qs)).filter((x) => x.scored!.judgement.verdict === v).length;
  // LLM-answered attempts only: "не знаю" from the relevance guard costs no generation.
  const generated = (r: ModelRun) => ok(attempts(r)).filter((x) => x.answer!.model !== 'rag-guard');
  const llmMs = (x: Attempt) => x.answer!.durationMs - x.retrievalMs;

  const lines: string[] = [
    '# День 28. Локальная LLM + RAG',
    '',
    `Документ: ${set.document}. Индекс Недели 6 (\`backend/data/rag\`, чанкинг по структуре, эмбеддинги \`Xenova/multilingual-e5-small\`). ` +
      `Retrieval локальный и без LLM: ${PIPELINE_LABEL}. Ответ — в формате Дня 24 (ОТВЕТ / ИСТОЧНИКИ / ЦИТАТЫ, цитаты проверяются по тексту чанков; слабый контекст → «не знаю» без вызова LLM).`,
    '',
    `${positive.length} вопросов с ответом в книге и ${negative.length} без ответа в книге; каждый задан ${cfg.runs} раз(а) при temperature 0, вопросы — по одному, модели — по очереди. ` +
      `Судья (только для оценки, вне системы): \`${cfg.judge}\`. Числа в таблицах качества — в среднем за один прогон.`,
    '',
    '## Модели',
    '',
    ...results.map((r) => `- \`${r.model}\` — ${r.local ? 'локальная, Ollama на этом Mac (M1 Pro, 32 ГБ)' : 'облачная, по API'}`),
    '',
    '## Качество',
    '',
    '«Фрагмент с ответом в контексте» — дошёл ли до модели чанк, содержащий цитату-источник вопроса. Retrieval локальный и детерминированный, поэтому у всех моделей он один и тот же: если фрагмента нет, правильный ответ модели — «в отрывках этого нет», и судья такой ответ всё равно считает неверным.',
    '',
    `| Модель | Фрагмент с ответом в контексте (из ${positive.length}) | Верно (из ${positive.length}) | Частично | Неверно | Ключевые факты | Выдумки | Без ответа в книге: верно (из ${negative.length}) | Ответ с подтверждёнными цитатами | «Не знаю» на вопросах с ответом | Смысл совпадает с цитатами |`,
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...results.map((r) => {
      const pos = ok(attempts(r, positive));
      const inContext = pos.filter((x) => x.scored!.sourceRank > 0).length;
      const facts = pos.reduce((a, x) => a + x.scored!.facts, 0);
      const answered = ok(attempts(r)).filter((x) => x.answer!.grounding?.status === 'answered');
      const unknown = pos.filter((x) => x.answer!.grounding?.status === 'unknown');
      const reasons = ['low-relevance', 'model', 'unverified']
        .map((reason) => [reason, unknown.filter((x) => x.answer!.grounding!.reason === reason).length] as const)
        .filter(([, n]) => n)
        .map(([reason, n]) => `${reason}: ${perRun(n)}`)
        .join(', ');
      return (
        `| \`${r.model}\` | ${perRun(inContext)} | ${perRun(verdicts(r, positive, 'correct'))} | ${perRun(verdicts(r, positive, 'partial'))} | ${perRun(verdicts(r, positive, 'wrong'))} | ` +
        `${Math.round((facts / Math.max(1, totalFacts * cfg.runs)) * 100)}% | ${perRun(ok(attempts(r)).filter((x) => x.scored!.judgement.hallucination).length)} | ` +
        `${perRun(verdicts(r, negative, 'correct'))} | ${perRun(answered.length)} из ${questions.length} | ${perRun(unknown.length)}${reasons ? ` (${reasons})` : ''} | ` +
        `${perRun(answered.filter((x) => x.scored!.support === 'supported').length)} да, ${perRun(answered.filter((x) => x.scored!.support === 'partial').length)} частично, ${perRun(answered.filter((x) => x.scored!.support === 'unsupported').length)} нет |`
      );
    }),
    '',
    '## Скорость',
    '',
    'Время ответа — от вопроса до проверенного ответа: retrieval (поиск + cross-encoder, локально) + вызов LLM. Вызов LLM и скорость — только по ответам, где LLM вызывалась; скорость = токены ответа / время вызова, то есть вместе с чтением промпта (≈1–2 тыс. токенов контекста).',
    '',
    '| Модель | Прогрев (загрузка модели) | Время ответа: среднее | медиана | p90 | Retrieval (сред.) | Вызов LLM (сред.) | Токенов ответа в секунду | Токенов на ответ (запрос + ответ) |',
    '|---|---|---|---|---|---|---|---|---|',
    ...results.map((r) => {
      const all = ok(attempts(r)).map((x) => x.answer!.durationMs);
      const gen = generated(r);
      const tokPerSec = avg(gen.map((x) => (x.answer!.usage?.completionTokens ?? 0) / Math.max(1, llmMs(x) / 1000)));
      const prompt = avg(gen.map((x) => x.answer!.usage?.promptTokens ?? 0));
      const completion = avg(gen.map((x) => x.answer!.usage?.completionTokens ?? 0));
      return (
        `| \`${r.model}\` | ${sec(r.warmupMs)} | ${sec(avg(all))} | ${sec(median(all))} | ${sec(percentile(all, 90))} | ` +
        `${Math.round(avg(ok(attempts(r)).map((x) => x.retrievalMs)))} мс | ${sec(avg(gen.map(llmMs)))} | ${tokPerSec.toFixed(1)} ток/с | ${Math.round(prompt)} + ${Math.round(completion)} |`
      );
    }),
    '',
    '## Стабильность',
    '',
    `Каждый вопрос задан ${cfg.runs} раз(а) при temperature 0. «Формат нарушен» — ответ модели не в виде ОТВЕТ / ИСТОЧНИКИ / ЦИТАТЫ и не «НЕ ЗНАЮ»; «смена языка» — в ответе есть иероглифы.`,
    '',
    `| Модель | Ошибки запросов | Вердикт одинаков во всех прогонах (из ${questions.length}) | Ответ дословно одинаков (из ${questions.length}) | Формат нарушен | Смена языка | Разброс времени ответа (σ / среднее) |`,
    '|---|---|---|---|---|---|---|',
    ...results.map((r) => {
      const all = attempts(r);
      const sameVerdict = questions.filter((q) => {
        const xs = r.byQuestion[q.id];
        return xs.every((x) => x.scored) && new Set(xs.map((x) => x.scored!.judgement.verdict)).size === 1;
      }).length;
      const sameText = questions.filter((q) => {
        const xs = r.byQuestion[q.id];
        return xs.every((x) => x.answer) && new Set(xs.map((x) => x.answer!.rawAnswer ?? x.answer!.answer)).size === 1;
      }).length;
      // Spread of the same question's time across runs, averaged over questions.
      const spread = avg(
        questions
          .map((q) => r.byQuestion[q.id].filter((x) => x.answer && x.answer.model !== 'rag-guard').map((x) => x.answer!.durationMs))
          .filter((ts) => ts.length > 1)
          .map((ts) => {
            const m = avg(ts);
            return Math.sqrt(avg(ts.map((t) => (t - m) ** 2))) / m;
          }),
      );
      const withRaw = all.filter((x) => x.formatOk !== undefined);
      return (
        `| \`${r.model}\` | ${all.filter((x) => x.error).length} из ${all.length} | ${sameVerdict} | ${sameText} | ` +
        `${withRaw.filter((x) => !x.formatOk).length} из ${withRaw.length} | ${withRaw.filter((x) => x.langDrift).length} из ${withRaw.length} | ${Math.round(spread * 100)}% |`
      );
    }),
    '',
    '## По вопросам',
    '',
    `| # | Вопрос | Фрагмент с ответом в контексте | ${results.map((r) => `\`${r.model}\``).join(' | ')} |`,
    `|---|---|---|${results.map(() => '---').join('|')}|`,
    ...questions.map((q) => {
      const cells = results.map((r) =>
        r.byQuestion[q.id]
          .map((x) => {
            if (x.error) return '⚠️';
            const g = x.answer!.grounding;
            return `${VERDICT_MARK[x.scored!.judgement.verdict]}${g?.status === 'unknown' ? '?' : ''}`;
          })
          .join(' ') + ` · ${sec(avg(r.byQuestion[q.id].filter((x) => x.answer).map((x) => x.answer!.durationMs)))}`,
      );
      const first = results[0]?.byQuestion[q.id].find((x) => x.scored);
      const rank = q.negative ? '—' : first ? first.scored!.sourceRank || 'нет' : '?';
      return `| ${q.id} | ${q.question} | ${rank} | ${cells.join(' | ')} |`;
    }),
    '',
    '«Фрагмент с ответом в контексте» — его место среди фрагментов, ушедших в LLM (нет — не нашёлся). В ячейке модели: вердикт судьи в каждом прогоне (? — ответ «не знаю», ⚠️ — ошибка запроса) · среднее время ответа.',
    '',
    '## Ответы (прогон 1)',
  ];

  for (const q of questions) {
    lines.push('', `### ${q.id}. ${q.question}`, '', `**Ожидание:** ${q.expected}`);
    for (const r of results) {
      const x = r.byQuestion[q.id][0];
      if (x.error) {
        lines.push('', `**\`${r.model}\`** — ошибка: ${x.error}`);
        continue;
      }
      const s = x.scored!;
      const g = x.answer!.grounding;
      const bad = g?.quotes.filter((y) => y.match === 'not-found') ?? [];
      lines.push(
        '',
        `**\`${r.model}\`** — ${VERDICT_MARK[s.judgement.verdict]} ${s.judgement.verdict}${s.judgement.hallucination ? ', выдумка' : ''}` +
          (q.mustInclude.length ? `, факты ${s.facts}/${q.mustInclude.length}` : '') +
          ` · ${sec(x.answer!.durationMs)}` +
          (g?.status === 'answered' ? ` · цитат подтверждено ${g.quotes.length - bad.length}/${g.quotes.length}${s.support ? ` ${SUPPORT_MARK[s.support]}` : ''}` : '') +
          (x.formatOk === false ? ' · формат нарушен' : '') +
          (x.langDrift ? ' · смена языка' : '') +
          `. Судья: ${s.judgement.comment}`,
        '',
        ...x.answer!.answer.split('\n').map((l) => `> ${l}`),
      );
      if (g?.rejectedAnswer) lines.push('', `Отклонённый ответ модели (цитаты не найдены): «${oneLine(g.rejectedAnswer)}»`);
      if (x.formatOk === false) lines.push('', `Ответ модели как пришёл: «${oneLine(x.answer!.rawAnswer ?? '')}»`);
    }
  }
  return lines.join('\n') + '\n';
}

async function main() {
  const args = process.argv.slice(2);
  const file = path.resolve(flag(args, 'questions') ?? path.join(__dirname, 'eval/ufo-questions.json'));
  const set = JSON.parse(fs.readFileSync(file, 'utf8')) as QuestionSet;
  const models = (flag(args, 'models') ?? 'ollama/gemma3:12b,ollama/qwen2.5:7b,deepseek-v4-flash').split(',');
  const runs = Math.max(1, Number(flag(args, 'runs')) || 3);
  const judgeModel = flag(args, 'judge') ?? 'deepseek-v4-pro';
  const only = flag(args, 'only')?.split(',');
  const questions = set.questions.filter((q) => !only || only.includes(q.id));
  let results: ModelRun[];
  let cfg = { runs, judge: judgeModel };
  const from = flag(args, 'from');
  if (from) {
    ({ results, cfg } = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), from), 'utf8')) as { results: ModelRun[]; cfg: typeof cfg });
  } else {
    const rag = new RagService();
    results = [];
    for (const model of models) results.push(await runModel(rag, set, questions, model, runs, judgeModel));
  }

  const save = flag(args, 'save');
  if (save) {
    // The request log (full prompts) and the first-stage candidates are what makes this big — the report needs neither.
    const slim = results.map((r) => ({
      ...r,
      byQuestion: Object.fromEntries(
        Object.entries(r.byQuestion).map(([id, xs]) => [
          id,
          xs.map((x) => ({
            ...x,
            answer: x.answer && { ...x.answer, requests: [], pipeline: x.answer.pipeline && { ...x.answer.pipeline, candidates: [] } },
            scored: x.scored && { ...x.scored, answer: undefined },
          })),
        ]),
      ),
    }));
    fs.writeFileSync(path.resolve(process.cwd(), save), JSON.stringify({ cfg, results: slim }, null, 1));
    console.log(`Результаты: ${path.resolve(process.cwd(), save)}`);
  }

  const report = renderReport(set, questions.filter((q) => results[0]?.byQuestion[q.id]), results, cfg);
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
