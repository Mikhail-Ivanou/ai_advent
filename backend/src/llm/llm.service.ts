import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { Agent, AgentAskResult } from './agent';
import { AskOptions, ReasoningMode } from './llm.client';

export type AskResult = AgentAskResult;

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  async ask(prompt: string, reasoningMode?: ReasoningMode, options?: AskOptions): Promise<AskResult> {
    try {
      // A fresh, history-less agent per call: this endpoint is for one-off asks.
      // Persistent multi-turn conversations go through AgentsService instead.
      // Memory is explicitly off — a throwaway agent has no working memory worth
      // tracking and no chat id to route long-term facts through.
      return await new Agent('adhoc').ask(prompt, reasoningMode, options, undefined, {
        useWorking: false,
        useLongTerm: false,
        update: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'LLM request failed';
      this.logger.error(message);
      throw new BadGatewayException(message);
    }
  }
}
