import { BadGatewayException, BadRequestException, Body, ConflictException, Controller, Get, Param, Post } from '@nestjs/common';
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

  /** Day 34: the file agent's saved runs (goal, status), newest first. */
  @Get('tasks')
  async tasks() {
    return { tasks: await this.devAssistant.files.list() };
  }

  @Get('tasks/:id')
  async task(@Param('id') id: string) {
    try {
      return await this.devAssistant.files.get(id);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }

  /** Writes the run's changes to the working copy (MCP write_project_file, sha1-guarded); `paths` — only these files. */
  @Post('tasks/:id/apply')
  async apply(@Param('id') id: string, @Body() body: { paths?: string[] } = {}) {
    try {
      return await this.devAssistant.files.apply(id, body?.paths);
    } catch (error) {
      const message = (error as Error).message;
      // Unknown run / nothing to apply / already applied — the request, not the server.
      throw /^Нет запуска/.test(message) ? new BadRequestException(message) : new ConflictException(message);
    }
  }
}
