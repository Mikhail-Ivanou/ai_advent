import { BadGatewayException, BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { CHUNKING_STRATEGIES, ChunkingParams, ChunkingStrategy } from './rag.types';
import { answerQuestion } from './rag-answer';
import { PipelineConfig } from './rag-pipeline';
import { RagService } from './rag.service';

/** Document indexing (Day 21): add documents by URL or upload, inspect chunks, search, compare strategies. */
@Controller('rag')
export class RagController {
  constructor(private readonly ragService: RagService) {}

  @Get()
  list() {
    return this.ragService.list();
  }

  @Get('status')
  status() {
    return this.ragService.getStatus();
  }

  /** Either `{ url }` for a web document or `{ name, contentBase64 }` for an uploaded file. */
  @Post('documents')
  add(@Body() body: { url?: string; name?: string; contentBase64?: string }) {
    if (body.url) return this.ragService.addFromUrl(body.url);
    return this.ragService.addFromFile(body.name ?? '', body.contentBase64 ?? '');
  }

  @Delete('documents/:id')
  remove(@Param('id') id: string) {
    return this.ragService.remove(id);
  }

  @Get('documents/:id/chunks')
  chunks(
    @Param('id') id: string,
    @Query('strategy') strategy: string,
    @Query('offset') offset?: string,
    @Query('limit') limit?: string,
  ) {
    if (!CHUNKING_STRATEGIES.includes(strategy as ChunkingStrategy)) {
      throw new BadRequestException(`strategy must be one of ${CHUNKING_STRATEGIES.join(', ')}`);
    }
    return this.ragService.chunks(id, strategy as ChunkingStrategy, Number(offset) || 0, Number(limit) || 20);
  }

  /** Changes chunking parameters and re-indexes every stored document. */
  @Put('params')
  setParams(@Body() body: Partial<ChunkingParams>) {
    return this.ragService.setParams(body);
  }

  @Post('search')
  search(@Body() body: { query: string; k?: number; mode?: string }) {
    return this.ragService.search(body.query, body.k, body.mode === 'hybrid' ? 'hybrid' : 'vector');
  }

  /**
   * The same question answered by the LLM twice — without RAG and with the
   * retrieved chunks joined to it (Day 22), for a side-by-side comparison.
   * Body: question + pipeline settings (strategy, search, rewrite, rerank,
   * candidates, k, minScore, model — Day 23).
   */
  @Post('ask')
  async ask(@Body() body: { question: string } & Partial<PipelineConfig>) {
    if (!body.question?.trim()) throw new BadRequestException('question is required');
    const { question, ...pipeline } = body;
    try {
      const [plain, rag] = await Promise.all([
        answerQuestion(this.ragService, question.trim(), 'plain', { model: pipeline.model }),
        answerQuestion(this.ragService, question.trim(), 'rag', pipeline),
      ]);
      return { plain, rag };
    } catch (error) {
      throw new BadGatewayException(error instanceof Error ? error.message : 'LLM request failed');
    }
  }

  /** Strategy statistics; `sample` > 0 also runs the self-retrieval evaluation with that many queries. */
  @Get('compare')
  compare(@Query('sample') sample?: string, @Query('seed') seed?: string) {
    return this.ragService.compare(Number(sample) || 0, Number(seed) || 21);
  }
}
