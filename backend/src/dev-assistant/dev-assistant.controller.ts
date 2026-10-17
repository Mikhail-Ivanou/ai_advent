import { BadGatewayException, BadRequestException, Body, Controller, Get, Post } from '@nestjs/common';
import { ChatMessage } from '../llm/llm.client';
import { DevAssistantService } from './dev-assistant.service';

/** Developer assistant (Day 31): /help and git commands about this very project. */
@Controller('dev-assistant')
export class DevAssistantController {
  constructor(private readonly devAssistant: DevAssistantService) {}

  /** Current branch (MCP), what's indexed (RAG) and the command list. */
  @Get()
  status() {
    return this.devAssistant.status();
  }

  /** One message — a command such as "/help как запустить бэкенд?"; history is the dialog so far, kept by the client. */
  @Post('ask')
  async ask(@Body() body: { message: string; history?: ChatMessage[]; model?: string }) {
    if (!body?.message?.trim()) throw new BadRequestException('message is required');
    try {
      return await this.devAssistant.handle(body.message, body.history ?? [], body.model);
    } catch (error) {
      throw new BadGatewayException((error as Error).message);
    }
  }
}
