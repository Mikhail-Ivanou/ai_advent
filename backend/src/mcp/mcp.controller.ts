import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { McpService } from './mcp.service';
import { McpServerInput, McpServerView } from './mcp.types';

/** CRUD for MCP servers plus per-server connection control — see McpService. */
@Controller('mcp/servers')
export class McpController {
  constructor(private readonly mcpService: McpService) {}

  @Get()
  list(): { servers: McpServerView[] } {
    return { servers: this.mcpService.list() };
  }

  @Post()
  async create(@Body() body: McpServerInput): Promise<McpServerView> {
    return this.mcpService.create(body);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: Partial<McpServerInput>): Promise<McpServerView> {
    return this.mcpService.update(id, body);
  }

  @Delete(':id')
  async remove(@Param('id') id: string): Promise<{ deleted: true }> {
    await this.mcpService.remove(id);
    return { deleted: true };
  }

  @Post(':id/connect')
  async connect(@Param('id') id: string): Promise<McpServerView> {
    return this.mcpService.connect(id);
  }

  @Post(':id/disconnect')
  async disconnect(@Param('id') id: string): Promise<McpServerView> {
    return this.mcpService.disconnect(id);
  }

  @Post(':id/tools/refresh')
  async refreshTools(@Param('id') id: string): Promise<McpServerView> {
    return this.mcpService.refreshTools(id);
  }
}
