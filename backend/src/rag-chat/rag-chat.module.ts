import { Module } from '@nestjs/common';
import { RagModule } from '../rag/rag.module';
import { RagChatController } from './rag-chat.controller';
import { RagChatService } from './rag-chat.service';

@Module({
  imports: [RagModule],
  controllers: [RagChatController],
  providers: [RagChatService],
  exports: [RagChatService],
})
export class RagChatModule {}
