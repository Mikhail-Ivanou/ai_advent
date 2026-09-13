import { BadGatewayException, Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { AgentAskResult } from './agent';
import { AgentsService } from './agents.service';
import { AskDto } from './ask.dto';
import { ChatMessage } from './llm.client';

@Controller('agents')
export class AgentsController {
  constructor(private readonly agentsService: AgentsService) {}

  @Post(':id/ask')
  async ask(@Param('id') id: string, @Body() body: AskDto): Promise<AgentAskResult> {
    try {
      return await this.agentsService.ask(id, body.prompt, body.reasoningMode, {
        format: body.format,
        maxOutputTokens: body.maxOutputTokens,
        stopSequence: body.stopSequence,
        temperature: body.temperature,
        model: body.model,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'LLM request failed';
      throw new BadGatewayException(message);
    }
  }

  @Get(':id/messages')
  getMessages(@Param('id') id: string): { messages: ChatMessage[] } {
    return { messages: this.agentsService.getHistory(id) };
  }

  @Delete(':id')
  async remove(@Param('id') id: string): Promise<{ deleted: true }> {
    await this.agentsService.delete(id);
    return { deleted: true };
  }
}
