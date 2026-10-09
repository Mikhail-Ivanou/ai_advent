import * as fs from 'fs';
import * as path from 'path';
import { EMAILS, OrderEmail } from './dataset';
import { SYSTEM_PROMPT } from './prompt';
import { chat, Config, CONFIGS, Field, FIELDS, MODELS, ollama, OPT, Params, parseOrder, sameModel, scoreOrder, unloadAll } from './order-extract';

// Day 29: optimizing a local LLM for one task — e-mail -> order JSON — with
// qwen2.5:7b in Ollama. No RAG, no tools: one system prompt, one e-mail.
// The prompt is the same everywhere; what changes is only
// - the parameters: temperature, num_predict (max tokens), num_ctx (context window);
// - the quantization of the same model: Q3_K_M, Q4_K_M (Ollama's default), Q8_0.
// Ollama's native /api/chat is called directly, so every answer comes with
// Ollama's own timings (load, prompt reading, generation) and why it stopped.
// Before each configuration every model is unloaded: the first request
// measures a cold load, and `ollama ps` shows the memory of this one model.
//
// npm run order-extract --workspace=backend -- [--configs q4-default,q4-opt] [--runs 3] [--only e1,L1]
//   [--report ../docs/day29-local-optimization.md] [--save data/order-extract-results.json] [--from …]
//   [--tokens]   prompt length of every e-mail, in the model's tokens
//   [--modelfile ollama/order-extractor.Modelfile]   write the optimized model's Modelfile


/** The optimized model as an Ollama Modelfile: the chosen weights, OPT and the system prompt. */
function modelfile(): string {
  return [
    '# День 29: qwen2.5:7b, оптимизированная под разбор писем-заказов в JSON.',
    '# Генерируется из OPT и SYSTEM_PROMPT (backend/src/order-extract):',
    '#   npm run order-extract -- --modelfile ollama/order-extractor.Modelfile',
    '#   ollama create order-extractor -f ollama/order-extractor.Modelfile',
    '# Q4_K_M: качество как у Q3_K_M и Q8_0, генерация быстрее обеих, 4.6 ГиБ в памяти.',
    `FROM ${MODELS.q4.name}`,
    '',
    '# У извлечения один правильный ответ: без сэмплирования ответы одинаковы от запуска к запуску.',
    `PARAMETER temperature ${OPT.temperature}`,
    '# Самый длинный промпт ≈5.1k токенов + ответ; 8192 вместо 32768 по умолчанию — KV-кеш меньше на ≈0.6 ГиБ.',
    `PARAMETER num_ctx ${OPT.num_ctx}`,
    '# Самый длинный JSON — 115 токенов; потолок обрывает ответ, ушедший в прозу.',
    `PARAMETER num_predict ${OPT.num_predict}`,
    '',
    `SYSTEM """${SYSTEM_PROMPT}"""`,
    '',
  ].join('\n');
}


interface Attempt {
  run: number;
  raw: string;
  /** "stop" or "length" (hit num_predict). */
  doneReason: string;
  json: boolean;
  /** Field -> correct. Empty when the answer isn't JSON. */
  fields: Partial<Record<Field, boolean>>;
  loadMs: number;
  promptTokens: number;
  promptMs: number;
  outputTokens: number;
  outputMs: number;
  /** Without the model load. */
  totalMs: number;
  error?: string;
}

interface ConfigRun {
  id: string;
  /** First request after unloading everything. */
  loadMs: number;
  diskBytes: number;
  memoryBytes: number;
  vramBytes: number;
  contextLength: number;
  byEmail: Record<string, Attempt[]>;
}


// --- Running -----------------------------------------------------------------------

async function runConfig(c: Config, emails: OrderEmail[], runs: number): Promise<ConfigRun> {
  const model = MODELS[c.model].name;
  await unloadAll();
  const byEmail: Record<string, Attempt[]> = Object.fromEntries(emails.map((e) => [e.id, []]));
  let loadMs = 0;
  let run: ConfigRun | undefined;
  for (let r = 1; r <= runs; r++) {
    for (const e of emails) {
      let attempt: Attempt;
      try {
        const res = await chat(model, e, c.params);
        const raw: string = res.message?.content ?? '';
        const order = parseOrder(raw);
        attempt = {
          run: r,
          raw,
          doneReason: res.done_reason ?? '',
          json: !!order,
          fields: order ? scoreOrder(order, e.expected) : {},
          loadMs: (res.load_duration ?? 0) / 1e6,
          promptTokens: res.prompt_eval_count ?? 0,
          promptMs: (res.prompt_eval_duration ?? 0) / 1e6,
          outputTokens: res.eval_count ?? 0,
          outputMs: (res.eval_duration ?? 0) / 1e6,
          totalMs: ((res.total_duration ?? 0) - (res.load_duration ?? 0)) / 1e6,
        };
      } catch (error) {
        attempt = { run: r, raw: '', doneReason: '', json: false, fields: {}, loadMs: 0, promptTokens: 0, promptMs: 0, outputTokens: 0, outputMs: 0, totalMs: 0, error: String(error) };
      }
      byEmail[e.id].push(attempt);
      if (!run) {
        // Right after the first (cold) request: the model is in memory with this config's window.
        loadMs = attempt.loadMs;
        const [{ models: loaded }, { models: local }] = await Promise.all([ollama('/api/ps'), ollama('/api/tags')]);
        const ps = (loaded ?? []).find((m: any) => sameModel(m, model));
        const tag = (local ?? []).find((m: any) => sameModel(m, model));
        run = { id: c.id, loadMs, diskBytes: tag?.size ?? 0, memoryBytes: ps?.size ?? 0, vramBytes: ps?.size_vram ?? 0, contextLength: ps?.context_length ?? 0, byEmail };
        console.log(`\n${c.id} (${model}): загрузка ${(loadMs / 1000).toFixed(1)} с, в памяти ${gib(run.memoryBytes)}, окно ${run.contextLength}`);
      }
      const ok = FIELDS.filter((f) => attempt.fields[f]).length;
      console.log(
        `  run ${r} ${e.id}: ${attempt.error ? `ОШИБКА ${attempt.error.slice(0, 80)}` : `${sec(attempt.totalMs)} · ${attempt.json ? `${ok}/${FIELDS.length}` : 'не JSON'} · промпт ${attempt.promptTokens}${attempt.doneReason === 'length' ? ' · оборван' : ''}`}`,
      );
    }
  }
  return run!;
}

// --- Report ------------------------------------------------------------------------

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
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
const gib = (b: number) => `${(b / 2 ** 30).toFixed(1)} ГиБ`;
const pct = (n: number, d: number) => `${Math.round((n / Math.max(1, d)) * 100)}%`;

function paramText(c: Config, key: keyof Params, fallback: string): string {
  if (c.model === 'extractor') return `${OPT[key]} (Modelfile)`;
  return c.params[key] === undefined ? `${fallback} (по умолч.)` : String(c.params[key]);
}

function renderReport(emails: OrderEmail[], results: ConfigRun[], runs: number): string {
  const config = (r: ConfigRun) => CONFIGS.find((c) => c.id === r.id)!;
  const all = (r: ConfigRun, es: OrderEmail[] = emails) => es.flatMap((e) => r.byEmail[e.id] ?? []);
  const short = emails.filter((e) => !e.id.startsWith('L'));
  const long = emails.filter((e) => e.id.startsWith('L'));
  const fieldsOk = (xs: Attempt[]) => xs.reduce((a, x) => a + FIELDS.filter((f) => x.fields[f]).length, 0);
  const perfect = (xs: Attempt[]) => xs.filter((x) => FIELDS.every((f) => x.fields[f])).length;
  const perRun = (n: number) => {
    const v = n / runs;
    return Number.isInteger(v) ? String(v) : v.toFixed(1);
  };
  const name = (r: ConfigRun) => `**${r.id}**`;

  const lines: string[] = [
    '# День 29. Оптимизация локальной LLM под задачу',
    '',
    '## Задача',
    '',
    'Интернет-магазин бытовой техники получает заказы письмами. Локальная модель должна превратить письмо клиента в JSON-заказ: покупатель, телефон в формате +7XXXXXXXXXX, город, товары артикулами из каталога (15 позиций) с итоговым количеством, дата доставки (относительные даты — от даты письма), способ оплаты, срочность. Ни RAG, ни инструментов: системный промпт с каталогом и правилами (`backend/src/order-extract/prompt.ts`) и одно письмо.',
    '',
    `Контрольный набор (\`backend/src/order-extract/dataset.ts\`): ${short.length} коротких писем, каждое проверяет своё правило (формат телефона, «в следующий вторник», поправки «уберите утюг», «дюжина … по два на каждый», похожие товары, оплата по счёту, срочность), и ${long.length} длинных (≈5 тыс. токенов вместе с промптом): новый заказ в начале, ниже — цитата старой переписки с другим заказом, долгий рассказ или пересланная внутренняя переписка о другом клиенте. Ответ сверяется с эталоном по 7 полям автоматически, без LLM-судьи.`,
    '',
    `Модель — \`qwen2.5:7b\` в Ollama на трёх квантованиях. Промпт везде один и тот же — меняются только параметры (temperature, max tokens = \`num_predict\`, context window = \`num_ctx\`) и квантование. Каждое письмо отправлено ${runs} раз(а); перед каждой конфигурацией все модели выгружаются из памяти. Ollama вызывается напрямую (\`/api/chat\`), тайминги — её собственные. Машина: MacBook Pro M1 Pro, 32 ГБ, Ollama 0.35.`,
    '',
    '## Конфигурации',
    '',
    '| Конфигурация | Квантование | temperature | num_predict (max tokens) | num_ctx (окно) |',
    '|---|---|---|---|---|',
    ...results.map((r) => {
      const c = config(r);
      return `| ${name(r)} — ${c.label} | ${MODELS[c.model].quant} | ${paramText(c, 'temperature', '0.7')} | ${paramText(c, 'num_predict', 'без лимита')} | ${paramText(c, 'num_ctx', String(r.contextLength))} |`;
    }),
    '',
    'Умолчания — из самой модели (`ollama show qwen2.5:7b`: temperature 0.7, top_p 0.8, repeat_penalty 1.05) и Ollama (окно — весь контекст модели, 32768; ответ без ограничения длины).',
    '',
    '## Качество',
    '',
    `Поля — доля верных из ${FIELDS.length} × ${emails.length} писем; «заказ целиком» — все ${FIELDS.length} полей верны. Числа — в среднем за один прогон.`,
    '',
    `| Конфигурация | Поля верно: все письма | короткие (${short.length}) | длинные (${long.length}) | Заказ целиком (из ${emails.length}) | короткие | длинные | Валидный JSON | Ответ оборван (num_predict) |`,
    '|---|---|---|---|---|---|---|---|---|',
    ...results.map((r) => {
      const xs = all(r);
      return (
        `| ${name(r)} | ${pct(fieldsOk(xs), xs.length * FIELDS.length)} | ${pct(fieldsOk(all(r, short)), all(r, short).length * FIELDS.length)} | ${pct(fieldsOk(all(r, long)), all(r, long).length * FIELDS.length)} | ` +
        `${perRun(perfect(xs))} | ${perRun(perfect(all(r, short)))} | ${perRun(perfect(all(r, long)))} | ${pct(xs.filter((x) => x.json).length, xs.length)} | ${xs.filter((x) => x.doneReason === 'length').length} из ${xs.length} |`
      );
    }),
    '',
    '### Ошибки по полям',
    '',
    `Сколько раз поле неверно (из ${emails.length * runs} ответов; неразобранный JSON — неверны все поля).`,
    '',
    `| Конфигурация | ${FIELDS.join(' | ')} |`,
    `|---|${FIELDS.map(() => '---').join('|')}|`,
    ...results.map((r) => `| ${name(r)} | ${FIELDS.map((f) => all(r).filter((x) => !x.fields[f]).length).join(' | ')} |`),
    '',
    '## Скорость',
    '',
    'Время ответа — без загрузки модели (её отдельно). Ollama кеширует уже прочитанный префикс промпта: системный промпт с каталогом читается один раз, а повтор того же длинного письма (прогоны 2–3) почти не читается заново. Поэтому время — по прогону 1 (короткие письма — с уже прочитанным системным промптом, как в работе), повторы — отдельно. Чтение промпта — по длинным письмам прогона 1, генерация — по всем ответам; токены / время по таймингам Ollama.',
    '',
    '| Конфигурация | Загрузка (холодная) | Короткое письмо, прогон 1 | Длинное письмо, прогон 1 | Длинное письмо, повтор (кеш) | Чтение промпта | Генерация | Токенов: промпт (прочитано) + ответ |',
    '|---|---|---|---|---|---|---|---|',
    ...results.map((r) => {
      const xs = all(r).filter((x) => !x.error);
      const first = (es: OrderEmail[]) => all(r, es).filter((x) => x.run === 1 && !x.error);
      // e1 is the first request of a config — it also reads the system prompt.
      const shortFirst = first(short).filter((x) => x !== r.byEmail[short[0]?.id]?.[0]);
      const longFirst = first(long);
      const longRepeat = all(r, long).filter((x) => x.run > 1 && !x.error);
      const sum = (ys: Attempt[], f: (x: Attempt) => number) => ys.reduce((a, x) => a + f(x), 0);
      return (
        `| ${name(r)} | ${sec(r.loadMs)} | ${sec(avg(shortFirst.map((x) => x.totalMs)))} | ${sec(avg(longFirst.map((x) => x.totalMs)))} | ${longRepeat.length ? sec(avg(longRepeat.map((x) => x.totalMs))) : '—'} | ` +
        `${Math.round(sum(longFirst, (x) => x.promptTokens) / Math.max(1e-9, sum(longFirst, (x) => x.promptMs) / 1000))} ток/с | ${(sum(xs, (x) => x.outputTokens) / Math.max(1e-9, sum(xs, (x) => x.outputMs) / 1000)).toFixed(1)} ток/с | ` +
        `${Math.round(avg(xs.map((x) => x.promptTokens)))} + ${Math.round(avg(xs.map((x) => x.outputTokens)))} |`
      );
    }),
    '',
    '## Ресурсы',
    '',
    '«В памяти» — по `ollama ps`: веса + KV-кеш на всё окно + буферы вычислений. Память на Apple Silicon общая, так что это и есть расход RAM. «Прочитано из длинного письма» — сколько токенов промпта модель реально увидела: если промпт не влезает в окно, Ollama молча отрезает начало.',
    '',
    '| Конфигурация | Веса на диске | В памяти | Из них на GPU | Окно | Прочитано из длинного письма (макс.) |',
    '|---|---|---|---|---|---|',
    ...results.map(
      (r) =>
        `| ${name(r)} | ${gib(r.diskBytes)} | ${gib(r.memoryBytes)} | ${pct(r.vramBytes, r.memoryBytes)} | ${r.contextLength} | ${Math.max(0, ...all(r, long).map((x) => x.promptTokens))} |`,
    ),
    '',
    '## Стабильность',
    '',
    `Каждое письмо отправлено ${runs} раз(а).`,
    '',
    `| Конфигурация | Ответ дословно одинаков во всех прогонах (из ${emails.length}) | Поля одинаковы во всех прогонах (из ${emails.length}) | Разброс «полей верно» между прогонами | Ошибки запросов |`,
    '|---|---|---|---|---|',
    ...results.map((r) => {
      const same = emails.filter((e) => new Set((r.byEmail[e.id] ?? []).map((x) => x.raw)).size === 1).length;
      const sameFields = emails.filter((e) => new Set((r.byEmail[e.id] ?? []).map((x) => FIELDS.map((f) => (x.fields[f] ? 1 : 0)).join(''))).size === 1).length;
      const byRun = Array.from({ length: runs }, (_, i) => fieldsOk(all(r).filter((x) => x.run === i + 1)) / (emails.length * FIELDS.length));
      return `| ${name(r)} | ${same} | ${sameFields} | ${Math.round(Math.min(...byRun) * 100)}–${Math.round(Math.max(...byRun) * 100)}% | ${all(r).filter((x) => x.error).length} |`;
    }),
    '',
    '## По письмам',
    '',
    `| Письмо | Что проверяет | ${results.map(name).join(' | ')} |`,
    `|---|---|${results.map(() => '---').join('|')}|`,
    ...emails.map(
      (e) =>
        `| ${e.id} | ${e.about} | ${results
          .map((r) => (r.byEmail[e.id] ?? []).map((x) => (x.error ? '⚠️' : x.json ? `${FIELDS.filter((f) => x.fields[f]).length}` : '✗')).join(' '))
          .join(' | ')} |`,
    ),
    '',
    `В ячейке — верных полей из ${FIELDS.length} в каждом прогоне (✗ — не JSON, ⚠️ — ошибка запроса).`,
  ];
  return lines.join('\n') + '\n';
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const only = flag(args, 'only')?.split(',');
  const emails = EMAILS.filter((e) => !only || only.includes(e.id));

  const mf = flag(args, 'modelfile');
  if (mf) {
    const target = path.resolve(process.cwd(), mf);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, modelfile());
    console.log(`Modelfile: ${target}`);
    return;
  }

  if (args.includes('--tokens')) {
    for (const e of emails) {
      const res = await chat(MODELS.q4.name, e, { num_ctx: 16384, num_predict: 1 });
      console.log(`${e.id}: ${res.prompt_eval_count} токенов промпта`);
    }
    return;
  }

  const ids = (flag(args, 'configs') ?? CONFIGS.map((c) => c.id).join(',')).split(',');
  const configs = ids.map((id) => {
    const c = CONFIGS.find((x) => x.id === id);
    if (!c) throw new Error(`Неизвестная конфигурация: ${id} (есть ${CONFIGS.map((x) => x.id).join(', ')})`);
    return c;
  });
  let runs = Math.max(1, Number(flag(args, 'runs')) || 3);
  let results: ConfigRun[];
  const from = flag(args, 'from');
  if (from) {
    ({ runs, results } = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), from), 'utf8')));
  } else {
    results = [];
    for (const c of configs) results.push(await runConfig(c, emails, runs));
    await unloadAll();
  }

  const save = flag(args, 'save');
  if (save) {
    fs.writeFileSync(path.resolve(process.cwd(), save), JSON.stringify({ runs, results }, null, 1));
    console.log(`Результаты: ${path.resolve(process.cwd(), save)}`);
  }
  const report = renderReport(emails.filter((e) => results[0]?.byEmail[e.id]), results, runs);
  const out = flag(args, 'report');
  if (out) {
    fs.writeFileSync(path.resolve(process.cwd(), out), report);
    console.log(`\nОтчёт: ${path.resolve(process.cwd(), out)}`);
  } else {
    console.log(`\n${report.split('## По письмам')[0]}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
