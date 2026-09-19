import { BadGatewayException, Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { AgentAskResult } from './agent';
import { AgentsService } from './agents.service';
import { AskDto } from './ask.dto';
import { ChatMessage } from './llm.client';
import { TaskStage, TaskState } from './task-state';

class CreateBranchDto {
  name: string;
  fromBranchId?: string;
}

class SetTaskStageDto {
  stage: TaskStage;
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
        body.task,
        body.invariants,
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

  @Get(':id/task')
  getTaskState(@Param('id') id: string): { task: TaskState | null } {
    return { task: this.agentsService.getTaskState(id) };
  }

  @Post(':id/task/pause')
  async pauseTask(@Param('id') id: string): Promise<{ paused: true }> {
    try {
      await this.agentsService.pauseTask(id);
      return { paused: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not pause task';
      throw new BadGatewayException(message);
    }
  }

  @Post(':id/task/resume')
  async resumeTask(@Param('id') id: string): Promise<{ resumed: true }> {
    try {
      await this.agentsService.resumeTask(id);
      return { resumed: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not resume task';
      throw new BadGatewayException(message);
    }
  }

  @Post(':id/task/stage')
  async setTaskStage(@Param('id') id: string, @Body() body: SetTaskStageDto): Promise<{ set: true }> {
    try {
      await this.agentsService.setTaskStage(id, body.stage);
      return { set: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not change task stage';
      throw new BadGatewayException(message);
    }
  }

  @Delete(':id/task')
  async resetTask(@Param('id') id: string): Promise<{ reset: true }> {
    await this.agentsService.resetTask(id);
    return { reset: true };
  }

  @Post(':id/task/approve-plan')
  async approvePlan(@Param('id') id: string): Promise<{ approved: true }> {
    try {
      await this.agentsService.approvePlan(id);
      return { approved: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not approve plan';
      throw new BadGatewayException(message);
    }
  }

  @Post(':id/task/approve-validation')
  async approveValidation(@Param('id') id: string): Promise<{ approved: true }> {
    try {
      await this.agentsService.approveValidation(id);
      return { approved: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not approve validation';
      throw new BadGatewayException(message);
    }
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
