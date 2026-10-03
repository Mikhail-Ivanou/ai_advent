import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { callLlm } from '../llm/llm.client';
import { RagService } from '../rag/rag.service';
import { RagChatService } from './rag-chat.service';
import { RagChat, RagChatMessage, TaskMemory } from './rag-chat.types';

// Day 25: long scripted dialogs through the mini RAG chat (the same service
// the web page uses), checking after every turn:
// - sources: a "search" answer has sources and confirmed quotes; a "dialog"
//   answer cites the sources gathered earlier; "не знаю" is counted apart;
// - facts: the answer contains the expected stems (where the book has them);
// - message kind: notes are recorded in memory, not searched;
// - task memory: constraints / terms stay in memory from the turn they were
//   given to the end; the goal stays the same goal (LLM judge);
// - the answers keep to the goal and answer what was asked (LLM judge);
// - a length constraint ("2–3 предложения") holds.
//
// npm run rag-chat-check --workspace=backend -- [--only dossier] [--report ../docs/day25-rag-chat.md]
// The dialogs stay in data/rag-chats.json, so they can be opened on /rag-chat.

interface ScenarioTurn {
  text: string;
  expect?: string[];
  kind?: 'search' | 'dialog' | 'note';
  allowUnknown?: boolean;
}

interface Scenario {
  id: string;
  title: string;
  goal: string;
  turns: ScenarioTurn[];
  memory: { after: number; field: keyof Omit<TaskMemory, 'goal'> | 'any'; contains: string }[];
  maxSentences?: { from: number; max: number };
}

interface TurnJudgement {
  turn: number;
  answers: 'yes' | 'partial' | 'no';
  onGoal: boolean;
  comment: string;
}

interface TurnResult {
  turn: ScenarioTurn;
  index: number;
  reply: RagChatMessage;
  facts: { found: number; total: number };
  hasSources: boolean;
  confirmedQuotes: number;
  sentences: number;
  memoryMissing: string[];
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Sentences of the answer part (before the sources block). */
function countSentences(answer: string): number {
  return answer.split(/(?<=[.!?…])\s+(?=[А-ЯЁA-Z«"(–-])/u).filter((s) => s.trim().length > 3).length;
}

function memoryHas(memory: TaskMemory, field: Scenario['memory'][number]['field'], stem: string): boolean {
  const pool = field === 'any' ? [...memory.clarified, ...memory.constraints, ...memory.terms] : memory[field];
  // "a|b" accepts either spelling.
  return pool.some((x) => stem.split('|').some((alt) => norm(x).includes(norm(alt))));
}

async function judgeDialog(scenario: Scenario, results: TurnResult[], model: string): Promise<{ turns: TurnJudgement[]; goals: boolean[] }> {
  const dialog = results
    .map((r) => {
      return `#${r.index}. Пользователь: ${r.turn.text}\nАссистент: ${oneLine(r.reply.meta!.grounding.answer).slice(0, 700)}\nЦель в памяти: ${r.reply.meta!.memory.goal}`;
    })
    .join('\n\n');
  const prompt = [
    'Ты проверяешь длинный диалог пользователя с ассистентом, который отвечает по книге.',
    `Цель, которую поставил пользователь: ${scenario.goal}`,
    '',
    dialog,
    '',
    'Для каждого хода оцени:',
    '- answers: отвечает ли ассистент на то, что спросили в этом ходе, с учётом предыдущих ходов (местоимения, «там», «он»): yes / partial / no. Подтверждение записи уточнения или ограничения — yes. Честное «не знаю» на вопрос, ответа на который нет в книге, — yes; «не знаю» на вопрос по сюжету — no.',
    '- onGoal: работает ли ход на цель диалога (отвлечение пользователя от темы — не вина ассистента: onGoal=true, если ассистент не потерял цель).',
    'И отдельно для каждого хода — сохранена ли цель в «Цель в памяти» (та же цель по смыслу, что поставил пользователь): goalKept.',
    'Верни JSON {"turns": [{"turn": номер, "answers": "...", "onGoal": true|false, "goalKept": true|false, "comment": "коротко"}]}.',
  ].join('\n');
  const result = await callLlm(prompt, { format: 'json', temperature: 0, model }, 'rag-chat-check:judge');
  try {
    const parsed = JSON.parse(result.content) as { turns: (TurnJudgement & { goalKept: boolean })[] };
    const byTurn = new Map(parsed.turns.map((t) => [Number(t.turn), t]));
    const turns = results.map((r) => {
      const t = byTurn.get(r.index);
      return {
        turn: r.index,
        answers: (['yes', 'partial', 'no'].includes(t?.answers as string) ? t!.answers : 'no') as TurnJudgement['answers'],
        onGoal: !!t?.onGoal,
        comment: String(t?.comment ?? ''),
      };
    });
    return { turns, goals: results.map((r) => !!byTurn.get(r.index)?.goalKept) };
  } catch {
    return {
      turns: results.map((r) => ({ turn: r.index, answers: 'no', onGoal: false, comment: 'judge returned non-JSON' })),
      goals: results.map(() => false),
    };
  }
}

async function runScenario(service: RagChatService, scenario: Scenario): Promise<{ chat: RagChat; results: TurnResult[] }> {
  // A rerun replaces the previous run of the same scenario.
  service.list().filter((c) => c.title === scenario.title).forEach((c) => service.remove(c.id));
  const chat = service.create(scenario.title);
  const results: TurnResult[] = [];
  for (const [i, turn] of scenario.turns.entries()) {
    const index = i + 1;
    const { message } = await service.send(chat.id, turn.text);
    const g = message.meta!.grounding;
    const text = norm(g.answer);
    const expect = turn.expect ?? [];
    const memory = message.meta!.memory;
    results.push({
      turn,
      index,
      reply: message,
      facts: { found: expect.filter((e) => e.split('|').some((alt) => text.includes(norm(alt)))).length, total: expect.length },
      hasSources: g.status === 'answered' && g.sources.length > 0,
      confirmedQuotes: g.quotes.filter((q) => q.match !== 'not-found').length,
      sentences: countSentences(g.answer),
      memoryMissing: scenario.memory
        .filter((m) => index >= m.after && !memoryHas(memory, m.field, m.contains))
        .map((m) => `${m.field}∋«${m.contains}»`),
    });
    const kind = message.meta!.kind;
    console.log(
      `${scenario.id} #${index} [${kind}] ${g.status === 'unknown' ? `не знаю (${g.reason})` : `источников ${g.sources.length}, цитат ${g.quotes.filter((q) => q.match !== 'not-found').length}`}` +
        (expect.length ? ` · факты ${results[results.length - 1].facts.found}/${expect.length}` : '') +
        ` · запрос: ${message.meta!.searchQuery || '—'}`,
    );
  }
  return { chat: service.get(chat.id), results };
}

function render(scenario: Scenario, chat: RagChat, results: TurnResult[], judged: { turns: TurnJudgement[]; goals: boolean[] }): string[] {
  const search = results.filter((r) => r.reply.meta!.kind === 'search');
  const searchAnswered = search.filter((r) => r.reply.meta!.grounding.status === 'answered');
  const dialog = results.filter((r) => r.reply.meta!.kind === 'dialog');
  const notes = results.filter((r) => r.reply.meta!.kind === 'note');
  const unknown = results.filter((r) => r.reply.meta!.grounding.status === 'unknown');
  const facts = results.reduce((a, r) => ({ found: a.found + r.facts.found, total: a.total + r.facts.total }), { found: 0, total: 0 });
  const kindsOk = results.filter((r) => !r.turn.kind || r.turn.kind === r.reply.meta!.kind).length;
  const memoryOk = results.filter((r) => !r.memoryMissing.length).length;
  const lengthChecked = scenario.maxSentences ? searchAnswered.filter((r) => r.index >= scenario.maxSentences!.from) : [];
  const lengthOk = lengthChecked.filter((r) => r.sentences <= scenario.maxSentences!.max).length;
  const j = judged.turns;

  const lines = [
    `## ${scenario.title.replace('[сценарий] ', '')}`,
    '',
    `Цель пользователя: ${scenario.goal} Сообщений пользователя: ${results.length}.`,
    '',
    '| Проверка | Результат |',
    '|---|---|',
    `| Ответы по книге (search) с источниками и подтверждёнными цитатами | ${searchAnswered.filter((r) => r.hasSources && r.confirmedQuotes > 0).length}/${searchAnswered.length} выданных (ещё «не знаю»: ${search.length - searchAnswered.length}) |`,
    `| Итоги по диалогу (dialog) со ссылками на собранные источники | ${dialog.filter((r) => r.hasSources).length}/${dialog.length} |`,
    `| Уточнения и ограничения (note) записаны в память, без поиска | ${notes.length} |`,
    `| «Не знаю» | ${unknown.length}${unknown.length ? ` (${unknown.map((r) => `#${r.index}${r.turn.allowUnknown ? ' — ожидаемо' : ''}`).join(', ')})` : ''} |`,
    `| Ожидаемые факты в ответах | ${facts.found}/${facts.total} |`,
    `| Тип сообщения распознан как задумано | ${kindsOk}/${results.length} |`,
    `| Ограничения и термины держатся в памяти до конца | ${memoryOk}/${results.length} ходов |`,
    `| Цель в памяти сохранена (судья) | ${judged.goals.filter(Boolean).length}/${results.length} ходов |`,
    `| Ход работает на цель (судья) | ${j.filter((t) => t.onGoal).length}/${j.length} |`,
    `| Ответ по существу вопроса, с учётом контекста (судья) | ${j.filter((t) => t.answers === 'yes').length} да, ${j.filter((t) => t.answers === 'partial').length} частично, ${j.filter((t) => t.answers === 'no').length} нет |`,
    ...(scenario.maxSentences
      ? [`| Ограничение «≤ ${scenario.maxSentences.max} предложений» с хода ${scenario.maxSentences.from} | ${lengthOk}/${lengthChecked.length} ответов |`]
      : []),
    '',
    '**Память задачи в конце:**',
    '',
    '```',
    `Цель: ${chat.memory.goal}`,
    `Уточнено: ${chat.memory.clarified.join('; ') || '—'}`,
    `Ограничения: ${chat.memory.constraints.join('; ') || '—'}`,
    `Термины: ${chat.memory.terms.join('; ') || '—'}`,
    '```',
    '',
    '| # | Сообщение | Тип | Поисковый запрос | Ответ | Источники · цитаты | Факты | Судья |',
    '|---|---|---|---|---|---|---|---|',
    ...results.map((r) => {
      const g = r.reply.meta!.grounding;
      const t = j.find((x) => x.turn === r.index);
      const status = g.status === 'unknown' ? `не знаю (${g.reason})` : `${g.sources.length} · ${r.confirmedQuotes}`;
      return `| ${r.index} | ${r.turn.text} | ${r.reply.meta!.kind} | ${r.reply.meta!.searchQuery || '—'} | ${oneLine(g.answer).slice(0, 160).replace(/\|/g, '/')}${g.answer.length > 160 ? '…' : ''} | ${status} | ${r.facts.total ? `${r.facts.found}/${r.facts.total}` : '—'} | ${t ? `${t.answers}${t.onGoal ? '' : ', мимо цели'}` : ''} |`;
    }),
    '',
    '<details><summary>Диалог полностью</summary>',
    '',
    ...results.flatMap((r) => [
      `**${r.index}. Пользователь:** ${r.turn.text}`,
      '',
      ...r.reply.content.split('\n').map((l) => `> ${l}`),
      '',
      ...(r.memoryMissing.length ? [`⚠ нет в памяти: ${r.memoryMissing.join(', ')}`, ''] : []),
    ]),
    '</details>',
  ];
  return lines;
}

async function main() {
  const args = process.argv.slice(2);
  const file = path.join(__dirname, 'scenarios.json');
  const { scenarios } = JSON.parse(fs.readFileSync(file, 'utf8')) as { scenarios: Scenario[] };
  const only = flag(args, 'only')?.split(',');
  const judgeModel = flag(args, 'judge') ?? 'deepseek-v4-pro';
  const service = new RagChatService(new RagService());
  const sections: string[] = [];
  for (const scenario of scenarios.filter((s) => !only || only.includes(s.id))) {
    const { chat, results } = await runScenario(service, scenario);
    const judged = await judgeDialog(scenario, results, judgeModel);
    sections.push(...render(scenario, chat, results, judged), '');
  }
  const report = [
    '# Мини-чат с RAG и памятью задачи: длинные сценарии',
    '',
    `Каждое сообщение проходит: обновление памяти задачи + самостоятельный поисковый запрос → поиск (гибридный, cross-encoder, порог 0.2) → ответ с источниками и проверенными цитатами. ` +
      `Модель ответов: \`${process.env.LLM_MODEL ?? 'deepseek-v4-flash'}\`, судья: \`${judgeModel}\`. Диалоги сохранены и открываются на странице /rag-chat.`,
    '',
    ...sections,
  ].join('\n');
  const out = flag(args, 'report');
  if (out) {
    fs.writeFileSync(path.resolve(process.cwd(), out), report);
    console.log(`\nОтчёт: ${path.resolve(process.cwd(), out)}`);
  } else {
    console.log(`\n${report}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
