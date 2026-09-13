import { Module } from '@nestjs/common';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { LlmController } from './llm.controller';
import { LlmService } from './llm.service';

@Module({
  controllers: [LlmController, AgentsController],
  providers: [LlmService, AgentsService],
})
export class LlmModule {}
