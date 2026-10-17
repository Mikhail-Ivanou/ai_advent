import { Module } from '@nestjs/common';
import { DevAssistantController } from './dev-assistant.controller';
import { DevAssistantService } from './dev-assistant.service';

@Module({
  controllers: [DevAssistantController],
  providers: [DevAssistantService],
})
export class DevAssistantModule {}
