import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { InvariantService } from './invariant.service';
import { Invariant, InvariantInput } from './invariant.types';

/** CRUD for invariants — always explicit, never auto-extracted (see InvariantService for how they're enforced). */
@Controller('invariants')
export class InvariantController {
  constructor(private readonly invariantService: InvariantService) {}

  @Get()
  list(): { invariants: Invariant[] } {
    return { invariants: this.invariantService.list() };
  }

  @Post()
  async create(@Body() body: InvariantInput): Promise<Invariant> {
    return this.invariantService.create(body);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: Partial<InvariantInput>): Promise<Invariant> {
    return this.invariantService.update(id, body);
  }

  @Delete(':id')
  async remove(@Param('id') id: string): Promise<{ deleted: true }> {
    await this.invariantService.remove(id);
    return { deleted: true };
  }
}
