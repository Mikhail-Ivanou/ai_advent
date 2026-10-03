import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { PipelineConfig } from '../rag/rag-pipeline';
import { RagChatService } from './rag-chat.service';
import { TaskMemory } from './rag-chat.types';

/** Mini chat with RAG, sources and task memory (Day 25). */
@Controller('rag-chat')
export class RagChatController {
  constructor(private readonly ragChatService: RagChatService) {}

  @Get()
  list() {
    return { chats: this.ragChatService.list() };
  }

  @Post()
  create(@Body() body: { title?: string; settings?: Partial<PipelineConfig> }) {
    return this.ragChatService.create(body?.title, body?.settings);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.ragChatService.get(id);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    this.ragChatService.remove(id);
    return { deleted: true };
  }

  /** Sends a user message; returns the updated chat and the assistant's answer. */
  @Post(':id/messages')
  send(@Param('id') id: string, @Body() body: { content: string; model?: string }) {
    return this.ragChatService.send(id, body.content, body.model);
  }

  @Put(':id/memory')
  setMemory(@Param('id') id: string, @Body() body: Partial<TaskMemory>) {
    return this.ragChatService.setMemory(id, body);
  }

  @Put(':id/settings')
  setSettings(@Param('id') id: string, @Body() body: Partial<PipelineConfig>) {
    return this.ragChatService.setSettings(id, body);
  }
}
