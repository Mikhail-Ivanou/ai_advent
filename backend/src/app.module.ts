import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { LlmModule } from './llm/llm.module';
import { MemoryModule } from './memory/memory.module';
import { ProfileModule } from './profile/profile.module';
import { InvariantModule } from './invariant/invariant.module';
import { McpModule } from './mcp/mcp.module';
import { RagModule } from './rag/rag.module';
import { RagChatModule } from './rag-chat/rag-chat.module';

@Module({
  imports: [LlmModule, MemoryModule, ProfileModule, InvariantModule, McpModule, RagModule, RagChatModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
