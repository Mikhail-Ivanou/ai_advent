import { AskOptions, ChatMessage, LlmUsage, ReasoningMode, callLlmWithReasoning, estimateCostByn } from './llm.client';

export interface AgentAskResult {
  answer: string;
  model: string;
  responseTimeMs: number;
  usage?: LlmUsage;
  costByn?: number;
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
    const start = Date.now();
    const result = await callLlmWithReasoning(prompt, reasoningMode, { ...options, history: this.history });
    const responseTimeMs = Date.now() - start;
    const costByn = estimateCostByn(result.model, result.usage);

    this.history.push({ role: 'user', content: prompt }, { role: 'assistant', content: result.content });

    return { answer: result.content, model: result.model, responseTimeMs, usage: result.usage, costByn };
  }
}
