import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { callLlm, LlmTool, LlmToolExecution, LlmToolset, LlmUsage, ToolCallLog } from '../llm/llm.client';
import { GitMcpClient } from '../dev-assistant/git-mcp.client';
import { unifiedDiff } from './diff';

// Day 34: an assistant that works on the project's files itself. It gets a
// goal ("check that every env var the backend reads is documented"), not a
// file list, and does the rest with tools:
// - MCP "git" read tools — search_code across files, git_list_files,
//   read_project_file, git_log / git_diff;
// - edit_file / create_file — its own, local: they don't touch the disk but
//   build a changeset on top of the files' current content (read raw through
//   MCP get_file_raw), so the model re-reads its own edits and the user gets
//   a unified diff to review.
// "Apply" writes the changeset through MCP write_project_file, each file
// guarded by the sha1 it was based on. Every run is saved (JSON + .patch), so
// it can be inspected, applied later with `git apply`, or rerun with the
// same goal.

const RUNS_DIR = path.join(process.cwd(), 'data', 'file-tasks');
const MAX_ROUNDS = Number(process.env.FILE_AGENT_MAX_ROUNDS) || 30;

export interface FileChange {
  path: string;
  kind: 'create' | 'modify';
  /** sha1 of the content the change was made against; "new" for a new file. */
  baseSha1: string;
  before?: string;
  after: string;
  diff: string;
  additions: number;
  deletions: number;
}

export type FileTaskStatus = 'no-changes' | 'proposed' | 'applied' | 'partially-applied' | 'failed';

export interface FileTaskRun {
  id: string;
  goal: string;
  createdAt: string;
  status: FileTaskStatus;
  report: string;
  changes: FileChange[];
  /** All changes as one patch (`git apply`-able). */
  diff: string;
  /** Files the agent read and searches it ran — what it looked at to get there. */
  filesRead: string[];
  searches: string[];
  toolCalls: ToolCallLog[];
  model?: string;
  usage?: LlmUsage;
  durationMs: number;
  applied?: { path: string; ok: boolean; message: string }[];
  appliedAt?: string;
}

const AGENT_INSTRUCTIONS = `Ты — ассистент разработчика, который сам работает с файлами этого репозитория (монорепо: backend на NestJS, web на Next.js, MCP-серверы mcp-weather, llm-gateway, iOS-клиент, документация в docs/ и README). Тебе ставят цель, а не говорят, какие файлы открыть, — нужные файлы найди сам.

Как работать:
1. Разведка: search_code (поиск текста или регулярного выражения по всем файлам), git_list_files (структура). Ищи шире, чем кажется нужным: использования, определения, документацию.
2. Прочитай файлы, которые важны для цели (read_project_file). Перед изменением файла обязательно прочитай его актуальное содержимое.
3. Проанализируй: сопоставь код, документацию и правила из цели.
4. Если цель требует изменений — внеси их инструментами edit_file (точная замена фрагмента; old_text копируй из файла символ в символ, без номеров строк) и create_file (новый файл). Изменения — черновик: пользователь увидит diff и сам решит, применять ли. Если цель — только найти или проверить, файлы не меняй.
5. Закончи отчётом по-русски: что нашёл (со ссылками путь:строка), что изменил и почему (по файлам), что осталось или стоит проверить вручную.

Правила: меняй только то, что нужно для цели; сохраняй стиль, язык и форматирование файла; факты бери из кода и файлов, не выдумывай; не трогай .env, node_modules и сгенерированные файлы.`;

const EDIT_TOOLS: LlmTool[] = [
  {
    name: 'edit_file',
    description:
      'Изменяет файл проекта: заменяет фрагмент old_text на new_text. old_text должен встречаться в файле ровно один раз (иначе добавьте окружающие строки или передайте replace_all: true). Изменение попадает в черновик (diff), диск не трогается до решения пользователя. Возвращает diff этого изменения.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь от корня репозитория' },
        old_text: { type: 'string', description: 'Точный фрагмент текущего содержимого файла, без номеров строк' },
        new_text: { type: 'string', description: 'Чем его заменить' },
        replace_all: { type: 'boolean', description: 'Заменить все вхождения' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
  },
  {
    name: 'create_file',
    description:
      'Создаёт новый файл проекта с указанным содержимым (или целиком перезаписывает существующий, если overwrite: true). Попадает в черновик (diff), как и edit_file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        overwrite: { type: 'boolean' },
      },
      required: ['path', 'content'],
    },
  },
];

const normalize = (p: string) => path.posix.normalize(String(p).trim().replace(/\\/g, '/')).replace(/^(\.\/)+/, '');

/** Files changed by one run, on top of their current content. */
class Changeset {
  private readonly base = new Map<string, { exists: boolean; content: string; sha1: string }>();
  private readonly current = new Map<string, string>();

  constructor(private readonly git: GitMcpClient) {}

  private async load(file: string) {
    let b = this.base.get(file);
    if (!b) {
      const r = await this.git.call('get_file_raw', { path: file });
      if (r.isError || !r.structured) throw new Error(r.text);
      b = r.structured as { exists: boolean; content: string; sha1: string };
      this.base.set(file, b);
    }
    return b;
  }

  has(file: string) {
    return this.current.has(normalize(file));
  }

  content(file: string): string | undefined {
    return this.current.get(normalize(file));
  }

  async edit(file: string, oldText: string, newText: string, replaceAll: boolean): Promise<string> {
    file = normalize(file);
    const b = await this.load(file);
    if (!b.exists && !this.current.has(file)) throw new Error(`Файла ${file} нет — используйте create_file.`);
    const text = this.current.get(file) ?? b.content;
    if (!oldText) throw new Error('old_text пустой');
    const count = text.split(oldText).length - 1;
    if (count === 0) {
      throw new Error(`old_text не найден в ${file}. Перечитайте файл (read_project_file показывает его с уже внесёнными вами изменениями) и скопируйте фрагмент точно, без номеров строк.`);
    }
    if (count > 1 && !replaceAll) throw new Error(`old_text встречается в ${file} ${count} раз — добавьте окружающие строки, чтобы фрагмент был уникальным, или replace_all: true.`);
    this.current.set(file, replaceAll ? text.split(oldText).join(newText) : text.replace(oldText, () => newText));
    return this.describe(file);
  }

  async create(file: string, content: string, overwrite: boolean): Promise<string> {
    file = normalize(file);
    const b = await this.load(file);
    if ((b.exists || this.current.has(file)) && !overwrite) throw new Error(`${file} уже существует — используйте edit_file или overwrite: true.`);
    this.current.set(file, content.endsWith('\n') ? content : `${content}\n`);
    return this.describe(file);
  }

  private describe(file: string): string {
    const c = this.change(file);
    if (!c) return `${file}: изменений относительно исходного файла нет.`;
    const diff = c.diff.length > 3000 ? `${c.diff.slice(0, 3000)}\n…` : c.diff;
    return `Черновик ${file}: +${c.additions} −${c.deletions}\n${diff}`;
  }

  private change(file: string): FileChange | undefined {
    const b = this.base.get(file)!;
    const after = this.current.get(file)!;
    const { diff, additions, deletions } = unifiedDiff(file, b.exists ? b.content : undefined, after);
    if (!diff) return undefined;
    return { path: file, kind: b.exists ? 'modify' : 'create', baseSha1: b.sha1, before: b.exists ? b.content : undefined, after, diff, additions, deletions };
  }

  changes(): FileChange[] {
    return [...this.current.keys()].map((f) => this.change(f)).filter((c): c is FileChange => Boolean(c));
  }
}

function numbered(file: string, content: string, start = 1, max = 300): string {
  const lines = content.replace(/\n$/, '').split('\n');
  const slice = lines.slice(start - 1, start - 1 + max);
  return `${file} (строки ${start}–${start - 1 + slice.length} из ${lines.length}, с вашими неприменёнными изменениями):\n${slice
    .map((l, i) => `${String(start + i).padStart(4)}  ${l}`)
    .join('\n')}`;
}

export class FileAgent {
  private readonly runs = new Map<string, FileTaskRun>();

  constructor(readonly git: GitMcpClient) {}

  async run(goal: string, options: { model?: string; onProgress?: (m: string) => void } = {}): Promise<FileTaskRun> {
    const started = Date.now();
    const changeset = new Changeset(this.git);
    const filesRead = new Set<string>();
    const searches: string[] = [];
    const log = options.onProgress ?? (() => undefined);

    const mcp = await this.git.toolset((t) => t.annotations?.readOnlyHint === true && t.name !== 'get_file_raw');
    const toolset: LlmToolset = {
      tools: [...mcp.tools, ...EDIT_TOOLS],
      execute: async (name, args): Promise<LlmToolExecution> => {
        try {
          if (name === 'edit_file') {
            log(`✎ edit_file ${args.path}`);
            const text = await changeset.edit(String(args.path), String(args.old_text ?? ''), String(args.new_text ?? ''), Boolean(args.replace_all));
            return { content: text, isError: false, source: { server: 'changeset', tool: name } };
          }
          if (name === 'create_file') {
            log(`✚ create_file ${args.path}`);
            const text = await changeset.create(String(args.path), String(args.content ?? ''), Boolean(args.overwrite));
            return { content: text, isError: false, source: { server: 'changeset', tool: name } };
          }
          if (name === 'read_project_file') {
            const file = normalize(String(args.path));
            filesRead.add(file);
            log(`📖 ${file}`);
            // The model must see its own edits, not the file on disk.
            const draft = changeset.content(file);
            if (draft !== undefined) {
              return { content: numbered(file, draft, Number(args.start_line) || 1, Number(args.max_lines) || 300), isError: false, source: { server: 'changeset', tool: name } };
            }
          }
          if (name === 'search_code') {
            searches.push(String(args.pattern));
            log(`🔎 ${args.pattern}${args.path ? ` в ${args.path}` : ''}${args.glob ? ` (${args.glob})` : ''}`);
          }
          return await mcp.execute(name, args);
        } catch (error) {
          return { content: (error as Error).message, isError: true, source: { server: 'changeset', tool: name } };
        }
      },
    };

    const result = await callLlm(
      goal,
      { model: options.model, temperature: 0.1, systemPrompt: AGENT_INSTRUCTIONS, tools: toolset, maxToolRounds: MAX_ROUNDS },
      'file-agent',
    );
    const changes = changeset.changes();
    const run: FileTaskRun = {
      id: `${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${randomUUID().slice(0, 6)}`,
      goal,
      createdAt: new Date().toISOString(),
      status: changes.length ? 'proposed' : 'no-changes',
      report: result.content.trim(),
      changes,
      diff: changes.map((c) => c.diff).join('\n') + (changes.length ? '\n' : ''),
      filesRead: [...filesRead],
      searches,
      toolCalls: result.toolCalls ?? [],
      model: result.model,
      usage: result.usage,
      durationMs: Date.now() - started,
    };
    await this.save(run);
    return run;
  }

  /**
   * Writes a run's changes to the working copy through MCP; a file changed
   * since the run is refused (conflict). `paths` applies only those files —
   * the reviewer keeps the good part of a run and drops the rest.
   */
  async apply(id: string, paths?: string[]): Promise<FileTaskRun> {
    const run = await this.get(id);
    if (run.status === 'applied') throw new Error('Изменения этого запуска уже применены');
    if (!run.changes.length) throw new Error('В этом запуске нет изменений');
    const done = new Set((run.applied ?? []).filter((a) => a.ok).map((a) => a.path));
    const selected = run.changes.filter((c) => (!paths?.length || paths.includes(c.path)) && !done.has(c.path));
    if (!selected.length) throw new Error('Нечего применять: выбранные файлы не входят в запуск или уже применены');
    const results: NonNullable<FileTaskRun['applied']> = (run.applied ?? []).filter((a) => a.ok);
    for (const c of selected) {
      const r = await this.git.call('write_project_file', { path: c.path, content: c.after, expected_sha1: c.baseSha1 });
      results.push({ path: c.path, ok: !r.isError, message: r.text });
    }
    run.applied = results;
    run.appliedAt = new Date().toISOString();
    const ok = results.filter((r) => r.ok).length;
    run.status = ok === run.changes.length ? 'applied' : ok ? 'partially-applied' : 'failed';
    await this.save(run);
    return run;
  }

  async get(id: string): Promise<FileTaskRun> {
    const cached = this.runs.get(id);
    if (cached) return cached;
    if (!/^[\w-]+$/.test(id)) throw new Error(`Нет запуска ${id}`);
    const raw = await fs.readFile(path.join(RUNS_DIR, `${id}.json`), 'utf8').catch(() => {
      throw new Error(`Нет запуска ${id}`);
    });
    const run = JSON.parse(raw) as FileTaskRun;
    this.runs.set(id, run);
    return run;
  }

  async list(): Promise<Pick<FileTaskRun, 'id' | 'goal' | 'createdAt' | 'status'>[]> {
    const files = await fs.readdir(RUNS_DIR).catch(() => [] as string[]);
    const runs = await Promise.all(files.filter((f) => f.endsWith('.json')).map((f) => this.get(f.slice(0, -5)).catch(() => undefined)));
    return runs
      .filter((r): r is FileTaskRun => Boolean(r))
      .map(({ id, goal, createdAt, status }) => ({ id, goal, createdAt, status }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private async save(run: FileTaskRun) {
    this.runs.set(run.id, run);
    await fs.mkdir(RUNS_DIR, { recursive: true });
    await fs.writeFile(path.join(RUNS_DIR, `${run.id}.json`), JSON.stringify(run, null, 2));
    if (run.diff) await fs.writeFile(path.join(RUNS_DIR, `${run.id}.patch`), run.diff);
  }
}
