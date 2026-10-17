import { callLlm, LlmUsage, sumUsage } from '../llm/llm.client';
import { ProjectDocsIndex, REPO_DIR } from '../dev-assistant/project-docs';
import { SearchHit } from '../rag/rag.types';
import { ChangedFile, collectDiff, DiffSpec, lineInDiff, ReviewDiff } from './git-diff';

// Day 32: AI code review of a pull request.
//
//   diff (git) ──► batches of files ──► per batch: RAG context for the changed
//   code (docs + related code from the project index) + the annotated diff +
//   small files in full ──► LLM (JSON findings) ──► findings checked against
//   the diff ──► one report: bugs, architecture, recommendations.
//
// Line numbers are the weak spot of LLM reviews, so every diff line is
// prefixed with its new-file number, and a finding pinned to a line outside
// the diff is dropped: it is about old code, not this change.

export type FindingCategory = 'bug' | 'architecture' | 'recommendation';
export type FindingSeverity = 'high' | 'medium' | 'low';

export interface ContextRef {
  n: number;
  file: string;
  section: string;
}

export interface ReviewFinding {
  category: FindingCategory;
  severity: FindingSeverity;
  file: string;
  /** New-file line, inside the diff (findings about unchanged lines are dropped). */
  line?: number;
  title: string;
  details: string;
  suggestion?: string;
  /** Project context the finding relies on ("already exists in …"). */
  refs: ContextRef[];
}

export interface ReviewOptions extends DiffSpec {
  model?: string;
  /** Diff characters per LLM call; bigger PRs are reviewed in several batches. */
  batchChars?: number;
  /** RAG excerpts per changed file. */
  contextPerFile?: number;
  repo?: string;
  onProgress?: (message: string) => void;
}

export interface ReviewResult {
  base: string;
  head: string;
  mergeBase: string;
  files: Pick<ChangedFile, 'path' | 'status' | 'additions' | 'deletions'>[];
  ignored: string[];
  /** Files whose diff was cut to fit a batch. */
  truncated: string[];
  /** Files of batches the model gave no usable answer for, even after a retry. */
  failed: string[][];
  /** Findings the model pinned to lines outside the diff — about old code, not this change. */
  dropped: { file: string; line: number; title: string }[];
  summary: string;
  findings: ReviewFinding[];
  context: ContextRef[];
  batches: number;
  model?: string;
  usage?: LlmUsage;
  durationMs: number;
}

/**
 * Never used as review context: the Day 32 report lists the problems planted
 * in the demo PR, so with it in the context the model would read the answers
 * instead of finding them. REVIEW_EXCLUDE_CONTEXT (comma-separated paths)
 * adds more.
 */
const EXCLUDED_CONTEXT = [
  'docs/day32-code-review.md',
  ...(process.env.REVIEW_EXCLUDE_CONTEXT ?? '').split(',').map((s) => s.trim()).filter(Boolean),
];

const MAX_FILE_DIFF = 24_000;
const FULL_FILE_LIMIT = 16_000;
const MAX_CONTEXT = 16;
const SEVERITY_ORDER: Record<FindingSeverity, number> = { high: 0, medium: 1, low: 2 };

/** The diff with each line's new-file number in front, so the model can cite lines exactly. */
export function annotateDiff(file: ChangedFile): string {
  const out: string[] = [];
  let line = 0;
  for (const l of file.diff.split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
    if (h) {
      line = Number(h[1]);
      out.push(l);
    } else if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(l)) {
      continue;
    } else if (l.startsWith('+')) {
      out.push(`${String(line++).padStart(5)} ${l}`);
    } else if (l.startsWith(' ')) {
      out.push(`${String(line++).padStart(5)} ${l}`);
    } else if (l.startsWith('-')) {
      out.push(`      ${l}`);
    }
  }
  return out.join('\n');
}

function batchFiles(files: ChangedFile[], limit: number): { files: ChangedFile[]; truncated: string[] }[] {
  const batches: { files: ChangedFile[]; truncated: string[] }[] = [];
  let current: { files: ChangedFile[]; truncated: string[] } = { files: [], truncated: [] };
  let size = 0;
  // Bigger changes first: they matter most if the batch budget runs short.
  for (const file of [...files].sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))) {
    let f = file;
    if (f.diff.length > MAX_FILE_DIFF) {
      f = { ...f, diff: `${f.diff.slice(0, MAX_FILE_DIFF)}\n… [diff обрезан: ${f.diff.length} символов]` };
      current.truncated.push(f.path);
    }
    if (size && size + f.diff.length > limit) {
      batches.push(current);
      current = { files: [], truncated: [] };
      size = 0;
    }
    current.files.push(f);
    size += f.diff.length;
  }
  if (current.files.length) batches.push(current);
  return batches;
}

const LANG: Record<string, string> = { ts: 'ts', tsx: 'tsx', js: 'js', mjs: 'js', swift: 'swift', md: 'markdown', json: 'json', yml: 'yaml', yaml: 'yaml' };
const langOf = (file: string) => LANG[file.split('.').pop() ?? ''] ?? '';

function buildPrompt(files: ChangedFile[], context: SearchHit[]): string {
  const ctx = context.length
    ? context.map((h, i) => `[${i + 1}] ${h.metadata.file}${h.metadata.section ? ` › ${h.metadata.section}` : ''}\n${h.text}`).join('\n\n')
    : '(ничего не найдено)';
  const full = files
    .filter((f) => f.content && f.content.length <= FULL_FILE_LIMIT && f.status !== 'added')
    .map((f) => {
      const numbered = f.content!.replace(/\n$/, '').split('\n').map((l, i) => `${String(i + 1).padStart(5)}  ${l}`).join('\n');
      return `### ${f.path} — новая версия целиком\n\`\`\`${langOf(f.path)}\n${numbered}\n\`\`\``;
    });
  const diffs = files.map(
    (f) =>
      `### ${f.path} (${f.status}${f.oldPath ? ` из ${f.oldPath}` : ''}, +${f.additions} −${f.deletions})\n\`\`\`diff\n${annotateDiff(f)}\n\`\`\``,
  );

  return [
    'Ты — опытный ревьюер кода этого проекта (монорепо: NestJS backend, Next.js web, MCP-серверы mcp-weather, llm-gateway, iOS-клиент на SwiftUI). Проверь изменения pull request.',
    '',
    '## Контекст проекта (RAG: документация и код, связанный с изменениями)',
    ctx,
    '',
    ...(full.length ? ['## Изменённые файлы целиком (небольшие)', ...full, ''] : []),
    '## Diff',
    'Слева у строк — номер строки в НОВОЙ версии файла; у удалённых строк ("-") номера нет.',
    ...diffs,
    '',
    '## Задача',
    'Найди в ДОБАВЛЕННЫХ или изменённых строках:',
    '- bug — потенциальные баги: ошибки логики и граничных случаев, необработанные ошибки и промисы, гонки, утечки ресурсов, неверные типы, уязвимости (инъекции, обход путей, секреты в коде);',
    '- architecture — архитектурные проблемы: расхождение с устройством проекта из документации (где что должно жить, слои и модули), дублирование того, что уже есть в проекте (см. контекст), лишняя связность, несогласованные API и типы;',
    '- recommendation — рекомендации: читаемость, тесты, документация, производительность, мелкие улучшения.',
    'Правила:',
    '- Пиши только о строках этого diff, не о старом коде.',
    '- file — путь ровно как в заголовке diff; line — номер строки из левой колонки (новая версия файла).',
    '- Если замечание опирается на контекст, укажи его номера в refs (например, код уже есть в [3]).',
    '- Сверяй новый код с определениями из контекста: сигнатуры, async-функции и Promise (пропущенный await), ограничения схем (min/max, enum), возвращаемые типы, что функция уже существует.',
    '- Проверь граничные случаи: пустые значения, off-by-one в slice/индексах, значения по умолчанию, очистку таймеров и подписок.',
    '- Не выдумывай: если не уверен, что это баг, ставь severity "low" и объясни, при каком условии он проявится.',
    '- Не больше 12 замечаний, важные первыми; без замечаний — пустой список. Не хвали код в findings.',
    '- Пиши по-русски.',
    'Ответ — один JSON-объект:',
    '{"summary": "2–4 предложения: что делает изменение и главный риск", "findings": [{"category": "bug|architecture|recommendation", "severity": "high|medium|low", "file": "путь", "line": 42, "title": "коротко", "details": "что не так и почему", "suggestion": "как исправить", "refs": [1]}]}',
  ].join('\n');
}

function parseJson(text: string): { summary?: unknown; findings?: unknown } {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error(`Модель вернула не JSON: ${text.slice(0, 200)}`);
  }
}

const asCategory = (v: unknown): FindingCategory =>
  v === 'bug' || v === 'architecture' ? v : 'recommendation';
const asSeverity = (v: unknown): FindingSeverity => (v === 'high' || v === 'medium' ? v : 'low');
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

function resolveFile(name: string, files: ChangedFile[]): ChangedFile | undefined {
  const clean = name.replace(/^[ab]\//, '').replace(/^\.\//, '');
  return files.find((f) => f.path === clean) ?? files.find((f) => f.path.endsWith(`/${clean}`) || clean.endsWith(f.path));
}

export class CodeReviewer {
  constructor(readonly index = new ProjectDocsIndex()) {}

  async review(options: ReviewOptions): Promise<ReviewResult> {
    const started = Date.now();
    const log = options.onProgress ?? (() => undefined);
    const repo = options.repo ?? REPO_DIR;

    const diff: ReviewDiff = await collectDiff(repo, options);
    log(`diff ${diff.base}...${diff.head}: ${diff.files.length} файлов${diff.ignored.length ? `, пропущено ${diff.ignored.length}` : ''}`);
    const base = {
      base: diff.base,
      head: diff.head,
      mergeBase: diff.mergeBase,
      files: diff.files.map(({ path, status, additions, deletions }) => ({ path, status, additions, deletions })),
      ignored: diff.ignored,
    };
    const reviewable = diff.files.filter((f) => f.status !== 'deleted' && f.diff);
    if (!reviewable.length) {
      return { ...base, truncated: [], dropped: [], failed: [], summary: 'Изменений для ревью нет.', findings: [], context: [], batches: 0, durationMs: Date.now() - started };
    }

    const stats = await this.index.ensure();
    log(`RAG: ${stats.documents.length} файлов, ${stats.chunks} чанков${stats.reembedded.length ? `, обновлено ${stats.reembedded.length}` : ''}`);

    const batches = batchFiles(reviewable, options.batchChars ?? 40_000);
    const findings: ReviewFinding[] = [];
    const dropped: ReviewResult['dropped'] = [];
    const failed: string[][] = [];
    const summaries: string[] = [];
    const contextAll = new Map<string, ContextRef>();
    let usage: LlmUsage | undefined;
    let model: string | undefined;

    for (const [b, batch] of batches.entries()) {
      const excludeFiles = [...diff.files.map((f) => f.path), ...EXCLUDED_CONTEXT];
      const context = await this.contextFor(batch.files, excludeFiles, options.contextPerFile ?? 3);
      log(`батч ${b + 1}/${batches.length}: ${batch.files.length} файлов, контекст ${context.length} фрагментов → LLM`);
      const prompt = buildPrompt(batch.files, context);
      let parsed: { summary?: unknown; findings?: unknown } | undefined;
      // Reasoning models spend hidden tokens before the answer; when they run
      // out, the content comes back empty — retry once with twice the room.
      for (const maxOutputTokens of [16_000, 32_000]) {
        const result = await callLlm(prompt, { format: 'json', temperature: 0.1, maxOutputTokens, model: options.model }, `review:batch-${b + 1}`);
        usage = sumUsage(usage, result.usage);
        model = result.model;
        try {
          parsed = parseJson(result.content);
          break;
        } catch (error) {
          log(`батч ${b + 1}: ${(error as Error).message}${maxOutputTokens < 32_000 ? ' — повтор' : ''}`);
        }
      }
      if (!parsed) {
        failed.push(batch.files.map((f) => f.path));
        continue;
      }
      
      const refs = context.map((h, i) => ({ n: i + 1, file: h.metadata.file, section: h.metadata.section }));
      // "[6]" means nothing to someone reading the PR — name the file instead.
      const deref = (text: string) => text.replace(/\[(\d+)\]/g, (m, n) => (refs[Number(n) - 1] ? `\`${refs[Number(n) - 1].file}\`` : m));
      refs.forEach((r) => contextAll.set(`${r.file}#${r.section}`, r));
      if (str(parsed.summary)) summaries.push(deref(str(parsed.summary)));

      for (const raw of Array.isArray(parsed.findings) ? parsed.findings : []) {
        const f = raw as Record<string, unknown>;
        const file = resolveFile(str(f.file), batch.files);
        const title = str(f.title);
        if (!title || !file) continue; // about a file that isn't in the diff — not reviewable
        const line = Number(f.line);
        const hasLine = Number.isInteger(line) && line > 0;
        if (hasLine && lineInDiff(file, line) === 'outside') {
          dropped.push({ file: file.path, line, title });
          continue;
        }
        findings.push({
          category: asCategory(f.category),
          severity: asSeverity(f.severity),
          file: file.path,
          line: hasLine ? line : undefined,
          title: deref(title),
          details: deref(str(f.details)),
          suggestion: deref(str(f.suggestion)) || undefined,
          refs: (Array.isArray(f.refs) ? f.refs : [])
            .map((n) => refs[Number(n) - 1])
            .filter((r): r is ContextRef => Boolean(r)),
        });
      }
    }

    // Same file + line + title from overlapping batches/retries — keep one.
    const seen = new Set<string>();
    const unique = findings.filter((f) => {
      const key = `${f.file}:${f.line ?? ''}:${f.title.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    unique.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
    if (failed.length === batches.length) throw new Error('Модель не вернула ревью ни для одного батча');

    return {
      ...base,
      truncated: batches.flatMap((b) => b.truncated),
      dropped,
      failed,
      summary: summaries.join('\n'),
      findings: unique,
      context: [...contextAll.values()],
      batches: batches.length,
      model,
      usage,
      durationMs: Date.now() - started,
    };
  }

  /**
   * Context for a batch, two searches per changed file:
   * - by meaning — its path + added lines: docs that describe that part and
   *   code doing something similar elsewhere (duplication, conventions);
   * - by symbols — the definitions of the functions, methods and tool names
   *   the added lines call, so the model can check calls against signatures,
   *   async-ness and schema limits it can't see in the diff.
   * Chunks of the PR's own files are left out: the diff already shows them,
   * and in the working copy the index holds their new version.
   */
  private async contextFor(files: ChangedFile[], excludeFiles: string[], perFile: number): Promise<SearchHit[]> {
    const picked = new Map<string, SearchHit>();
    const add = (hits: SearchHit[]) => hits.forEach((h) => picked.has(h.metadata.chunk_id) || picked.set(h.metadata.chunk_id, h));
    for (const file of files) {
      const added = file.diff
        .split('\n')
        .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
        .map((l) => l.slice(1).trim())
        .filter(Boolean)
        .join('\n');
      add(await this.index.search(`${file.path}\n${added.slice(0, 1200)}`, perFile, { excludeFiles }));
      const symbols = usedSymbols(added);
      if (symbols.length) add(await this.index.findDefinitions(symbols.slice(0, 6), { excludeFiles }));
    }
    return [...picked.values()].slice(0, MAX_CONTEXT);
  }
}

const COMMON = new Set(
  'then catch finally push join split slice map filter reduce find some every includes replace trim match test exec keys values entries length toLowerCase toString parse stringify log error warn resolve reject from push setState useState useEffect useCallback useRef async await return const function parseInt parseFloat setInterval setTimeout clearInterval clearTimeout Number String Boolean Array Object Promise JSON Math console fetch require if for while switch'.split(' '),
);

/** Called functions/methods and quoted tool-like names in added code, most specific first. */
export function usedSymbols(code: string, limit = 12): string[] {
  const found = new Map<string, number>();
  const bump = (s: string) => found.set(s, (found.get(s) ?? 0) + 1);
  for (const m of code.matchAll(/\b([A-Za-z_$][\w$]{2,})\s*\(/g)) if (!COMMON.has(m[1])) bump(m[1]);
  for (const m of code.matchAll(/['"`]([a-z][a-z0-9]*_[a-z0-9_]+)['"`]/g)) bump(m[1]); // snake_case ids: MCP tools, events
  return [...found].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([s]) => s);
}
