import { callLlm, estimateCostByn, LlmRequestLog, LlmUsage } from '../llm/llm.client';
import { RagService } from './rag.service';
import { ChunkingStrategy, SearchHit, SearchMode } from './rag.types';

// Day 22: the RAG request in one place — question -> relevant chunks ->
// chunks joined with the question -> LLM. The chat agent uses the same
// context format; the comparison endpoint/CLI run a question in both modes.

export type AnswerMode = 'rag' | 'plain';

export interface RagAnswerOptions {
  strategy?: ChunkingStrategy;
  k?: number;
  search?: SearchMode;
  model?: string;
  temperature?: number;
  /** Search with this text instead of the question — e.g. without a "По роману …" preamble meant for the LLM only. */
  searchQuery?: string;
}

export interface RagAnswer {
  mode: AnswerMode;
  answer: string;
  model: string;
  /** Chunks given to the model, in citation order ([1] is the first). Empty in plain mode. */
  hits: SearchHit[];
  usage?: LlmUsage;
  costByn?: number;
  durationMs: number;
  requests: LlmRequestLog[];
}

export function normalizeRagConfig(config: { strategy?: string; k?: number; search?: string }): {
  strategy: ChunkingStrategy;
  k: number;
  search: SearchMode;
} {
  return {
    strategy: config.strategy === 'fixed' ? 'fixed' : 'structural',
    k: Math.min(Math.max(1, Math.round(config.k ?? 5)), 20),
    search: config.search === 'vector' ? 'vector' : 'hybrid',
  };
}

/** Retrieved chunks as numbered excerpts for the prompt — with title and section, so the model can cite [n]. */
export function formatRagContext(hits: SearchHit[]): string | undefined {
  if (!hits.length) return undefined;
  return hits
    .map((h, i) => `[${i + 1}] ${h.metadata.title} — ${h.metadata.section || h.metadata.file} (${h.metadata.source})\n${h.text}`)
    .join('\n\n');
}

export async function answerQuestion(
  rag: RagService,
  question: string,
  mode: AnswerMode,
  options: RagAnswerOptions = {},
): Promise<RagAnswer> {
  const { strategy, k, search } = normalizeRagConfig(options);
  const started = Date.now();
  const hits = mode === 'rag' ? await rag.retrieve(options.searchQuery ?? question, strategy, k, search) : [];
  const result = await callLlm(
    question,
    { model: options.model, temperature: options.temperature, ragContext: formatRagContext(hits) },
    mode === 'rag' ? `rag:${strategy}:${search}` : 'plain',
  );
  return {
    mode,
    answer: result.content,
    model: result.model,
    hits,
    usage: result.usage,
    costByn: estimateCostByn(result.model, result.usage),
    durationMs: Date.now() - started,
    requests: result.requests,
  };
}
