import { BadGatewayException, Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { AgentAskResult } from './agent';
import { AgentsService } from './agents.service';
import { AskDto } from './ask.dto';
import { ChatMessage } from './llm.client';

class CreateBranchDto {
  name: string;
  fromBranchId?: string;
}

@Controller('agents')
export class AgentsController {
  constructor(private readonly agentsService: AgentsService) {}

  @Post(':id/ask')
  async ask(@Param('id') id: string, @Body() body: AskDto): Promise<AgentAskResult> {
    try {
      return await this.agentsService.ask(
        id,
        body.prompt,
        body.reasoningMode,
        {
          format: body.format,
          maxOutputTokens: body.maxOutputTokens,
          stopSequence: body.stopSequence,
          temperature: body.temperature,
          model: body.model,
        },
        body.context,
        body.memory,
        body.profileId,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'LLM request failed';
      throw new BadGatewayException(message);
    }
  }

  @Get(':id/messages')
  getMessages(@Param('id') id: string): { messages: ChatMessage[] } {
    return { messages: this.agentsService.getHistory(id) };
  }

  @Get(':id/memory/working')
  getWorkingMemory(@Param('id') id: string): { working: Record<string, string> } {
    return { working: this.agentsService.getWorkingMemory(id) };
  }

  @Delete(':id/memory/working')
  async clearWorkingMemory(@Param('id') id: string): Promise<{ cleared: true }> {
    await this.agentsService.clearWorkingMemory(id);
    return { cleared: true };
  }

  @Get(':id/branches')
  getBranches(@Param('id') id: string): { branches: { id: string; messageCount: number }[]; activeBranchId: string } {
    return this.agentsService.listBranches(id);
  }

  @Post(':id/branches')
  async createBranch(@Param('id') id: string, @Body() body: CreateBranchDto): Promise<{ created: true }> {
    try {
      await this.agentsService.createBranch(id, body.name, body.fromBranchId);
      return { created: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not create branch';
      throw new BadGatewayException(message);
    }
  }

  @Post(':id/branches/:branchId/switch')
  async switchBranch(@Param('id') id: string, @Param('branchId') branchId: string): Promise<{ switched: true }> {
    try {
      await this.agentsService.switchBranch(id, branchId);
      return { switched: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not switch branch';
      throw new BadGatewayException(message);
    }
  }

  @Delete(':id/branches/:branchId')
  async deleteBranch(@Param('id') id: string, @Param('branchId') branchId: string): Promise<{ deleted: true }> {
    try {
      await this.agentsService.deleteBranch(id, branchId);
      return { deleted: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not delete branch';
      throw new BadGatewayException(message);
    }
  }

  @Delete(':id')
  async remove(@Param('id') id: string): Promise<{ deleted: true }> {
    await this.agentsService.delete(id);
    return { deleted: true };
  }
}
