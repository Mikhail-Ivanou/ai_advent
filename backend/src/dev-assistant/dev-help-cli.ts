import 'dotenv/config';
import * as readline from 'readline';
import { ChatMessage } from '../llm/llm.client';
import { DevAssistantReply, DevAssistantService } from './dev-assistant.service';

// Day 31: the developer assistant in the terminal.
//   npm run dev-help -- "/help где живёт RAG-пайплайн?"   — one question
//   npm run dev-help                                       — interactive, prompt shows the branch
// Needs the MCP servers running (npm run dev:mcp-weather) for the git part.

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

function print(reply: DevAssistantReply) {
  console.log(`\n${reply.answer}\n`);
  if (reply.gitError) console.log(dim(`git: ${reply.gitError}`));
  if (reply.sources?.length) {
    console.log(dim('Источники (RAG):'));
    for (const s of reply.sources) {
      console.log(dim(`  ${s.cited ? '●' : '○'} [${s.n}] ${s.file}${s.section ? ` › ${s.section}` : ''}  (cos ${s.score})`));
    }
  }
  for (const c of reply.toolCalls ?? []) console.log(dim(`  ⚙ MCP ${c.tool ?? c.name}(${JSON.stringify(c.arguments)}) — ${c.durationMs} мс`));
  console.log(dim(`${reply.command} · ${reply.model ?? 'без LLM'} · ${(reply.durationMs / 1000).toFixed(1)} с\n`));
}

async function main() {
  const assistant = new DevAssistantService();
  const once = process.argv.slice(2).join(' ').trim();
  process.stdout.write(dim('Индексирую документацию проекта… '));
  const stats = await assistant.docs.ensure();
  console.log(dim(`${stats.documents.length} файлов, ${stats.chunks} чанков`));

  if (once) {
    print(await assistant.handle(once));
    return;
  }

  const history: ChatMessage[] = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = async () => {
    const branch = await assistant.git.currentBranch().then((b) => b.branch, () => 'git?');
    rl.setPrompt(bold(`[${branch}] › `));
    rl.prompt();
  };
  console.log(dim('Команды: /help [вопрос], /branch, /status, /files [каталог], /diff [ветка], /docs, /reindex; выход — Ctrl+D'));
  await prompt();
  for await (const line of rl) {
    if (line.trim()) {
      try {
        const reply = await assistant.handle(line, history);
        print(reply);
        if (reply.command === '/help') history.push({ role: 'user', content: reply.question ?? line }, { role: 'assistant', content: reply.answer });
      } catch (error) {
        console.log(`\nОшибка: ${(error as Error).message}\n`);
      }
    }
    await prompt();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
