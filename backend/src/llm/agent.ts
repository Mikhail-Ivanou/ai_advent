import {
  AskOptions,
  ChatMessage,
  LlmRequestLog,
  LlmUsage,
  ReasoningMode,
  callLlm,
  callLlmWithReasoning,
  estimateCostByn,
} from './llm.client';
import { routeMemory } from './memory-router';
import { LongTermMemoryProposal } from '../memory/memory.types';
import { countHistoryTokens, countTokens } from './tokenizer';

export interface TokenCounts {
  /** Tokens in the new user prompt alone. */
  requestTokens: number;
  /** Tokens in the context actually sent with this request (recent history, summary and/or facts — excludes the new prompt). */
  historyTokens: number;
  /** Tokens in the model's reply. */
  responseTokens: number;
}

export type ContextStrategy = 'none' | 'sliding-window' | 'summary' | 'sticky-facts' | 'branching';

export interface ContextConfig {
  strategy: ContextStrategy;
  /** How many of the most recent messages to keep verbatim (sliding-window, summary, sticky-facts). */
  keepLastN: number;
}

export interface ContextInfo {
  strategy: ContextStrategy;
  keepLastN: number;
  /** How many recent messages are sent verbatim. */
  recentMessageCount: number;
  /** summary strategy only: how many older messages have been folded into `summary`. */
  summarizedMessageCount?: number;
  summary?: string;
  /** Present only on a turn that actually triggered a summary update. */
  summaryUpdate?: { usage?: LlmUsage; costByn?: number };
  /** sticky-facts strategy only: the current key-value memory. */
  facts?: Record<string, string>;
  /** Present only on a turn that actually triggered a facts update. */
  factsUpdate?: { usage?: LlmUsage; costByn?: number };
  /** branching strategy only. */
  activeBranchId?: string;
  branches?: { id: string; messageCount: number }[];
}

/**
 * The memory model (Day 11): three layers, stored and reasoned about
 * separately —
 * - short-term: the current dialog (`Agent.history` / the active context
 *   strategy above — nothing new needed here, it's what Day 9/10 already do).
 * - working: `Agent.workingMemory`, task-scoped data for THIS chat only.
 * - long-term: profile/decisions/knowledge, global across chats — owned by
 *   MemoryService, not the Agent, so it survives a chat being deleted.
 */
export interface MemoryConfig {
  /** Inject working memory into the prompt this turn. Default true. */
  useWorking?: boolean;
  /** Inject long-term memory into the prompt this turn. Default true. */
  useLongTerm?: boolean;
  /** Run the memory-routing step after this turn to update working/long-term memory. Default true. */
  update?: boolean;
}

export interface MemoryInfo {
  working: Record<string, string>;
  usedWorking: boolean;
  usedLongTerm: boolean;
  /** Long-term facts this turn's routing step proposed — already applied to the global store by the caller (AgentsService). */
  longTermAdded: LongTermMemoryProposal[];
  /** Present only on a turn that actually ran the routing step. */
  update?: { usage?: LlmUsage; costByn?: number };
}

export interface AgentAskResult {
  answer: string;
  model: string;
  responseTimeMs: number;
  usage?: LlmUsage;
  costByn?: number;
  tokens: TokenCounts;
  context?: ContextInfo;
  memory?: MemoryInfo;
  /** The exact request(s) sent to the API for this turn, including any summarization/facts-extraction/memory-routing calls. */
  requests: LlmRequestLog[];
}

// Cap on how many messages get folded into the summary in one LLM call. Compaction
// itself runs whenever the unsummarized tail exceeds keepLastN (so "last N as-is"
// actually holds after every turn); this only limits the size of each individual
// summarization request when there's a large backlog to fold in.
const COMPACTION_BATCH_SIZE = 10;

function sumUsage(a?: LlmUsage, b?: LlmUsage): LlmUsage | undefined {
  if (!a && !b) return undefined;
  return {
    promptTokens: (a?.promptTokens ?? 0) + (b?.promptTokens ?? 0),
    completionTokens: (a?.completionTokens ?? 0) + (b?.completionTokens ?? 0),
    totalTokens: (a?.totalTokens ?? 0) + (b?.totalTokens ?? 0),
  };
}

function formatChunkForSummary(messages: ChatMessage[]): string {
  return messages.map((m) => `${m.role === 'user' ? 'Пользователь' : 'Ассистент'}: ${m.content}`).join('\n\n');
}

async function summarizeChunk(
  previousSummary: string,
  chunk: ChatMessage[],
  model?: string,
): Promise<{ summary: string; usage?: LlmUsage; costByn?: number; requests: LlmRequestLog[] }> {
  const prompt = `Ты помогаешь сжимать историю диалога, чтобы сэкономить контекст модели.
${previousSummary ? `Уже есть краткое содержание более ранней части разговора:\n"""${previousSummary}"""\n\n` : ''}Вот следующий фрагмент диалога, который нужно добавить в краткое содержание:
"""
${formatChunkForSummary(chunk)}
"""

Перепиши краткое содержание целиком (старое + новый фрагмент), сохранив все важные факты, договорённости, имена и детали, нужные для продолжения разговора. Пиши компактно, без вводных фраз — сразу суть.`;

  const result = await callLlm(prompt, { model, temperature: 0.2, maxOutputTokens: 600 }, 'compaction:summarize');
  const costByn = estimateCostByn(result.model, result.usage);
  return { summary: result.content.trim(), usage: result.usage, costByn, requests: result.requests };
}

function formatFacts(facts: Record<string, string>): string {
  const entries = Object.entries(facts);
  if (entries.length === 0) return '(пока ничего не известно)';
  return entries.map(([key, value]) => `${key}: ${value}`).join('\n');
}

function formatWorkingMemory(working: Record<string, string>): string {
  const entries = Object.entries(working);
  if (entries.length === 0) return '(пока пусто)';
  return entries.map(([key, value]) => `${key}: ${value}`).join('\n');
}

async function updateFacts(
  existingFacts: Record<string, string>,
  userMessage: string,
  model?: string,
): Promise<{ facts: Record<string, string>; usage?: LlmUsage; costByn?: number; requests: LlmRequestLog[] }> {
  const prompt = `Ты ведёшь структурированную память диалога в виде пар ключ-значение (JSON-объект).
Текущие факты:
${formatFacts(existingFacts)}

Новое сообщение пользователя:
"""
${userMessage}
"""

Обнови факты с учётом этого сообщения: добавь новые ключи для целей, ограничений, предпочтений, решений и договорённостей, если они появились; обнови значения существующих ключей, если они изменились. Не удаляй ключи, которые новое сообщение не отменяет.
Верни ТОЛЬКО валидный JSON-объект (ключи и значения — строки), без пояснений и markdown.`;

  const result = await callLlm(
    prompt,
    { model, format: 'json', temperature: 0.1, maxOutputTokens: 500 },
    'sticky-facts:update',
  );
  const costByn = estimateCostByn(result.model, result.usage);

  let facts = existingFacts;
  try {
    const parsed = JSON.parse(result.content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      facts = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
    }
  } catch {
    // Model didn't return valid JSON this turn — keep the facts we already had.
  }

  return { facts, usage: result.usage, costByn, requests: result.requests };
}

/**
 * Encapsulates a request/response cycle with the LLM: takes a user prompt,
 * calls the API with whatever context the active strategy decides to include,
 * and shapes the reply — so callers never talk to callLlm* directly.
 *
 * Context strategies (mutually exclusive, picked per request):
 * - none: send the full conversation, no management.
 * - sliding-window: send only the last `keepLastN` messages; everything older
 *   is simply not sent (still kept in `history` for the record).
 * - summary: last `keepLastN`-ish messages verbatim + a running summary of
 *   everything older (see Day 9).
 * - sticky-facts: a key-value memory (`facts`), refreshed from every new user
 *   message, sent alongside the last `keepLastN` messages instead of a summary.
 * - branching: `history` is a checked-out branch of a tree (`branches`) —
 *   independent conversations that share a common prefix up to the point they
 *   were forked. The full active branch is sent, unmanaged.
 *
 * State lives on the instance only; callers that want it to survive a
 * restart are responsible for loading it in and persisting it back out
 * (see AgentsService).
 */
export class Agent {
  branches: Record<string, ChatMessage[]>;
  activeBranchId: string;
  summary: string;
  summarizedThroughIndex: number;
  facts: Record<string, string>;
  /** Working memory (Day 11): task-scoped data for this chat only — never shared with other chats. */
  workingMemory: Record<string, string>;

  constructor(
    readonly id: string,
    branches: Record<string, ChatMessage[]> = { main: [] },
    activeBranchId: string = 'main',
    summary: string = '',
    summarizedThroughIndex: number = 0,
    facts: Record<string, string> = {},
    workingMemory: Record<string, string> = {},
  ) {
    this.branches = branches;
    this.activeBranchId = activeBranchId;
    this.summary = summary;
    this.summarizedThroughIndex = summarizedThroughIndex;
    this.facts = facts;
    this.workingMemory = workingMemory;
  }

  /** The active branch's messages — a live reference, so pushing onto it mutates `branches` directly. */
  get history(): ChatMessage[] {
    if (!this.branches[this.activeBranchId]) this.branches[this.activeBranchId] = [];
    return this.branches[this.activeBranchId];
  }

  createBranch(name: string, fromBranchId?: string): void {
    if (this.branches[name]) throw new Error(`Branch "${name}" already exists`);
    const source = this.branches[fromBranchId ?? this.activeBranchId] ?? [];
    this.branches[name] = [...source];
  }

  switchBranch(branchId: string): void {
    if (!this.branches[branchId]) throw new Error(`Unknown branch: ${branchId}`);
    this.activeBranchId = branchId;
  }

  deleteBranch(branchId: string): void {
    if (Object.keys(this.branches).length <= 1) throw new Error('Cannot delete the only remaining branch');
    if (!this.branches[branchId]) throw new Error(`Unknown branch: ${branchId}`);
    delete this.branches[branchId];
    if (this.activeBranchId === branchId) {
      this.activeBranchId = Object.keys(this.branches)[0];
    }
  }

  listBranches(): { id: string; messageCount: number }[] {
    return Object.entries(this.branches).map(([id, messages]) => ({ id, messageCount: messages.length }));
  }

  /** Explicit reset of the working layer — e.g. when the user's done with the current task and doesn't want stale task data leaking into the next one. */
  clearWorkingMemory(): void {
    this.workingMemory = {};
  }

  async ask(
    prompt: string,
    reasoningMode?: ReasoningMode,
    options?: AskOptions,
    contextConfig?: ContextConfig,
    memoryConfig?: MemoryConfig,
    /** Long-term memory formatted for the prompt — owned by MemoryService, passed in since Agent doesn't hold it. */
    longTermMemoryText?: string,
  ): Promise<AgentAskResult> {
    const strategy = contextConfig?.strategy ?? 'none';
    const keepLastN = Math.max(0, contextConfig?.keepLastN ?? 0);

    const useWorkingMemory = memoryConfig?.useWorking ?? true;
    const useLongTermMemory = memoryConfig?.useLongTerm ?? true;
    const updateMemory = memoryConfig?.update ?? true;
    const workingMemoryForPrompt = useWorkingMemory ? formatWorkingMemory(this.workingMemory) : undefined;
    const longTermMemoryForPrompt = useLongTermMemory ? longTermMemoryText : undefined;

    let factsUpdate: ContextInfo['factsUpdate'];
    let factsRequests: LlmRequestLog[] = [];
    if (strategy === 'sticky-facts') {
      // Update from the incoming message first, so this very turn's answer can
      // already use whatever just changed (a new goal, constraint, etc.).
      const updated = await updateFacts(this.facts, prompt, options?.model);
      this.facts = updated.facts;
      factsRequests = updated.requests;
      factsUpdate = { usage: updated.usage, costByn: updated.costByn };
    }

    let contextHistory: ChatMessage[];
    let summaryForPrompt: string | undefined;
    let factsForPrompt: string | undefined;

    switch (strategy) {
      case 'sliding-window':
        contextHistory = keepLastN > 0 ? this.history.slice(-keepLastN) : [];
        break;
      case 'summary':
        // Everything since the last compaction point — never jump straight to
        // "last N", or messages that fell out of that window but haven't been
        // folded into the summary yet would just vanish from context.
        contextHistory = this.history.slice(this.summarizedThroughIndex);
        summaryForPrompt = this.summary || undefined;
        break;
      case 'sticky-facts':
        contextHistory = keepLastN > 0 ? this.history.slice(-keepLastN) : [];
        factsForPrompt = formatFacts(this.facts);
        break;
      case 'branching':
      case 'none':
      default:
        contextHistory = this.history;
        break;
    }

    const requestTokens = countTokens(prompt);
    const historyTokens =
      countHistoryTokens(contextHistory) +
      (summaryForPrompt ? countTokens(summaryForPrompt) : 0) +
      (factsForPrompt ? countTokens(factsForPrompt) : 0) +
      (workingMemoryForPrompt ? countTokens(workingMemoryForPrompt) : 0) +
      (longTermMemoryForPrompt ? countTokens(longTermMemoryForPrompt) : 0);

    const start = Date.now();
    const result = await callLlmWithReasoning(prompt, reasoningMode, {
      ...options,
      history: contextHistory,
      summary: summaryForPrompt,
      facts: factsForPrompt,
      workingMemory: workingMemoryForPrompt,
      longTermMemory: longTermMemoryForPrompt,
    });
    const responseTimeMs = Date.now() - start;
    const costByn = estimateCostByn(result.model, result.usage);
    const responseTokens = countTokens(result.content);

    this.history.push({ role: 'user', content: prompt }, { role: 'assistant', content: result.content });

    let summaryUpdate: ContextInfo['summaryUpdate'];
    let compactionRequests: LlmRequestLog[] = [];
    if (strategy === 'summary') {
      ({ summaryUpdate, requests: compactionRequests } = await this.maybeCompact(keepLastN, options?.model));
    }

    // Memory-routing step: an explicit, separate decision about what (if
    // anything) from this exchange belongs in working memory vs long-term
    // memory — run after the answer so it can react to what the agent just
    // said, not just the raw prompt.
    let memory: MemoryInfo | undefined;
    let memoryRequests: LlmRequestLog[] = [];
    if (updateMemory) {
      const routed = await routeMemory(this.workingMemory, longTermMemoryText, prompt, result.content, options?.model);
      this.workingMemory = routed.working;
      memoryRequests = routed.requests;
      memory = {
        working: this.workingMemory,
        usedWorking: useWorkingMemory,
        usedLongTerm: useLongTermMemory,
        longTermAdded: routed.longTerm,
        update: { usage: routed.usage, costByn: routed.costByn },
      };
    } else {
      memory = {
        working: this.workingMemory,
        usedWorking: useWorkingMemory,
        usedLongTerm: useLongTermMemory,
        longTermAdded: [],
      };
    }

    const context: ContextInfo = {
      strategy,
      keepLastN,
      recentMessageCount: contextHistory.length,
    };
    if (strategy === 'summary') {
      context.summarizedMessageCount = this.summarizedThroughIndex;
      context.recentMessageCount = this.history.length - this.summarizedThroughIndex;
      context.summary = this.summary;
      context.summaryUpdate = summaryUpdate;
    }
    if (strategy === 'sticky-facts') {
      context.facts = this.facts;
      context.factsUpdate = factsUpdate;
    }
    if (strategy === 'branching') {
      context.activeBranchId = this.activeBranchId;
      context.branches = this.listBranches();
    }

    return {
      answer: result.content,
      model: result.model,
      responseTimeMs,
      usage: result.usage,
      costByn,
      tokens: { requestTokens, historyTokens, responseTokens },
      context,
      memory,
      requests: [...factsRequests, ...result.requests, ...compactionRequests, ...memoryRequests],
    };
  }

  // Brings the unsummarized tail back down to keepLastN, so "last N as-is" is
  // an actual bound after every turn — not something that only gets caught up
  // once 10 extra messages have piled on. Large backlogs (e.g. compression
  // just turned on for a long-running chat) are folded a batch at a time
  // rather than in one giant summarization call.
  private async maybeCompact(
    keepLastN: number,
    model?: string,
  ): Promise<{ summaryUpdate: ContextInfo['summaryUpdate']; requests: LlmRequestLog[] }> {
    let summaryUpdate: ContextInfo['summaryUpdate'];
    const requests: LlmRequestLog[] = [];

    while (true) {
      const unsummarized = this.history.length - this.summarizedThroughIndex;
      const overflow = unsummarized - keepLastN;
      if (overflow <= 0) break;

      const chunkSize = Math.min(overflow, COMPACTION_BATCH_SIZE);
      const chunk = this.history.slice(this.summarizedThroughIndex, this.summarizedThroughIndex + chunkSize);
      const { summary, usage, costByn, requests: chunkRequests } = await summarizeChunk(this.summary, chunk, model);
      this.summary = summary;
      this.summarizedThroughIndex += chunk.length;
      requests.push(...chunkRequests);

      summaryUpdate = {
        usage: sumUsage(summaryUpdate?.usage, usage),
        costByn: (summaryUpdate?.costByn ?? 0) + (costByn ?? 0),
      };
    }

    return { summaryUpdate, requests };
  }
}
