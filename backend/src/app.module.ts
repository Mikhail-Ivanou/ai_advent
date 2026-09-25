import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { LlmModule } from './llm/llm.module';
import { MemoryModule } from './memory/memory.module';
import { ProfileModule } from './profile/profile.module';
import { InvariantModule } from './invariant/invariant.module';
import { McpModule } from './mcp/mcp.module';

@Module({
  imports: [LlmModule, MemoryModule, ProfileModule, InvariantModule, McpModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
