import 'dotenv/config';
import { SupportService } from './support.service';

// Day 33: the support assistant in the terminal.
//   npm run support -- --ticket T-1041                     # answers the ticket's last user message
//   npm run support -- --ticket T-1042 "Почему не работает авторизация?"
//   npm run support -- --user olga.kim@example.com "Что значит ошибка 400?"
//   npm run support -- --tickets                           # list tickets
// Needs the MCP servers running (npm run dev:mcp-weather) for the CRM.

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const support = new SupportService();
  if (process.argv.includes('--tickets')) {
    console.log((await support.crm.call('crm_list_tickets')).text);
    return;
  }
  const ticketId = arg('ticket');
  const user = arg('user');
  const flagValues = new Set([ticketId, user, arg('model')]);
  let message = process.argv
    .slice(2)
    .filter((a, i, all) => !a.startsWith('--') && !(all[i - 1]?.startsWith('--') && flagValues.has(a)))
    .join(' ')
    .trim();
  if (!message && ticketId) {
    const { ticket } = await support.ticket(ticketId);
    const msgs = ticket.messages.filter((m) => m.from === 'user');
    message = msgs[msgs.length - 1]?.text ?? '';
  }
  if (!message) throw new Error('Нужен вопрос или --ticket <id>');

  console.log(dim(`Вопрос${ticketId ? ` (${ticketId})` : ''}: ${message}`));
  const reply = await support.ask({ message, ticketId, user, model: arg('model') });
  console.log(`\n${reply.answer}\n`);
  if (reply.escalate) console.log(reply.escalate.needed ? `→ Передать сотруднику: ${reply.escalate.reason}` : '→ Сотрудник не нужен');
  if (reply.context.error) console.log(dim(`CRM: ${reply.context.error}`));
  console.log(dim('\nИсточники (RAG):'));
  for (const s of reply.sources) console.log(dim(`  ${s.cited ? '●' : '○'} [${s.n}] ${s.file} › ${s.section}`));
  for (const c of reply.toolCalls ?? []) console.log(dim(`  ⚙ MCP ${c.tool ?? c.name}(${JSON.stringify(c.arguments)})`));
  console.log(dim(`${reply.model} · ${(reply.durationMs / 1000).toFixed(1)} с${reply.usage ? ` · ${reply.usage.totalTokens} токенов` : ''}`));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
