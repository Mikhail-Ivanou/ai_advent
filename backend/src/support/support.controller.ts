import { BadGatewayException, BadRequestException, Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ChatMessage } from '../llm/llm.client';
import { SupportService } from './support.service';

/** Support assistant (Day 33): answers about Advent LLM with the user's CRM data (MCP) and the FAQ (RAG). */
@Controller('support')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  /** CRM connection, its tools and what the FAQ index holds. */
  @Get()
  status() {
    return this.support.status();
  }

  @Get('tickets')
  async tickets() {
    return { tickets: await this.wrap(() => this.support.tickets()) };
  }

  @Get('users')
  async users() {
    return { users: await this.wrap(() => this.support.users()) };
  }

  /** A new request from a user (demo: simulate incoming tickets). */
  @Post('tickets')
  create(@Body() body: { userId: string; subject?: string; text: string; channel?: string; priority?: string }) {
    if (!body?.userId || !body?.text?.trim()) throw new BadRequestException('userId and text are required');
    return this.wrap(() => this.support.createTicket(body));
  }

  /** The ticket with its user's card, for the UI. */
  @Get('tickets/:id')
  ticket(@Param('id') id: string) {
    return this.wrap(() => this.support.ticket(id));
  }

  /** A question from the user, in the context of a ticket or of a user found by email/name. */
  @Post('ask')
  ask(@Body() body: { message: string; ticketId?: string; user?: string; history?: ChatMessage[]; model?: string }) {
    if (!body?.message?.trim()) throw new BadRequestException('message is required');
    return this.wrap(() => this.support.ask(body));
  }

  /** Sends an answer to the user: written into the ticket through the CRM. */
  @Post('tickets/:id/reply')
  reply(@Param('id') id: string, @Body() body: { text: string; status?: 'open' | 'pending' | 'resolved' }) {
    if (!body?.text?.trim()) throw new BadRequestException('text is required');
    return this.wrap(() => this.support.reply(id, body.text.trim(), body.status));
  }

  private async wrap<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw new BadGatewayException((error as Error).message);
    }
  }
}
