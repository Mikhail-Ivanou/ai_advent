import {
  AskOptions,
  ChatMessage,
  LlmRequestLog,
  LlmUsage,
  ReasoningMode,
  ToolCallLog,
  callLlm,
  callLlmWithReasoning,
  estimateCostByn,
} from './llm.client';
import { routeMemory } from './memory-router';
import { LongTermMemoryProposal } from '../memory/memory.types';
import { TaskStage, TaskState, formatTaskState, isValidTaskTransition, updateTaskState } from './task-state';
import { InvariantViolation, checkInvariantCompliance } from './invariant-check';
import { Invariant } from '../invariant/invariant.types';
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

/**
 * Task state (Day 13): a formal state machine — planning → execution →
 * validation → done (validation may bounce back to execution) — tracked
 * alongside the memory layers, not folded into working memory: this is
 * specifically *where the task is*, not arbitrary facts about it.
 */
export interface TaskConfig {
  /** Run the state-transition step after this turn. Default true. Ignored (treated as false) while the task is paused. */
  update?: boolean;
}

export interface TaskInfo {
  task: TaskState | null;
  /** True only on a turn that actually changed the task (new task, stage/step/expectedAction change) — not just re-confirmed the same state. */
  updated: boolean;
  /** Present only on a turn that actually ran the update step (i.e. not paused, not skipped). */
  update?: { usage?: LlmUsage; costByn?: number };
}

/**
 * Invariants (Day 14): hard constraints on the solution space — architecture,
 * accepted technical decisions, stack limits, business rules. Unlike memory
 * and task state, Agent holds no state of its own for these: the list is
 * global (owned by InvariantService) and never mutated by a conversation, so
 * it's passed in fresh on every call rather than stored on the instance.
 */
export interface McpConfig {
  /** Offer tools from connected MCP servers to the model this turn (Day 17). Default true — a no-op while nothing is connected. */
  useTools?: boolean;
}

export interface InvariantConfig {
  /** Inject invariants into the prompt as hard constraints this turn. Default true. */
  use?: boolean;
  /** Run the compliance-check step after this turn. Default true. Skipped automatically when there are no invariants to check against. */
  check?: boolean;
}

export interface InvariantCheckInfo {
  used: boolean;
  checked: boolean;
  /** Present only when `checked` is true. */
  compliant?: boolean;
  violations?: InvariantViolation[];
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
  task?: TaskInfo;
  invariants?: InvariantCheckInfo;
  /** Which personalization profile (if any) was applied to this turn — populated by AgentsService, since Agent itself only sees the already-formatted text (Day 12). */
  profile?: { id: string; name: string };
  /** MCP tool calls the model made while producing `answer` (Day 17). */
  toolCalls?: ToolCallLog[];
  /** The exact request(s) sent to the API for this turn, including any summarization/facts-extraction/memory-routing/task-state/invariant-check calls. */
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

function formatInvariants(invariants: Pick<Invariant, 'title' | 'rule'>[]): string {
  return invariants.map((i) => `- [${i.title}] ${i.rule}`).join('\n');
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
  /** Task state (Day 13): the formalized planning/execution/validation/done machine for this chat. Null until a multi-step task is detected. */
  taskState: TaskState | null;

  constructor(
    readonly id: string,
    branches: Record<string, ChatMessage[]> = { main: [] },
    activeBranchId: string = 'main',
    summary: string = '',
    summarizedThroughIndex: number = 0,
    facts: Record<string, string> = {},
    workingMemory: Record<string, string> = {},
    taskState: TaskState | null = null,
  ) {
    this.branches = branches;
    this.activeBranchId = activeBranchId;
    this.summary = summary;
    this.summarizedThroughIndex = summarizedThroughIndex;
    this.facts = facts;
    this.workingMemory = workingMemory;
    this.taskState = taskState;
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

  /** Freezes task state: the update step is skipped entirely on later turns until resumed, so nothing drifts while parked (Day 13, "pause at any stage"). */
  pauseTask(): void {
    if (!this.taskState) throw new Error('No active task to pause');
    this.taskState = { ...this.taskState, paused: true };
  }

  /** Unfreezes task state — the very next turn resumes normal auto-advancement, without needing the task re-explained. */
  resumeTask(): void {
    if (!this.taskState) throw new Error('No active task to resume');
    this.taskState = { ...this.taskState, paused: false };
  }

  /** Clears task state entirely — e.g. to abandon the current task and start a fresh one. */
  resetTask(): void {
    this.taskState = null;
  }

  /** Manual stage override from the UI, validated against the same transition table AND gates the automatic step uses (Day 15) — never lets the machine jump illegally or skip an unapproved checkpoint. */
  setTaskStage(stage: TaskStage): void {
    if (!this.taskState) throw new Error('No active task to move');
    if (!isValidTaskTransition(this.taskState.stage, stage, this.taskState)) {
      const reason =
        this.taskState.stage === 'planning' && stage === 'execution'
          ? ' — план ещё не утверждён'
          : this.taskState.stage === 'validation' && stage === 'done'
            ? ' — валидация ещё не пройдена'
            : '';
      throw new Error(`Cannot move from "${this.taskState.stage}" to "${stage}"${reason}`);
    }
    // Leaving validation for a rework loop invalidates the old validation
    // pass — same rule the automatic step applies (see task-state.ts).
    const validationPassed =
      this.taskState.stage === 'validation' && stage === 'execution' ? false : this.taskState.validationPassed;
    this.taskState = { ...this.taskState, stage, validationPassed, updatedAt: new Date().toISOString() };
  }

  /** Explicit gate (Day 15): unlocks planning -> execution. Only meaningful while still planning — approving a plan that's already been left behind doesn't do anything useful. */
  approvePlan(): void {
    if (!this.taskState) throw new Error('No active task to approve a plan for');
    if (this.taskState.stage !== 'planning') throw new Error('Plan approval only applies while still in the planning stage');
    this.taskState = { ...this.taskState, planApproved: true, updatedAt: new Date().toISOString() };
  }

  /** Explicit gate (Day 15): unlocks validation -> done. Only meaningful while in validation. */
  approveValidation(): void {
    if (!this.taskState) throw new Error('No active task to approve validation for');
    if (this.taskState.stage !== 'validation') throw new Error('Validation approval only applies while in the validation stage');
    this.taskState = { ...this.taskState, validationPassed: true, updatedAt: new Date().toISOString() };
  }

  async ask(
    prompt: string,
    reasoningMode?: ReasoningMode,
    options?: AskOptions,
    contextConfig?: ContextConfig,
    memoryConfig?: MemoryConfig,
    /** Long-term memory formatted for the prompt — owned by MemoryService, passed in since Agent doesn't hold it. */
    longTermMemoryText?: string,
    taskConfig?: TaskConfig,
    /** Active invariants, fetched fresh by the caller (AgentsService) — Agent never persists these itself. */
    invariants: Pick<Invariant, 'id' | 'title' | 'rule'>[] = [],
    invariantConfig?: InvariantConfig,
  ): Promise<AgentAskResult> {
    const strategy = contextConfig?.strategy ?? 'none';
    const keepLastN = Math.max(0, contextConfig?.keepLastN ?? 0);

    const useWorkingMemory = memoryConfig?.useWorking ?? true;
    const useLongTermMemory = memoryConfig?.useLongTerm ?? true;
    const updateMemory = memoryConfig?.update ?? true;
    const workingMemoryForPrompt = useWorkingMemory ? formatWorkingMemory(this.workingMemory) : undefined;
    const longTermMemoryForPrompt = useLongTermMemory ? longTermMemoryText : undefined;
    const taskStateForPrompt = this.taskState ? formatTaskState(this.taskState) : undefined;
    // Paused means frozen, full stop — never re-evaluated automatically, only
    // by an explicit resume/pause/setStage call from the caller.
    const updateTask = (taskConfig?.update ?? true) && !this.taskState?.paused;

    const useInvariants = invariantConfig?.use ?? true;
    const invariantsForPrompt = useInvariants && invariants.length > 0 ? formatInvariants(invariants) : undefined;
    // Nothing to check against — skip the call entirely rather than asking the
    // model to confirm compliance with an empty rule set.
    const checkInvariants = (invariantConfig?.check ?? true) && invariants.length > 0;

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
      (longTermMemoryForPrompt ? countTokens(longTermMemoryForPrompt) : 0) +
      (options?.profile ? countTokens(options.profile) : 0) +
      (taskStateForPrompt ? countTokens(taskStateForPrompt) : 0) +
      (invariantsForPrompt ? countTokens(invariantsForPrompt) : 0);

    const start = Date.now();
    const result = await callLlmWithReasoning(prompt, reasoningMode, {
      ...options,
      history: contextHistory,
      summary: summaryForPrompt,
      facts: factsForPrompt,
      workingMemory: workingMemoryForPrompt,
      longTermMemory: longTermMemoryForPrompt,
      taskState: taskStateForPrompt,
      invariants: invariantsForPrompt,
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

    // Task-state transition step: same idea as memory routing, but a
    // constrained state machine instead of free-form facts — skipped
    // entirely while paused, so a parked task never silently drifts.
    let task: TaskInfo | undefined;
    let taskRequests: LlmRequestLog[] = [];
    if (updateTask) {
      const updated = await updateTaskState(this.taskState, prompt, result.content, options?.model);
      this.taskState = updated.task;
      taskRequests = updated.requests;
      task = { task: this.taskState, updated: updated.changed, update: { usage: updated.usage, costByn: updated.costByn } };
    } else {
      task = { task: this.taskState, updated: false };
    }

    // Compliance check: a separate, independent read of the assistant's own
    // answer against every invariant — this is what actually lets us observe
    // "did a violation happen and why", rather than trusting the main answer's
    // self-report (it might not even mention the invariant it broke).
    let invariantInfo: InvariantCheckInfo | undefined;
    let invariantRequests: LlmRequestLog[] = [];
    if (checkInvariants) {
      const checked = await checkInvariantCompliance(invariants, prompt, result.content, options?.model);
      invariantRequests = checked.requests;
      invariantInfo = {
        used: useInvariants,
        checked: true,
        compliant: checked.compliant,
        violations: checked.violations,
        update: { usage: checked.usage, costByn: checked.costByn },
      };
    } else {
      invariantInfo = { used: useInvariants, checked: false };
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
      task,
      invariants: invariantInfo,
      toolCalls: result.toolCalls,
      requests: [
        ...factsRequests,
        ...result.requests,
        ...compactionRequests,
        ...memoryRequests,
        ...taskRequests,
        ...invariantRequests,
      ],
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
