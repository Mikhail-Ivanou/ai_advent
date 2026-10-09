import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { OrderExtractService } from './order-extract.service';

@Controller('order-extract')
export class OrderExtractController {
  constructor(private readonly service: OrderExtractService) {}

  /** The configurations, the control e-mails and the system prompt. */
  @Get('meta')
  meta() {
    return this.service.meta();
  }

  @Get('chats')
  list() {
    return this.service.list();
  }

  @Post('chats')
  create(@Body() body: { configId: string }) {
    return this.service.create(body.configId);
  }

  @Get('chats/:id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Delete('chats/:id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  @Post('chats/:id/messages')
  send(@Param('id') id: string, @Body() body: { text: string; date: string }) {
    return this.service.send(id, body);
  }
}
