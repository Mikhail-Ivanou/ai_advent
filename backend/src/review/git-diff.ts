import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { promisify } from 'util';

// Day 32: what changed — read straight from git, so the review runs the same
// on a laptop and in a GitHub Action (no MCP server there). The diff is taken
// against the merge-base with the base branch, as a pull request shows it.

const run = promisify(execFile);

/** Not worth a reviewer's attention: lockfiles, generated and binary files. */
const IGNORED = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)(yarn\.lock|pnpm-lock\.yaml)$/,
  /\.pbxproj$/,
  /(^|\/)(dist|build|\.next|node_modules)\//,
  /\.(png|jpe?g|gif|webp|ico|pdf|zip|onnx|bin|fb2|woff2?)$/i,
  /\.min\.(js|css)$/,
];

export interface DiffHunk {
  /** First line of the hunk in the new file and how many lines it spans there. */
  newStart: number;
  newLines: number;
  /** New-file line numbers of the lines this hunk adds. */
  added: number[];
}

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  /** Unified diff of this file (headers + hunks). */
  diff: string;
  hunks: DiffHunk[];
  /** New version of the file, when it exists and is text. */
  content?: string;
}

export interface DiffSpec {
  /** Branch or commit the changes go into, e.g. "origin/main". */
  base: string;
  /** Commit with the changes (default HEAD). Ignored with `worktree`. */
  head?: string;
  /** Review the working copy (incl. uncommitted edits) instead of a commit. */
  worktree?: boolean;
}

export interface ReviewDiff {
  base: string;
  head: string;
  mergeBase: string;
  files: ChangedFile[];
  /** Changed files left out as lockfiles/generated/binary. */
  ignored: string[];
}

export async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', repo, '--no-pager', ...args], { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

const SAFE_REF = /^[\w./~^@{}-]+$/;
function checkRef(ref: string): string {
  if (!SAFE_REF.test(ref) || ref.startsWith('-')) throw new Error(`Недопустимая ссылка git: ${ref}`);
  return ref;
}

/** Splits `git diff` output into per-file diffs and hunks with new-file line numbers. */
export function parseUnifiedDiff(raw: string): Map<string, { diff: string; hunks: DiffHunk[] }> {
  const files = new Map<string, { diff: string; hunks: DiffHunk[] }>();
  const parts = raw.split(/^(?=diff --git )/m).filter((p) => p.startsWith('diff --git '));
  for (const part of parts) {
    const plus = /^\+\+\+ (?:b\/)?(.+)$/m.exec(part)?.[1];
    const minus = /^--- (?:a\/)?(.+)$/m.exec(part)?.[1];
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(part);
    const file = plus && plus !== '/dev/null' ? plus : (minus !== '/dev/null' ? minus : undefined) ?? header?.[2];
    if (!file) continue;
    const hunks: DiffHunk[] = [];
    let current: DiffHunk | undefined;
    let line = 0;
    for (const l of part.split('\n')) {
      const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (h) {
        current = { newStart: Number(h[1]), newLines: h[2] === undefined ? 1 : Number(h[2]), added: [] };
        hunks.push(current);
        line = current.newStart;
        continue;
      }
      if (!current) continue;
      if (l.startsWith('+')) current.added.push(line++);
      else if (l.startsWith(' ')) line++;
      // "-" lines and "\ No newline" don't exist in the new file.
    }
    files.set(file, { diff: part.trimEnd(), hunks });
  }
  return files;
}

export async function collectDiff(repo: string, spec: DiffSpec): Promise<ReviewDiff> {
  const base = checkRef(spec.base);
  const head = spec.worktree ? 'WORKTREE' : checkRef(spec.head ?? 'HEAD');
  const mergeBase = (await git(repo, ['merge-base', base, spec.worktree ? 'HEAD' : head])).trim();
  // merge-base..head for a commit, merge-base..working copy for local edits.
  const range = spec.worktree ? [mergeBase] : [mergeBase, head];

  const numstat = await git(repo, ['diff', '--numstat', '-M', '-z', ...range]);
  const status = await git(repo, ['diff', '--name-status', '-M', ...range]);
  const raw = await git(repo, ['diff', '-U5', '-M', '--no-color', '--no-ext-diff', ...range]);
  const parsed = parseUnifiedDiff(raw);

  const statusOf = new Map<string, { status: FileStatus; oldPath?: string }>();
  for (const l of status.split('\n').filter(Boolean)) {
    const [code, a, b] = l.split('\t');
    const s: FileStatus = code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : code.startsWith('R') ? 'renamed' : 'modified';
    statusOf.set(b ?? a, { status: s, oldPath: b ? a : undefined });
  }

  // -z numstat: "add\tdel\tpath\0" or, for renames, "add\tdel\t\0old\0new\0".
  const stats = new Map<string, { additions: number; deletions: number }>();
  const tokens = numstat.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(tokens[i]);
    if (!m) continue;
    let file = m[3];
    if (!file) {
      file = tokens[i + 2];
      i += 2;
    }
    stats.set(file, { additions: m[1] === '-' ? -1 : Number(m[1]), deletions: m[2] === '-' ? -1 : Number(m[2]) });
  }

  const files: ChangedFile[] = [];
  const ignored: string[] = [];
  for (const [file, st] of stats) {
    // Binary files have "-" counts.
    if (IGNORED.some((re) => re.test(file)) || st.additions < 0) {
      ignored.push(file);
      continue;
    }
    const meta = statusOf.get(file) ?? { status: 'modified' as FileStatus };
    const d = parsed.get(file);
    files.push({
      path: file,
      oldPath: meta.oldPath,
      status: meta.status,
      additions: st.additions,
      deletions: st.deletions,
      diff: d?.diff ?? '',
      hunks: d?.hunks ?? [],
      content: meta.status === 'deleted' ? undefined : await readVersion(repo, file, spec.worktree ? undefined : head),
    });
  }
  // New files not yet added to git aren't in `git diff` — in the working copy
  // they're part of the change too, shown as all-added.
  if (spec.worktree) {
    const untracked = (await git(repo, ['ls-files', '--others', '--exclude-standard'])).split('\n').filter(Boolean);
    for (const file of untracked) {
      if (IGNORED.some((re) => re.test(file))) {
        ignored.push(file);
        continue;
      }
      const content = await readVersion(repo, file);
      if (content === undefined || content.includes('\0')) continue;
      const lines = content.replace(/\n$/, '').split('\n');
      const diff = [
        `diff --git a/${file} b/${file}`,
        'new file (untracked)',
        '--- /dev/null',
        `+++ b/${file}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((l) => `+${l}`),
      ].join('\n');
      files.push({
        path: file,
        status: 'added',
        additions: lines.length,
        deletions: 0,
        diff,
        hunks: [{ newStart: 1, newLines: lines.length, added: lines.map((_, i) => i + 1) }],
        content,
      });
    }
  }
  return { base, head, mergeBase, files, ignored };
}

async function readVersion(repo: string, file: string, rev?: string): Promise<string | undefined> {
  try {
    return rev ? await git(repo, ['show', `${rev}:${file}`]) : await fs.readFile(path.join(repo, file), 'utf8');
  } catch {
    return undefined;
  }
}

/** New-file lines a finding may point at: inside a hunk of this file. */
export function lineInDiff(file: ChangedFile, line: number): 'added' | 'context' | 'outside' {
  for (const h of file.hunks) {
    if (h.added.includes(line)) return 'added';
    if (line >= h.newStart && line < h.newStart + h.newLines) return 'context';
  }
  return 'outside';
}
