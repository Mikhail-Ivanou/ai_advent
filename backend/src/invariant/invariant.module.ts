import { Module } from '@nestjs/common';
import { InvariantController } from './invariant.controller';
import { InvariantService } from './invariant.service';

@Module({
  controllers: [InvariantController],
  providers: [InvariantService],
  exports: [InvariantService],
})
export class InvariantModule {}
