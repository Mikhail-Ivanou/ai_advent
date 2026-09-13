import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { Agent, AgentAskResult } from './agent';
import { AskOptions, ReasoningMode } from './llm.client';

export type AskResult = AgentAskResult;

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly agent = new Agent();

  async ask(prompt: string, reasoningMode?: ReasoningMode, options?: AskOptions): Promise<AskResult> {
    try {
      return await this.agent.ask(prompt, reasoningMode, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'LLM request failed';
      this.logger.error(message);
      throw new BadGatewayException(message);
    }
  }
}
