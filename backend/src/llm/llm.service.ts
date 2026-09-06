import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { AskOptions, callLlm } from './llm.client';

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  async ask(prompt: string, options?: AskOptions): Promise<string> {
    try {
      const answer = await callLlm(prompt, options);
      console.log('LLM response:', answer);
      return answer;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'LLM request failed';
      this.logger.error(message);
      throw new BadGatewayException(message);
    }
  }
}
