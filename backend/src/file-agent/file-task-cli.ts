import 'dotenv/config';
import { GitMcpClient } from '../dev-assistant/git-mcp.client';
import { FileAgent } from './file-agent';

// Day 34: the file agent in the terminal. The goal, not the files:
//   npm run file-task -- "Найди все места, где используется McpEndpointClient"
//   npm run file-task -- "Проверь, что все переменные окружения backend описаны в .env.example, допиши недостающие"
//   npm run file-task -- --apply "…"          # apply the changes right away
//   npm run file-task -- --apply-run <id> [--only a.md,b.md]   # apply a saved run (or some of its files)
//   npm run file-task -- --list               # saved runs
// Runs are saved in backend/data/file-tasks/<id>.json + <id>.patch
// (`git apply backend/data/file-tasks/<id>.patch` from the repo root works too).
// Needs the MCP servers running (npm run dev:mcp-weather).

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const colorDiff = (d: string) =>
  d
    .split('\n')
    .map((l) => (l.startsWith('+') && !l.startsWith('+++') ? `\x1b[32m${l}\x1b[0m` : l.startsWith('-') && !l.startsWith('---') ? `\x1b[31m${l}\x1b[0m` : l.startsWith('@@') ? `\x1b[36m${l}\x1b[0m` : l))
    .join('\n');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const agent = new FileAgent(new GitMcpClient());
  if (process.argv.includes('--list')) {
    for (const r of await agent.list()) console.log(`${r.id}  [${r.status}]  ${r.goal}`);
    return;
  }
  const applyRun = arg('apply-run');
  if (applyRun) {
    const only = arg('only')?.split(',').map((p) => p.trim()).filter(Boolean);
    const run = await agent.apply(applyRun, only);
    for (const a of run.applied ?? []) console.log(`${a.ok ? '✓' : '✗'} ${a.message}`);
    return;
  }
  const valued = new Set(['--model', '--apply-run', '--only']);
  const goal = process.argv
    .slice(2)
    .filter((a, i, all) => !a.startsWith('--') && !valued.has(all[i - 1]))
    .join(' ')
    .trim();
  if (!goal) throw new Error('Опишите цель: npm run file-task -- "<что сделать с файлами проекта>"');

  console.log(dim(`Цель: ${goal}`));
  const run = await agent.run(goal, { model: arg('model'), onProgress: (m) => console.log(dim(`  ${m}`)) });
  console.log(`\n${run.report}\n`);
  if (run.changes.length) {
    console.log(colorDiff(run.diff));
    console.log(dim(`Изменения: ${run.changes.map((c) => `${c.path} (+${c.additions} −${c.deletions})`).join(', ')}`));
  } else {
    console.log(dim('Файлы не изменены.'));
  }
  console.log(dim(`Прочитано файлов: ${run.filesRead.length}, поисков: ${run.searches.length}, вызовов инструментов: ${run.toolCalls.length}`));
  console.log(dim(`${run.model} · ${(run.durationMs / 1000).toFixed(1)} с${run.usage ? ` · ${run.usage.totalTokens} токенов` : ''} · запуск ${run.id}`));

  if (run.changes.length) {
    if (process.argv.includes('--apply')) {
      const applied = await agent.apply(run.id);
      for (const a of applied.applied ?? []) console.log(`${a.ok ? '✓' : '✗'} ${a.message}`);
    } else {
      console.log(dim(`Применить: npm run file-task -- --apply-run ${run.id}   (или git apply backend/data/file-tasks/${run.id}.patch)`));
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
