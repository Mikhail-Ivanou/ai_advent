import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { RagService } from './rag.service';
import { CompareResult, StrategyStats } from './rag.types';

// npm run rag --workspace=backend -- <command>
//   index <file|url>...       add documents (both strategies are built)
//   list                      indexed documents and chunk counts
//   remove <id>...            drop documents from both indexes
//   search <query> [--k 5]    top-k from each strategy, side by side
//   compare [--sample 60] [--report docs/day21-chunking.md]
//                             statistics + self-retrieval evaluation
//   params --size 1000 --overlap 150 --max 1800 --min 300
//                             change chunking parameters and re-index everything

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

function paramsLabel(s: StrategyStats): string {
  const p = s.params as unknown as Record<string, number>;
  return s.strategy === 'fixed' ? `size=${p.size}, overlap=${p.overlap}` : `maxSize=${p.maxSize}, minSize=${p.minSize}`;
}

function table(rows: string[][]): string {
  const [head, ...body] = rows;
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...body.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

function renderComparison(result: CompareResult, documents: string[]): string {
  const s = result.stats;
  const row = (label: string, f: (x: StrategyStats) => string) => [label, ...s.map(f)];
  const lines = [
    `Документы (${documents.length}): ${documents.join(', ')}`,
    '',
    table([
      ['Метрика', ...s.map((x) => x.strategy)],
      row('Параметры', paramsLabel),
      row('Чанков', (x) => String(x.chunks)),
      row('Длина, симв. (сред / медиана)', (x) => `${x.chars.avg} / ${x.chars.median}`),
      row('Длина min–max (σ)', (x) => `${x.chars.min}–${x.chars.max} (σ ${x.chars.stdDev})`),
      row('Токенов (сред / max)', (x) => `${x.tokens.avg} / ${x.tokens.max}`),
      row('Обрезано моделью (>512 ток.)', (x) => pct(x.truncatedShare)),
      row('Чанк захватывает >1 раздела', (x) => pct(x.crossSectionShare)),
      row('Обрыв посреди предложения', (x) => pct(x.brokenEndShare)),
      row('Мелкие чанки (<200 симв.)', (x) => pct(x.tinyShare)),
      row('Избыточность текста', (x) => `×${x.redundancy}`),
      row('Время эмбеддингов', (x) => `${(x.embedMs / 1000).toFixed(1)} с`),
      row('Размер индекса', (x) => `${(x.indexBytes / 1024 / 1024).toFixed(2)} МБ`),
    ]),
  ];
  if (result.evaluation) {
    const e = result.evaluation;
    const label = { sentence: 'предложение → его место', heading: 'заголовок → его раздел' };
    lines.push(
      '',
      `Retrieval без разметки (до ${e.sample} запросов каждого вида, seed ${e.seed}):`,
      '- «предложение → его место»: запрос — случайное предложение документа, попадание — чанк, содержащий это место, в top-k;',
      '- «заголовок → его раздел»: запрос — заголовок раздела, попадание — чанк, который минимум наполовину состоит из этого раздела.',
      '',
      table([
        ['Проверка', 'Стратегия', 'Запросов', 'Hit@1', 'Hit@3', 'Hit@5', 'MRR'],
        ...e.results.map((r) => [label[r.kind], r.strategy, String(r.queries), pct(r.hitAt1), pct(r.hitAt3), pct(r.hitAt5), r.mrr.toFixed(3)]),
      ]),
    );
  }
  return lines.join('\n');
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const rag = new RagService();

  switch (command) {
    case 'index': {
      if (!args.length) throw new Error('usage: index <file|url>...');
      for (const target of args) {
        const started = Date.now();
        const result = /^https?:\/\//.test(target) ? await rag.addFromUrl(target) : await rag.addFromPath(path.resolve(target));
        const d = result.document;
        console.log(
          `✓ ${d.title} [${d.kind}] — ${d.chars} симв., ${d.sections} разделов; ` +
            result.strategies.map((s) => `${s.strategy}: ${s.chunks} чанков`).join(', ') +
            ` (${((Date.now() - started) / 1000).toFixed(1)} с)`,
        );
      }
      break;
    }
    case 'list': {
      const { documents, params, embedding } = rag.list();
      console.log(`Модель: ${embedding?.model ?? '—'} (dim ${embedding?.dim ?? '?'}), параметры: ${JSON.stringify(params)}`);
      for (const d of documents) {
        console.log(`${d.id}  ${d.title} [${d.kind}] ${d.chars} симв. — fixed ${d.chunks.fixed}, structural ${d.chunks.structural}  (${d.source})`);
      }
      break;
    }
    case 'remove': {
      for (const id of args) {
        await rag.remove(id);
        console.log(`✓ удалён ${id}`);
      }
      break;
    }
    case 'search': {
      const k = Number(flag(args, 'k')) || 5;
      const query = args.join(' ');
      const result = await rag.search(query, k);
      for (const [strategy, hits] of Object.entries(result)) {
        console.log(`\n=== ${strategy} ===`);
        for (const h of hits) {
          const m = h.metadata;
          console.log(`${h.score.toFixed(4)}  ${m.chunk_id}  ${m.file} › ${m.section || '—'}${m.part ? ` (часть ${m.part})` : ''}`);
          console.log(`        ${h.text.replace(/\s+/g, ' ').slice(0, 200)}…`);
        }
      }
      break;
    }
    case 'compare': {
      const sample = Number(flag(args, 'sample') ?? 60);
      const report = flag(args, 'report');
      const result = await rag.compare(sample);
      const text = renderComparison(result, rag.list().documents.map((d) => d.title));
      console.log(text);
      if (report) {
        const file = path.resolve(process.cwd(), report);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `# Сравнение стратегий chunking\n\n${text}\n`);
        console.log(`\nОтчёт: ${file}`);
      }
      break;
    }
    case 'params': {
      const n = (name: string) => {
        const value = flag(args, name);
        return value === undefined ? undefined : Number(value);
      };
      const size = n('size'), overlap = n('overlap'), maxSize = n('max'), minSize = n('min');
      const result = await rag.setParams({
        fixed: { ...rag.getParams().fixed, ...(size ? { size } : {}), ...(overlap !== undefined ? { overlap } : {}) },
        structural: { ...rag.getParams().structural, ...(maxSize ? { maxSize } : {}), ...(minSize !== undefined ? { minSize } : {}) },
      });
      console.log(`Переиндексировано документов: ${result.documents}; параметры: ${JSON.stringify(result.params)}`);
      break;
    }
    default:
      console.log('commands: index <file|url>... | list | remove <id>... | search <query> [--k N] | compare [--sample N] [--report file.md] | params ...');
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
