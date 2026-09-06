import { Body, Controller, Post } from '@nestjs/common';
import { LlmService } from './llm.service';

class AskDto {
  prompt: string;
}

@Controller('llm')
export class LlmController {
  constructor(private readonly llmService: LlmService) {}

  @Post('ask')
  async ask(@Body() body: AskDto): Promise<{ answer: string }> {
    const answer = await this.llmService.ask(body.prompt);
    return { answer };
  }
}
