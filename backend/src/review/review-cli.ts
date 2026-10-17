import 'dotenv/config';
import { promises as fs } from 'fs';
import { REPO_DIR } from '../dev-assistant/project-docs';
import { git } from './git-diff';
import { renderMarkdown } from './render';
import { CodeReviewer } from './reviewer';

// Day 32: AI code review from the command line — locally and in the GitHub
// Action (.github/workflows/ai-review.yml).
//
//   npm run review --workspace=backend -- --base main                 # HEAD vs main
//   npm run review --workspace=backend -- --base main --worktree      # incl. uncommitted edits
//   npm run review --workspace=backend -- --base origin/main --head <sha> --out review.md --json review.json
//
// Flags: --base <ref> (default origin/main, else main), --head <ref>, --worktree,
// --model <name> (default REVIEW_MODEL, else LLM_MODEL), --out <file.md>,
// --json <file.json>, --repo-url <https://github.com/o/r> and --sha <commit>
// for file links, --fail-on high|medium (exit 2 when such a finding exists).

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function defaultBase(): Promise<string> {
  try {
    await git(REPO_DIR, ['rev-parse', '--verify', '--quiet', 'origin/main']);
    return 'origin/main';
  } catch {
    return 'main';
  }
}

async function main() {
  const reviewer = new CodeReviewer();
  const base = arg('base') ?? (await defaultBase());
  const result = await reviewer.review({
    base,
    head: arg('head'),
    worktree: flag('worktree'),
    model: arg('model') ?? (process.env.REVIEW_MODEL?.trim() || undefined),
    onProgress: (m) => console.error(`· ${m}`),
  });
  const markdown = renderMarkdown(result, { repoUrl: arg('repo-url'), sha: arg('sha') });
  const out = arg('out');
  if (out) await fs.writeFile(out, markdown);
  const json = arg('json');
  if (json) await fs.writeFile(json, JSON.stringify(result, null, 2));
  console.log(markdown);

  const failOn = arg('fail-on');
  const blocking = failOn === 'medium' ? ['high', 'medium'] : failOn === 'high' ? ['high'] : [];
  const bad = result.findings.filter((f) => f.category === 'bug' && blocking.includes(f.severity));
  if (bad.length) {
    console.error(`Найдено багов уровня ${failOn} и выше: ${bad.length}`);
    process.exit(2);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
