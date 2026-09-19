import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { MemoryService } from './memory.service';
import { MemoryCategory, MemoryEntry } from './memory.types';

class CreateMemoryDto {
  category: MemoryCategory;
  key: string;
  value: string;
}

class UpdateMemoryDto {
  category?: MemoryCategory;
  key?: string;
  value?: string;
}

/** CRUD for long-term memory (profile/decisions/knowledge) — the manual half of "explicitly choosing what gets saved". */
@Controller('memory')
export class MemoryController {
  constructor(private readonly memoryService: MemoryService) {}

  @Get()
  list(): { entries: MemoryEntry[] } {
    return { entries: this.memoryService.list() };
  }

  @Post()
  async create(@Body() body: CreateMemoryDto): Promise<MemoryEntry> {
    return this.memoryService.create(body.category, body.key, body.value, 'manual');
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: UpdateMemoryDto): Promise<MemoryEntry> {
    return this.memoryService.update(id, body);
  }

  @Delete(':id')
  async remove(@Param('id') id: string): Promise<{ deleted: true }> {
    await this.memoryService.remove(id);
    return { deleted: true };
  }
}
