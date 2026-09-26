import { Module } from '@nestjs/common';
import { MemoryModule } from '../memory/memory.module';
import { ProfileModule } from '../profile/profile.module';
import { InvariantModule } from '../invariant/invariant.module';
import { McpModule } from '../mcp/mcp.module';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { LlmController } from './llm.controller';
import { LlmService } from './llm.service';

@Module({
  imports: [MemoryModule, ProfileModule, InvariantModule, McpModule],
  controllers: [LlmController, AgentsController],
  providers: [LlmService, AgentsService],
})
export class LlmModule {}
