import { Body, Controller, Post } from '@nestjs/common';
import { AskDto } from './ask.dto';
import { AskResult, LlmService } from './llm.service';

@Controller('llm')
export class LlmController {
  constructor(private readonly llmService: LlmService) {}

  @Post('ask')
  async ask(@Body() body: AskDto): Promise<AskResult> {
    return this.llmService.ask(body.prompt, body.reasoningMode, {
      format: body.format,
      maxOutputTokens: body.maxOutputTokens,
      stopSequence: body.stopSequence,
      temperature: body.temperature,
      model: body.model,
    });
  }
}
