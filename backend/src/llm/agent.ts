import { AskOptions, LlmUsage, ReasoningMode, callLlmWithReasoning, estimateCostByn } from './llm.client';

export interface AgentAskResult {
  answer: string;
  model: string;
  responseTimeMs: number;
  usage?: LlmUsage;
  costByn?: number;
}

/**
 * Encapsulates a single request/response cycle with the LLM: takes a user
 * prompt, calls the API, and shapes the reply — so callers never talk to
 * callLlm* directly.
 */
export class Agent {
  async ask(prompt: string, reasoningMode?: ReasoningMode, options?: AskOptions): Promise<AgentAskResult> {
    const start = Date.now();
    const result = await callLlmWithReasoning(prompt, reasoningMode, options);
    const responseTimeMs = Date.now() - start;
    const costByn = estimateCostByn(result.model, result.usage);

    return { answer: result.content, model: result.model, responseTimeMs, usage: result.usage, costByn };
  }
}
