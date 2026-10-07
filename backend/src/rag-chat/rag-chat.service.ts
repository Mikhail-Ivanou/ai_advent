import { BadGatewayException, BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { callLlm, ChatMessage, sumUsage } from '../llm/llm.client';
import { groundAnswer, Grounding, lowRelevanceAnswer, renderGrounding } from '../rag/grounding';
import { formatRagContext } from '../rag/rag-answer';
import { normalizePipeline, PipelineConfig, runPipeline } from '../rag/rag-pipeline';
import { RagService } from '../rag/rag.service';
import { DEFAULT_CHAT_SETTINGS, EMPTY_MEMORY, RagChat, RagChatMessage, TaskMemory } from './rag-chat.types';

// Day 25: a mini chat with RAG and task memory. One turn:
//   1. task memory + standalone search query — one LLM call reads the memory,
//      the recent dialog and the new message, updates the goal / clarified /
//      constraints / terms, and turns a follow-up ("а он там был ранен?")
//      into a query that can be searched on its own;
//   2. retrieval through the Day 23 pipeline (hybrid search -> reranker ->
//      threshold) with that query;
//   3. nothing relevant enough -> "не знаю" + clarification (no LLM call);
//   4. otherwise the answer, with the memory and recent history in the
//      prompt, in the Day 24 format — sources and verified quotes always.
// A message about the dialog itself ("напомни цель", "подведи итог") skips
// retrieval: it is answered from the memory and history, and its sources are
// the ones gathered by the earlier answers — real chunks, never invented.

const DATA_FILE = path.resolve(__dirname, '../../data/rag-chats.json');
/** Messages of the dialog given to the answering model (the memory carries the rest). */
const HISTORY_MESSAGES = 10;
/** Messages the memory step reads besides the new one. */
const MEMORY_WINDOW = 6;

export interface RagChatSummary {
  id: string;
  title: string;
  updatedAt: string;
  messages: number;
  goal: string;
}

export function formatMemory(memory: TaskMemory): string {
  const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join('\n') : '- (нет)');
  return [
    `Цель диалога: ${memory.goal || '(ещё не задана)'}`,
    `Уже уточнено пользователем:\n${list(memory.clarified)}`,
    `Ограничения:\n${list(memory.constraints)}`,
    `Термины:\n${list(memory.terms)}`,
  ].join('\n');
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The confirmation for a "note" message: what changed in the task memory. */
function noteAnswer(before: TaskMemory, after: TaskMemory): Grounding {
  const added = (field: keyof Omit<TaskMemory, 'goal'>) => after[field].filter((x) => !before[field].includes(x));
  const changes = [
    ...(after.goal !== before.goal ? [`цель: ${after.goal}`] : []),
    ...added('clarified').map((x) => `уточнение: ${x}`),
    ...added('constraints').map((x) => `ограничение: ${x}`),
    ...added('terms').map((x) => `термин: ${x}`),
  ];
  const answer = changes.length
    ? `Принято, записал в память задачи:\n${changes.map((c) => `- ${c}`).join('\n')}\nЖду вопроса.`
    : 'Принято. Новых уточнений для памяти задачи не нашёл — задайте вопрос по документам.';
  return { status: 'answered', answer, sources: [], quotes: [], invalidRefs: [] };
}

function asList(value: unknown, previous: string[]): string[] {
  if (!Array.isArray(value)) return previous;
  return [...new Set(value.map((v) => String(v).trim()).filter(Boolean))].slice(0, 20);
}

@Injectable()
export class RagChatService {
  private chats = new Map<string, RagChat>();
  /** One turn at a time per chat — a turn reads and rewrites the chat's memory. */
  private readonly locks = new Map<string, Promise<unknown>>();

  /** mtime of the file as last read or written — the CLI scenario check and the server share it. */
  private loadedAt = -1;

  constructor(private readonly ragService: RagService) {
    this.sync();
  }

  private sync(): void {
    const mtime = fs.existsSync(DATA_FILE) ? fs.statSync(DATA_FILE).mtimeMs : 0;
    if (mtime === this.loadedAt) return;
    this.loadedAt = mtime;
    try {
      const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) as RagChat[];
      this.chats = new Map(saved.map((c) => [c.id, c]));
    } catch {
      // No chats yet.
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(`${DATA_FILE}.tmp`, JSON.stringify([...this.chats.values()], null, 1));
    fs.renameSync(`${DATA_FILE}.tmp`, DATA_FILE);
    this.loadedAt = fs.statSync(DATA_FILE).mtimeMs;
  }

  private withLock<T>(id: string, job: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(id) ?? Promise.resolve()).then(job);
    this.locks.set(
      id,
      run.catch(() => undefined),
    );
    return run;
  }

  list(): RagChatSummary[] {
    this.sync();
    return [...this.chats.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((c) => ({
        id: c.id,
        title: c.title,
        updatedAt: c.updatedAt,
        messages: c.messages.length,
        goal: c.memory.goal,
      }));
  }

  get(id: string): RagChat {
    this.sync();
    const chat = this.chats.get(id);
    if (!chat) throw new NotFoundException(`No chat ${id}`);
    return chat;
  }

  create(title?: string, settings?: Partial<PipelineConfig>): RagChat {
    const now = new Date().toISOString();
    const chat: RagChat = {
      id: randomUUID(),
      title: title?.trim() || 'Новый диалог',
      createdAt: now,
      updatedAt: now,
      messages: [],
      memory: structuredClone(EMPTY_MEMORY),
      settings: { ...DEFAULT_CHAT_SETTINGS, ...settings },
    };
    this.chats.set(chat.id, chat);
    this.save();
    return chat;
  }

  remove(id: string): void {
    this.get(id);
    this.chats.delete(id);
    this.save();
  }

  /** Manual edit of the task memory (the UI lets the user fix or reset it). */
  setMemory(id: string, memory: Partial<TaskMemory>): RagChat {
    const chat = this.get(id);
    chat.memory = {
      goal: typeof memory.goal === 'string' ? memory.goal.trim() : chat.memory.goal,
      clarified: asList(memory.clarified, chat.memory.clarified),
      constraints: asList(memory.constraints, chat.memory.constraints),
      terms: asList(memory.terms, chat.memory.terms),
    };
    chat.updatedAt = new Date().toISOString();
    this.save();
    return chat;
  }

  setSettings(id: string, settings: Partial<PipelineConfig>): RagChat {
    const chat = this.get(id);
    chat.settings = { ...chat.settings, ...settings };
    this.save();
    return chat;
  }

  /**
   * Step 1: one LLM call updates the task memory and rewrites the message
   * into a standalone search query. The memory holds what the *user* set —
   * not facts from the answers, which live in the history and the sources.
   */
  private async updateMemory(
    chat: RagChat,
    message: string,
    model?: string,
  ): Promise<{
    memory: TaskMemory;
    searchQuery: string;
    kind: 'search' | 'dialog' | 'note';
    tokens?: number;
  }> {
    const recent = chat.messages
      .slice(-MEMORY_WINDOW)
      .map(
        (m) =>
          `${m.role === 'user' ? 'Пользователь' : 'Ассистент'}: ${clip(m.role === 'user' ? m.content : m.content.split('\nИсточники:')[0], 400)}`,
      )
      .join('\n');
    const prompt = [
      'Ты ведёшь «память задачи» диалога с ассистентом, который отвечает по документам (книге) через поиск.',
      'Обнови память по новому сообщению пользователя и составь поисковый запрос.',
      '',
      'Текущая память (JSON):',
      JSON.stringify(chat.memory),
      '',
      'Последние сообщения диалога:',
      recent || '(диалог только начинается)',
      '',
      `Новое сообщение пользователя: ${message}`,
      '',
      'Правила памяти:',
      '- goal — цель всего диалога одной фразой. Задаётся первым содержательным сообщением; меняется, только если пользователь явно меняет цель. Отдельные вопросы — это шаги к цели, а не новая цель.',
      '- clarified — что пользователь уточнил явной репликой: кого или что он имеет в виду («под «он» — Ник», «речь о второй части»). Темы и предметы его вопросов сюда не пиши («роботы-диски», «эпизод под Барселоной» — это вопросы, не уточнения); факты из ответов ассистента — тоже нет.',
      '- constraints — требования пользователя к ответам: длина, формат, язык, рамки (например «только по книге»).',
      '- terms — только термины, которые пользователь сам ввёл или определил («термин: …», «X — это Y»): «термин — значение». Определения из ответов ассистента (кто такие риперы и т. п.) сюда не пиши.',
      '- Ничего не удаляй, если пользователь не отменил это явно; дубликаты не добавляй; формулируй коротко.',
      '',
      'searchQuery — самостоятельный поисковый запрос по тексту книги для нового сообщения: сохрани то, о чём именно спрашивают (корабль, возраст, откуда родом, что предложил), раскрой местоимения и отсылки («он», «там», «туда») через память и диалог одним именем, без синонимов и пояснений в скобках; добавь 2–4 слова, которые вероятно стоят в тексте рядом с ответом (например, для «после войны» — «после победы, в конце, уехать»). Не пиши ответ. Если сообщение — не вопрос по содержанию (например, «подведи итог»), сделай запрос по теме цели и последних вопросов.',
      '',
      'kind — "note", если в сообщении нет вопроса, а только уточнение, ограничение или термин («пиши кратко», «дальше «он» — это Ник»); "dialog", если вопрос о самом диалоге (напомнить цель, подвести итог собранного, повторить ограничения) и нового поиска по книге не требует; иначе "search".',
      '',
      'Верни JSON: {"memory": {"goal": "...", "clarified": [...], "constraints": [...], "terms": [...]}, "searchQuery": "...", "kind": "search" | "dialog" | "note"}',
    ].join('\n');
    const result = await callLlm(prompt, { format: 'json', temperature: 0, model }, 'rag-chat:memory');
    try {
      const parsed = JSON.parse(result.content) as {
        memory?: Partial<TaskMemory>;
        searchQuery?: string;
        kind?: string;
      };
      const m = parsed.memory ?? {};
      return {
        memory: {
          goal: typeof m.goal === 'string' && m.goal.trim() ? m.goal.trim() : chat.memory.goal,
          clarified: asList(m.clarified, chat.memory.clarified),
          constraints: asList(m.constraints, chat.memory.constraints),
          terms: asList(m.terms, chat.memory.terms),
        },
        searchQuery: String(parsed.searchQuery ?? '').trim() || message,
        // A dialog-level answer needs something to stand on: without earlier sources, search instead.
        kind:
          parsed.kind === 'note'
            ? 'note'
            : parsed.kind === 'dialog' && this.gatheredSources(chat).length
              ? 'dialog'
              : 'search',
        tokens: result.usage?.totalTokens,
      };
    } catch {
      // A broken memory update must not lose the memory: keep it, search with the message.
      return {
        memory: chat.memory,
        searchQuery: message,
        kind: 'search',
        tokens: result.usage?.totalTokens,
      };
    }
  }

  /** Sources of all earlier confirmed answers, deduplicated — what a summary of the dialog can stand on. */
  private gatheredSources(chat: RagChat): Grounding['sources'] {
    const seen = new Map<string, Grounding['sources'][number]>();
    for (const m of chat.messages) {
      const g = m.meta?.grounding;
      if (m.meta?.kind === 'search' && g?.status === 'answered')
        g.sources.forEach((s) => seen.has(s.chunk_id) || seen.set(s.chunk_id, s));
    }
    return [...seen.values()].map((s, i) => ({ ...s, n: i + 1 }));
  }

  /** A message about the dialog itself: answered from memory + history, citing the sources gathered so far. */
  private async answerFromDialog(
    chat: RagChat,
    text: string,
    memory: TaskMemory,
    model?: string,
  ): Promise<{ grounding: Grounding; model: string; tokens?: number }> {
    const sources = this.gatheredSources(chat);
    const label = new Map(sources.map((s) => [s.chunk_id, `[S${s.n}]`]));
    // The dialog as the model sees it here: earlier answers without their own
    // [1]..[n] numbering (local to each answer, it would be cited by mistake),
    // each followed by the dialog-wide labels of its sources.
    const history = chat.messages.slice(0, -1).map((m) => {
      const g = m.meta?.grounding;
      if (m.role === 'assistant' && m.meta?.kind === 'search' && g?.status === 'answered') {
        const own = g.sources.map((s) => label.get(s.chunk_id)).filter(Boolean);
        return {
          role: m.role,
          content: `${g.answer.replace(/\s*\[\d+\]/g, '')}\nИсточники этого ответа: ${own.join(', ')}`,
        };
      }
      return { role: m.role, content: m.meta?.grounding.answer ?? m.content };
    });
    const list = sources
      .map((s) => `[S${s.n}] ${s.title} — ${s.section.split(' › ').pop()} (${s.chunk_id})`)
      .join('\n');
    const result = await callLlm(
      text,
      {
        model,
        temperature: 0.2,
        // The whole dialog: a summary must cover every step, not the last few.
        history,
        dialogMemory:
          `${formatMemory(memory)}\n\nThe message is about the dialog itself. Answer from the task memory and the answers above only — ` +
          `add nothing about the documents that was not in those answers. After each point, cite the sources of the answer it comes from ` +
          `with their labels exactly as written — [S1], [S2]… (use only these labels, no other numbering). Plain text, no markdown.\n` +
          `Sources gathered in this dialog:\n${list}`,
      },
      'rag-chat:dialog',
    );
    const answer = result.content.replace(/\*\*/g, '').trim();
    const cited = new Set([...answer.matchAll(/\[S(\d+)\]/g)].map((m) => Number(m[1])));
    const used = sources.filter((s) => cited.has(s.n));
    return {
      grounding: {
        status: 'answered',
        answer,
        // Every source of the dialog is listed when the summary cites none explicitly.
        sources: used.length ? used : sources,
        quotes: [],
        invalidRefs: [...cited].filter((n) => n < 1 || n > sources.length),
      },
      model: result.model,
      tokens: result.usage?.totalTokens,
    };
  }

  send(id: string, content: string, model?: string): Promise<{ chat: RagChat; message: RagChatMessage }> {
    const text = content?.trim();
    if (!text) throw new BadRequestException('content is required');
    return this.withLock(id, async () => {
      const chat = this.get(id);
      const before = {
        messages: chat.messages.length,
        memory: chat.memory,
        title: chat.title,
      };
      try {
        // The chat's own model setting (Day 28: may be a local one) unless the request names one.
        return await this.turn(chat, text, model ?? chat.settings.model);
      } catch (error) {
        // A failed turn (LLM unreachable…) leaves the chat as it was.
        chat.messages.length = before.messages;
        chat.memory = before.memory;
        chat.title = before.title;
        throw new BadGatewayException(error instanceof Error ? error.message : 'LLM request failed');
      }
    });
  }

  private async turn(chat: RagChat, text: string, model?: string): Promise<{ chat: RagChat; message: RagChatMessage }> {
    const started = Date.now();
    const history: ChatMessage[] = chat.messages
      .slice(-HISTORY_MESSAGES)
      .map((m) => ({ role: m.role, content: m.content }));
    chat.messages.push({
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
    });
    if (chat.title === 'Новый диалог') chat.title = clip(text, 60);

    const previousMemory = chat.memory;
    const { memory, searchQuery, kind, tokens: memoryTokens } = await this.updateMemory(chat, text, model);
    chat.memory = memory;

    if (kind === 'note') {
      // Only a clarification / constraint / term: confirm what was recorded, search nothing.
      return this.reply(chat, noteAnswer(previousMemory, memory), {
        kind,
        searchQuery: '',
        candidates: 0,
        hits: [],
        model: 'memory',
        durationMs: Date.now() - started,
        tokens: memoryTokens,
        memory: structuredClone(memory),
      });
    }

    if (kind === 'dialog') {
      const answer = await this.answerFromDialog(chat, text, memory, model);
      return this.reply(chat, answer.grounding, {
        kind,
        searchQuery: '',
        candidates: 0,
        hits: [],
        model: answer.model,
        durationMs: Date.now() - started,
        tokens: (memoryTokens ?? 0) + (answer.tokens ?? 0) || undefined,
        memory: structuredClone(memory),
      });
    }

    const cfg = normalizePipeline({ ...chat.settings, model });
    // The reranker judges chunks against the standalone query — the raw
    // message ("а он там был ранен?") says too little on its own.
    // The raw message is searched too and fused: if the standalone query drifted, its own words still count.
    const pipeline = await runPipeline(this.ragService, searchQuery, cfg, [text]);

    let grounding: Grounding;
    let modelName = 'rag-guard';
    let answerTokens: number | undefined;
    if (!pipeline.hits.length) {
      grounding = lowRelevanceAnswer(pipeline.candidates, cfg.minScore);
      if (memory.goal) grounding.answer += ` Цель диалога прежняя: ${memory.goal}`;
    } else {
      const result = await callLlm(
        text,
        {
          model,
          temperature: 0.2,
          history,
          dialogMemory: formatMemory(memory),
          ragContext: formatRagContext(pipeline.hits),
        },
        'rag-chat:answer',
      );
      grounding = groundAnswer(result.content, pipeline.hits);
      modelName = result.model;
      answerTokens = sumUsage(result.usage, pipeline.usage)?.totalTokens;
    }

    return this.reply(chat, grounding, {
      kind,
      searchQuery,
      candidates: pipeline.candidates.length,
      hits: pipeline.hits.map((h) => ({
        chunk_id: h.metadata.chunk_id,
        score: h.score,
        rerankScore: h.rerankScore,
        section: h.metadata.section,
        text: h.text,
      })),
      model: modelName,
      durationMs: Date.now() - started,
      tokens: (memoryTokens ?? 0) + (answerTokens ?? 0) || undefined,
      memory: structuredClone(memory),
    });
  }

  private reply(
    chat: RagChat,
    grounding: Grounding,
    meta: Omit<NonNullable<RagChatMessage['meta']>, 'grounding'>,
  ): { chat: RagChat; message: RagChatMessage } {
    const message: RagChatMessage = {
      role: 'assistant',
      content:
        meta.kind === 'note'
          ? grounding.answer
          : meta.kind === 'dialog'
            ? `${grounding.answer}\n\nИсточники (собраны в этом диалоге):\n${grounding.sources.map((s) => `[S${s.n}] ${s.title} › ${s.section.split(' › ').slice(-2).join(' › ')} (${s.chunk_id})`).join('\n')}`
            : renderGrounding(grounding),
      createdAt: new Date().toISOString(),
      meta: { ...meta, grounding },
    };
    chat.messages.push(message);
    chat.updatedAt = message.createdAt;
    this.save();
    return { chat, message };
  }
}
