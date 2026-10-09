import { Module } from '@nestjs/common';
import { OrderExtractController } from './order-extract.controller';
import { OrderExtractService } from './order-extract.service';

@Module({
  controllers: [OrderExtractController],
  providers: [OrderExtractService],
})
export class OrderExtractModule {}
