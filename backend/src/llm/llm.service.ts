import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { AskOptions, LlmUsage, ReasoningMode, callLlmWithReasoning, estimateCostByn } from './llm.client';

export interface AskResult {
  answer: string;
  model: string;
  responseTimeMs: number;
  usage?: LlmUsage;
  costByn?: number;
}

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  async ask(prompt: string, reasoningMode?: ReasoningMode, options?: AskOptions): Promise<AskResult> {
    try {
      const start = Date.now();
      const result = await callLlmWithReasoning(prompt, reasoningMode, options);
      const responseTimeMs = Date.now() - start;
      const costByn = estimateCostByn(result.model, result.usage);

      console.log('LLM response:', result.content);
      return { answer: result.content, model: result.model, responseTimeMs, usage: result.usage, costByn };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'LLM request failed';
      this.logger.error(message);
      throw new BadGatewayException(message);
    }
  }
}
