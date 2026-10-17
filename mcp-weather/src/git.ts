import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// Day 31: the developer assistant's view of the project — the git repository
// this server runs from (or GIT_REPO_DIR). Everything is read-only: git is
// run with fixed subcommands via execFile (no shell), refs are checked, and
// paths go after "--" and must be tracked files, so nothing outside the
// repository can be read.

const run = promisify(execFile);

const REPO_DIR = path.resolve(
  process.env.GIT_REPO_DIR?.trim() || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
);
/** Long diffs and files are cut for the model; it can narrow the request by path. */
const MAX_OUTPUT_CHARS = 20_000;
const SAFE_REF = /^[\w./~^@{}-]+$/;

class GitError extends Error {}

async function git(args: string[]): Promise<string> {
  try {
    const { stdout } = await run('git', ['-C', REPO_DIR, '--no-pager', ...args], {
      maxBuffer: 32 * 1024 * 1024,
      timeout: 15_000,
    });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new GitError(stderr || (error as Error).message);
  }
}

function checkRef(ref: string): string {
  if (!SAFE_REF.test(ref) || ref.startsWith('-')) throw new GitError(`Недопустимая ссылка git: ${ref}`);
  return ref;
}

/** Repository-relative path, refusing anything that climbs out of it. */
function checkPath(p: string): string {
  const clean = path.posix.normalize(p.trim().replace(/\\/g, '/')).replace(/^\.\/?/, '').replace(/\/$/, '');
  if (clean.startsWith('..') || path.posix.isAbsolute(clean)) throw new GitError(`Путь вне репозитория: ${p}`);
  return clean;
}

function truncate(text: string, limit = MAX_OUTPUT_CHARS): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, limit)}\n… [обрезано: показано ${limit} из ${text.length} символов — сузьте запрос путём]`, truncated: true };
}

function textResult(text: string, structuredContent?: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text }], ...(structuredContent ? { structuredContent } : {}) };
}

function toolError(error: unknown) {
  if (error instanceof GitError) return { content: [{ type: 'text' as const, text: error.message }], isError: true };
  throw error;
}

export async function currentBranch() {
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const [sha, subject, date] = (await git(['log', '-1', '--format=%h%x00%s%x00%cI'])).trim().split('\0');
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  try {
    upstream = (await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim();
    [behind, ahead] = (await git(['rev-list', '--left-right', '--count', `${upstream}...HEAD`])).trim().split(/\s+/).map(Number);
  } catch {
    // No upstream configured — a local branch.
  }
  return { branch, detached: branch === 'HEAD', head: { sha, subject, date }, upstream, ahead, behind };
}

export function createGitServer(): McpServer {
  const server = new McpServer({ name: 'advent-git', version: '0.1.0' });
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool(
    'git_current_branch',
    {
      title: 'Текущая git-ветка',
      description: 'Текущая ветка репозитория проекта, последний коммит (HEAD) и отставание/опережение upstream.',
      inputSchema: {},
      outputSchema: {
        branch: z.string(),
        detached: z.boolean(),
        head: z.object({ sha: z.string(), subject: z.string(), date: z.string() }),
        upstream: z.string().optional(),
        ahead: z.number(),
        behind: z.number(),
      },
      annotations: readOnly,
    },
    async () => {
      try {
        const info = await currentBranch();
        const tracking = info.upstream ? `; upstream ${info.upstream} (+${info.ahead}/−${info.behind})` : '; без upstream';
        return textResult(
          `Ветка: ${info.detached ? 'detached HEAD' : info.branch}; HEAD ${info.head.sha} «${info.head.subject}» (${info.head.date})${tracking}`,
          info,
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'git_status',
    {
      title: 'Изменения в рабочей копии',
      description: 'Незакоммиченные изменения: изменённые, добавленные в индекс и неотслеживаемые файлы (git status --porcelain).',
      inputSchema: {},
      annotations: readOnly,
    },
    async () => {
      try {
        const out = (await git(['status', '--porcelain=v1', '--branch'])).trimEnd();
        const [head, ...files] = out.split('\n');
        return textResult(files.length ? `${head}\n${files.join('\n')}` : `${head}\nРабочая копия чистая.`, {
          files: files.map((line) => ({ status: line.slice(0, 2), path: line.slice(3) })),
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'git_list_files',
    {
      title: 'Файлы проекта',
      description:
        'Список отслеживаемых git файлов проекта (git ls-files), по умолчанию — всего репозитория. Сузьте каталогом (path, например "backend/src/rag") и/или подстрокой имени (contains, например ".controller.ts"). Для обзора структуры используйте depth — тогда вернутся каталоги до этой глубины с числом файлов в каждом.',
      inputSchema: {
        path: z.string().optional().describe('Каталог относительно корня репозитория, например "web/src/app"'),
        contains: z.string().optional().describe('Подстрока пути, без учёта регистра, например "README" или ".types.ts"'),
        depth: z.number().int().min(1).max(5).optional().describe('Вернуть дерево каталогов до этой глубины вместо файлов'),
        limit: z.number().int().min(1).max(1000).default(300),
      },
      annotations: readOnly,
    },
    async ({ path: dir, contains, depth, limit }) => {
      try {
        const base = dir ? checkPath(dir) : '';
        let files = (await git(['ls-files', '--', ...(base ? [base] : [])])).split('\n').filter(Boolean);
        if (contains) files = files.filter((f) => f.toLowerCase().includes(contains.toLowerCase()));
        if (depth) {
          const counts = new Map<string, number>();
          const prefix = base ? base.split('/').length : 0;
          for (const f of files) {
            const parts = f.split('/');
            const key = parts.length - 1 > prefix ? parts.slice(0, Math.min(parts.length - 1, prefix + depth)).join('/') + '/' : f;
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
          const lines = [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => (k.endsWith('/') ? `${k}  (${n})` : k));
          return textResult(`${files.length} файлов${base ? ` в ${base}` : ''}:\n${lines.slice(0, limit).join('\n')}`);
        }
        const shown = files.slice(0, limit);
        const more = files.length > shown.length ? `\n… ещё ${files.length - shown.length}` : '';
        return textResult(`${files.length} файлов${base ? ` в ${base}` : ''}:\n${shown.join('\n')}${more}`, { total: files.length, files: shown });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'git_diff',
    {
      title: 'Diff изменений',
      description:
        'Diff проекта. Без параметров — незакоммиченные изменения рабочей копии относительно HEAD. base — сравнить с веткой/коммитом (например "main": что изменилось в текущей ветке относительно main, через merge-base). stat_only — только список файлов с числом строк.',
      inputSchema: {
        base: z.string().optional().describe('Ветка или коммит для сравнения, например "main" или "HEAD~3"'),
        path: z.string().optional().describe('Ограничить файлом или каталогом'),
        stat_only: z.boolean().default(false),
      },
      annotations: readOnly,
    },
    async ({ base, path: p, stat_only }) => {
      try {
        const args = ['diff', '--no-color', '--no-ext-diff'];
        if (stat_only) args.push('--stat');
        if (base) args.push(`${checkRef(base)}...HEAD`);
        else args.push('HEAD');
        args.push('--');
        if (p) args.push(checkPath(p));
        const out = await git(args);
        const what = base ? `${base}...HEAD` : 'рабочая копия vs HEAD';
        if (!out.trim()) return textResult(`Изменений нет (${what}${p ? `, ${p}` : ''}).`);
        const { text } = truncate(out);
        return textResult(`Diff (${what}${p ? `, ${p}` : ''}):\n${text}`);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'git_log',
    {
      title: 'История коммитов',
      description: 'Последние коммиты проекта (или конкретного файла/каталога): хэш, дата, автор, заголовок.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(15),
        path: z.string().optional(),
      },
      annotations: readOnly,
    },
    async ({ limit, path: p }) => {
      try {
        const out = await git(['log', `-${limit}`, '--date=short', '--format=%h %ad %an: %s', '--', ...(p ? [checkPath(p)] : [])]);
        return textResult(out.trim() || 'Коммитов нет.');
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'read_project_file',
    {
      title: 'Прочитать файл проекта',
      description:
        'Содержимое отслеживаемого git файла проекта (исходник, конфиг, package.json и т.п.) с номерами строк. Длинные файлы читайте по частям через start_line/max_lines.',
      inputSchema: {
        path: z.string().describe('Путь от корня репозитория, например "backend/src/app.module.ts"'),
        start_line: z.number().int().min(1).default(1),
        max_lines: z.number().int().min(1).max(800).default(300),
      },
      annotations: readOnly,
    },
    async ({ path: p, start_line, max_lines }) => {
      try {
        const file = checkPath(p);
        const tracked = (await git(['ls-files', '--', file])).split('\n').includes(file);
        if (!tracked) throw new GitError(`Файл не отслеживается git или не существует: ${file}. Найдите путь через git_list_files.`);
        // The working copy, not HEAD: the assistant should see uncommitted edits
        // too. realpath guards against a tracked symlink pointing outside.
        const full = await fs.realpath(path.join(REPO_DIR, file));
        if (!full.startsWith((await fs.realpath(REPO_DIR)) + path.sep)) throw new GitError(`Путь вне репозитория: ${file}`);
        const content = await fs.readFile(full, 'utf8');
        const lines = content.split('\n');
        const slice = lines.slice(start_line - 1, start_line - 1 + max_lines);
        const numbered = slice.map((l, i) => `${String(start_line + i).padStart(4)}  ${l}`).join('\n');
        const end = start_line - 1 + slice.length;
        const { text } = truncate(numbered);
        return textResult(`${file} (строки ${start_line}–${end} из ${lines.length}, рабочая копия):\n${text}`);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}

export { REPO_DIR };
