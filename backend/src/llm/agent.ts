import { AskOptions, ChatMessage, LlmUsage, ReasoningMode, callLlmWithReasoning, estimateCostByn } from './llm.client';
import { countHistoryTokens, countTokens } from './tokenizer';

export interface TokenCounts {
  /** Tokens in the new user prompt alone. */
  requestTokens: number;
  /** Tokens in the conversation history sent along with this request (excludes the new prompt). */
  historyTokens: number;
  /** Tokens in the model's reply. */
  responseTokens: number;
}

export interface AgentAskResult {
  answer: string;
  model: string;
  responseTimeMs: number;
  usage?: LlmUsage;
  costByn?: number;
  tokens: TokenCounts;
}

/**
 * Encapsulates a request/response cycle with the LLM: takes a user prompt,
 * calls the API with whatever conversation history it has been given, and
 * shapes the reply — so callers never talk to callLlm* directly.
 *
 * History lives on the instance only; callers that want it to survive a
 * restart are responsible for loading it in and persisting it back out
 * (see AgentsService).
 */
export class Agent {
  constructor(
    readonly id: string,
    public history: ChatMessage[] = [],
  ) {}

  async ask(prompt: string, reasoningMode?: ReasoningMode, options?: AskOptions): Promise<AgentAskResult> {
    const requestTokens = countTokens(prompt);
    const historyTokens = countHistoryTokens(this.history);

    const start = Date.now();
    const result = await callLlmWithReasoning(prompt, reasoningMode, { ...options, history: this.history });
    const responseTimeMs = Date.now() - start;
    const costByn = estimateCostByn(result.model, result.usage);
    const responseTokens = countTokens(result.content);

    this.history.push({ role: 'user', content: prompt }, { role: 'assistant', content: result.content });

    return {
      answer: result.content,
      model: result.model,
      responseTimeMs,
      usage: result.usage,
      costByn,
      tokens: { requestTokens, historyTokens, responseTokens },
    };
  }
}
