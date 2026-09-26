import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { McpService } from '../mcp/mcp.service';
import { chatMeta } from '../mcp/mcp.types';
import { AgentsService } from './agents.service';
import { ToolCallLog } from './llm.client';

// Orchestration check (Day 20): sends the agent one long request whose parts
// belong to different MCP servers, then verifies from the tool-call log that
// the agent picked the right tool for each part, each call was routed to the
// server that actually offers it, dependent steps ran in order with ids
// handed over verbatim, and nothing unneeded was called.
//
// Uses the same connected MCP servers as the app (data/mcp-servers.json).
// Usage: npm run orchestration-check --workspace=backend [-- "custom prompt"]

const DEFAULT_PROMPT =
  'Еду в Прагу на выходные. Какая там будет погода в ближайшие 3 дня? Сколько будет 300 EUR в чешских кронах? ' +
  'Найди на Хабре и в Википедии про Прагу, сделай резюме тезисами и сохрани в файл. ' +
  'И напомни мне завтра в 9 утра ещё раз проверить прогноз.';

/** Tools each part of the scenario may be served by — any one of them counts. */
const PARTS: { part: string; tools: string[] }[] = [
  { part: 'погода', tools: ['get_weather_forecast'] },
  { part: 'конвертация валют', tools: ['convert_currency', 'get_rate'] },
  { part: 'поиск', tools: ['search', 'run_pipeline'] },
  { part: 'резюме', tools: ['summarize', 'run_pipeline'] },
  { part: 'сохранение в файл', tools: ['save_to_file', 'run_pipeline'] },
  { part: 'напоминание', tools: ['schedule_task'] },
];
/** Allowed but not required (e.g. the model double-checking the currency list). */
const TOLERATED = new Set(['list_currencies', 'list_scheduled_tasks']);

type Check = { ok: boolean; label: string; detail?: string };

const idFrom = (text: string, key: string) => text.match(new RegExp(`^${key}: (\\w+)`, 'm'))?.[1];
const toolOf = (c: ToolCallLog) => c.tool ?? c.name;

async function waitForConnections(mcp: McpService, timeoutMs = 30_000) {
  const started = Date.now();
  while (mcp.list().some((s) => s.status === 'connecting') && Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function main() {
  const prompt = process.argv.slice(2).join(' ').trim() || DEFAULT_PROMPT;
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  await app.init();
  const mcp = app.get(McpService);
  const agents = app.get(AgentsService);
  await waitForConnections(mcp);

  const servers = mcp.list().filter((s) => s.status === 'connected');
  console.log(`MCP-серверы (${servers.length}):`);
  for (const s of servers) console.log(`  • ${s.name} — ${s.url} — ${s.tools.map((t) => t.name).join(', ')}`);
  const notConnected = mcp.list().filter((s) => s.status !== 'connected');
  for (const s of notConnected) console.log(`  ✗ ${s.name} — ${s.status}${s.error ? `: ${s.error}` : ''}`);

  const chatId = `orchestration-check-${Date.now()}`;
  console.log(`\nЗапрос: ${prompt}\n`);
  const result = await agents.ask(chatId, prompt, 'direct', {}, undefined, { update: false }, undefined, { update: false }, {
    check: false,
  });
  const calls = result.toolCalls ?? [];

  console.log(`Флоу: ${calls.length} вызовов, ${new Set(calls.map((c) => c.round)).size} раундов`);
  for (const [i, c] of calls.entries()) {
    const parallel = calls.filter((o) => o.round === c.round).length > 1 ? ' ∥' : '';
    console.log(
      `  ${i + 1}. раунд ${c.round}${parallel} · ${c.server ?? '?'} → ${toolOf(c)}(${JSON.stringify(c.arguments)})${c.repeated ? ' ↺ повтор, не выполнен' : ''}${c.isError ? ' ✗ ОШИБКА' : ''} · ${c.durationMs} мс`,
    );
    console.log(`       ↳ ${c.result.split('\n')[0].slice(0, 140)}`);
  }

  const checks: Check[] = [];
  const byTool = (names: string[]) => calls.filter((c) => names.includes(toolOf(c)));

  // 1. Choice: every part of the request served by a suitable tool.
  for (const { part, tools } of PARTS) {
    const used = byTool(tools);
    checks.push({ ok: used.length > 0, label: `выбор: «${part}» → ${tools.join(' | ')}`, detail: used.length ? undefined : 'не вызван' });
  }

  // 2. Routing: each call went to a server that really offers that tool.
  const offers = new Map(servers.map((s) => [s.name, new Set(s.tools.map((t) => t.name))]));
  const misrouted = calls.filter((c) => !c.server || !offers.get(c.server)?.has(toolOf(c)));
  checks.push({
    ok: calls.length > 0 && misrouted.length === 0,
    label: 'маршрутизация: каждый вызов ушёл на сервер, который предоставляет инструмент',
    detail: misrouted.map((c) => `${toolOf(c)} → ${c.server}`).join(', ') || undefined,
  });
  const serversUsed = new Set(calls.map((c) => c.server));
  checks.push({ ok: serversUsed.size >= 3, label: `задействовано серверов: ${serversUsed.size}`, detail: [...serversUsed].join(', ') });

  // 3. Order + data handoff in the research chain (unless done in one run_pipeline call).
  const pipelineRun = byTool(['run_pipeline'])[0];
  if (pipelineRun) {
    checks.push({ ok: !pipelineRun.isError, label: 'цепочка: run_pipeline выполнил search → summarize → save_to_file за один вызов' });
  } else {
    const [search] = byTool(['search']);
    const [summarize] = byTool(['summarize']);
    const [save] = byTool(['save_to_file']);
    const docId = search && idFrom(search.result, 'doc_id');
    const summaryId = summarize && idFrom(summarize.result, 'summary_id');
    const inOrder = !!(search && summarize && save) && search.round < summarize.round && summarize.round < save.round;
    checks.push({ ok: inOrder, label: 'порядок: search → summarize → save_to_file в разных раундах, по очереди' });
    checks.push({
      ok: !!docId && summarize?.arguments.source_id === docId,
      label: 'передача данных: summarize получил doc_id от search',
      detail: `doc_id=${docId}, summarize.source_id=${summarize?.arguments.source_id}`,
    });
    checks.push({
      ok: !!summaryId && save?.arguments.source_id === summaryId,
      label: 'передача данных: save_to_file получил summary_id от summarize',
      detail: `summary_id=${summaryId}, save_to_file.source_id=${save?.arguments.source_id}`,
    });
    const searchSources = (search?.arguments.sources as string[] | undefined) ?? ['habr', 'wikipedia'];
    checks.push({
      ok: ['habr', 'wikipedia'].every((s) => searchSources.includes(s)),
      label: 'аргументы: поиск и в Habr, и в Wikipedia',
      detail: JSON.stringify(searchSources),
    });
  }

  // 4. Arguments that carry the request's meaning.
  const weather = byTool(['get_weather_forecast'])[0];
  checks.push({
    ok: !!weather && /праг|prag/i.test(String(weather.arguments.city)),
    label: 'аргументы: погода для Праги',
    detail: weather ? `city=${weather.arguments.city}, days=${weather.arguments.days}` : undefined,
  });
  const currency = byTool(['convert_currency', 'get_rate'])[0];
  checks.push({
    ok: !!currency && currency.arguments.from === 'EUR' && currency.arguments.to === 'CZK',
    label: 'аргументы: EUR → CZK',
    detail: currency ? JSON.stringify(currency.arguments) : undefined,
  });
  const reminder = byTool(['schedule_task'])[0];
  checks.push({
    ok: !!reminder && reminder.arguments.kind === 'reminder' && Number(reminder.arguments.delay_minutes) > 0,
    label: 'аргументы: отложенное напоминание (reminder с delay_minutes > 0)',
    detail: reminder ? JSON.stringify(reminder.arguments) : undefined,
  });

  // 5. Hygiene: no failed calls, nothing unneeded, no pointless repeats.
  const failed = calls.filter((c) => c.isError);
  checks.push({ ok: failed.length === 0, label: 'без ошибок инструментов', detail: failed.map((c) => `${toolOf(c)}: ${c.result.slice(0, 80)}`).join('; ') || undefined });
  const expected = new Set(PARTS.flatMap((p) => p.tools));
  const extra = calls.filter((c) => !expected.has(toolOf(c)) && !TOLERATED.has(toolOf(c)));
  checks.push({ ok: extra.length === 0, label: 'нет лишних вызовов', detail: extra.map(toolOf).join(', ') || undefined });
  const repeats = calls.filter((c) => c.repeated);
  checks.push({
    ok: repeats.length === 0,
    label: 'нет повторных одинаковых вызовов',
    detail: repeats.length ? `${repeats.length} повтор(ов) не выполнено повторно: ${[...new Set(repeats.map(toolOf))].join(', ')}` : undefined,
  });

  console.log('\nПроверки:');
  for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.label}${c.detail ? `  (${c.detail})` : ''}`);
  console.log(`\nОтвет агента:\n${result.answer}\n`);

  // Don't leave a real reminder behind for a throwaway chat.
  for (const call of byTool(['schedule_task'])) {
    const taskId = call.result.match(/\[(\w{8})\]/)?.[1];
    const server = servers.find((s) => s.name === call.server);
    if (taskId && server) await mcp.callTool(server.id, 'set_task_status', { task_id: taskId, status: 'cancelled' }, chatMeta(chatId));
  }

  const passed = checks.filter((c) => c.ok).length;
  console.log(`Итог: ${passed}/${checks.length} проверок пройдено`);
  await app.close();
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
