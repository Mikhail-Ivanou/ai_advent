import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { BackgroundEvent, BackgroundService, BackgroundTask } from './background.service';

/** A chat's background tasks and the events they produced (Day 18) — see BackgroundService. */
@Controller('agents/:id/background')
export class BackgroundController {
  constructor(private readonly backgroundService: BackgroundService) {}

  @Get()
  async state(
    @Param('id') id: string,
    @Query('after') after?: string,
  ): Promise<{ tasks: BackgroundTask[]; events: BackgroundEvent[] }> {
    return this.backgroundService.getState(id, Number(after) || 0);
  }

  @Post(':serverId/:taskId/status')
  async setStatus(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Param('taskId') taskId: string,
    @Body() body: { status: string },
  ): Promise<{ result: string }> {
    return { result: await this.backgroundService.setStatus(id, serverId, taskId, body.status) };
  }

  @Post(':serverId/:taskId/summary')
  async summary(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Param('taskId') taskId: string,
  ): Promise<{ result: string }> {
    return { result: await this.backgroundService.summary(id, serverId, taskId) };
  }
}
