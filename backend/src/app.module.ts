import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { LlmModule } from './llm/llm.module';
import { MemoryModule } from './memory/memory.module';
import { ProfileModule } from './profile/profile.module';

@Module({
  imports: [LlmModule, MemoryModule, ProfileModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
