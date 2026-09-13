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
import { countHistoryTokens, countTokens } from './tokenizer';

export interface TokenCounts {
  /** Tokens in the new user prompt alone. */
  requestTokens: number;
  /** Tokens in the context actually sent with this request (recent history and/or summary, excludes the new prompt). */
  historyTokens: number;
  /** Tokens in the model's reply. */
  responseTokens: number;
}

export interface CompressionSettings {
  enabled: boolean;
  /** How many of the most recent messages to keep verbatim. */
  keepLastN: number;
}

export interface CompressionInfo {
  enabled: boolean;
  keepLastN: number;
  /** How many older messages have been folded into `summary`. */
  summarizedMessageCount: number;
  /** How many recent messages are still kept verbatim. */
  recentMessageCount: number;
  summary: string;
  /** Present only on a turn that actually triggered a summary update. */
  summaryUpdate?: { usage?: LlmUsage; costByn?: number };
}

export interface AgentAskResult {
  answer: string;
  model: string;
  responseTimeMs: number;
  usage?: LlmUsage;
  costByn?: number;
  tokens: TokenCounts;
  compression?: CompressionInfo;
  /** The exact request(s) sent to the API for this turn, including any compaction summarization calls. */
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

/**
 * Encapsulates a request/response cycle with the LLM: takes a user prompt,
 * calls the API with whatever conversation history it has been given, and
 * shapes the reply — so callers never talk to callLlm* directly.
 *
 * `history` keeps the full conversation log for the record. When history
 * compression is on, only the last `keepLastN` messages are sent verbatim —
 * everything older is folded into a running `summary` (in chunks of up to
 * COMPACTION_BATCH_SIZE messages) and that summary is sent instead of the raw text.
 *
 * State lives on the instance only; callers that want it to survive a
 * restart are responsible for loading it in and persisting it back out
 * (see AgentsService).
 */
export class Agent {
  constructor(
    readonly id: string,
    public history: ChatMessage[] = [],
    public summary: string = '',
    public summarizedThroughIndex: number = 0,
  ) {}

  async ask(
    prompt: string,
    reasoningMode?: ReasoningMode,
    options?: AskOptions,
    compression?: CompressionSettings,
  ): Promise<AgentAskResult> {
    const keepLastN = Math.max(0, compression?.keepLastN ?? 0);
    const useCompression = Boolean(compression?.enabled);

    // Everything since the last compaction point is sent as-is — never skip
    // straight to "last N", or messages that fell out of that window but
    // haven't been folded into the summary yet would just vanish from context.
    const contextHistory = useCompression ? this.history.slice(this.summarizedThroughIndex) : this.history;
    const summaryForPrompt = useCompression ? this.summary || undefined : undefined;

    const requestTokens = countTokens(prompt);
    const historyTokens =
      countHistoryTokens(contextHistory) + (summaryForPrompt ? countTokens(summaryForPrompt) : 0);

    const start = Date.now();
    const result = await callLlmWithReasoning(prompt, reasoningMode, {
      ...options,
      history: contextHistory,
      summary: summaryForPrompt,
    });
    const responseTimeMs = Date.now() - start;
    const costByn = estimateCostByn(result.model, result.usage);
    const responseTokens = countTokens(result.content);

    this.history.push({ role: 'user', content: prompt }, { role: 'assistant', content: result.content });

    let summaryUpdate: CompressionInfo['summaryUpdate'];
    let compactionRequests: LlmRequestLog[] = [];
    if (useCompression) {
      ({ summaryUpdate, requests: compactionRequests } = await this.maybeCompact(keepLastN, options?.model));
    }

    return {
      answer: result.content,
      model: result.model,
      responseTimeMs,
      usage: result.usage,
      costByn,
      tokens: { requestTokens, historyTokens, responseTokens },
      compression: compression
        ? {
            enabled: useCompression,
            keepLastN,
            summarizedMessageCount: this.summarizedThroughIndex,
            recentMessageCount: this.history.length - this.summarizedThroughIndex,
            summary: this.summary,
            summaryUpdate,
          }
        : undefined,
      requests: [...result.requests, ...compactionRequests],
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
  ): Promise<{ summaryUpdate: CompressionInfo['summaryUpdate']; requests: LlmRequestLog[] }> {
    let summaryUpdate: CompressionInfo['summaryUpdate'];
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
