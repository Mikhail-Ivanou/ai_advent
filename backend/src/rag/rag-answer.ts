import { callLlm, estimateCostByn, LlmRequestLog, LlmUsage, sumUsage } from '../llm/llm.client';
import { groundAnswer, Grounding, lowRelevanceAnswer, renderGrounding } from './grounding';
import { normalizePipeline, PipelineConfig, PipelineResult, runPipeline } from './rag-pipeline';
import { RagService } from './rag.service';
import { SearchHit } from './rag.types';

// Day 22: the RAG request in one place — question -> relevant chunks ->
// chunks joined with the question -> LLM. Day 23: the chunks come from the
// retrieval pipeline (query rewrite, reranking, relevance threshold).
// Day 24: the answer carries sources and verified quotes, and weak context
// means "не знаю" (see grounding.ts).

export type AnswerMode = 'rag' | 'plain';

export interface RagAnswerOptions extends Partial<PipelineConfig> {
  temperature?: number;
  /** Search with this text instead of the question — e.g. without a "По роману …" preamble meant for the LLM only. */
  searchQuery?: string;
}

export interface RagAnswer {
  mode: AnswerMode;
  answer: string;
  model: string;
  /** Chunks given to the model, in citation order ([1] is the first). Empty in plain mode or when all were filtered out. */
  hits: SearchHit[];
  /** RAG mode: what the retrieval pipeline did (rewrite, candidates before filtering, how many were cut). */
  pipeline?: PipelineResult;
  /** RAG mode: sources, verified quotes, or why the answer is "не знаю". `answer` is its rendered form. */
  grounding?: Grounding;
  /** RAG mode: the model's reply as it came, before parsing/verification (absent when the LLM was not asked). */
  rawAnswer?: string;
  /** Answer plus pipeline (rewrite, LLM reranker) tokens. */
  usage?: LlmUsage;
  costByn?: number;
  durationMs: number;
  requests: LlmRequestLog[];
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
  const started = Date.now();
  const pipeline = mode === 'rag' ? await runPipeline(rag, options.searchQuery ?? question, options) : undefined;
  const hits = pipeline?.hits ?? [];

  if (pipeline && !hits.length) {
    // Weak context: nothing passed the threshold — "не знаю" without asking the LLM.
    const grounding = lowRelevanceAnswer(pipeline.candidates, normalizePipeline(options).minScore);
    return {
      mode,
      answer: grounding.answer,
      model: 'rag-guard',
      hits,
      pipeline,
      grounding,
      usage: pipeline.usage,
      costByn: estimateCostByn(options.model ?? process.env.LLM_MODEL ?? '', pipeline.usage),
      durationMs: Date.now() - started,
      requests: pipeline.requests,
    };
  }

  const result = await callLlm(
    question,
    { model: options.model, temperature: options.temperature, ragContext: formatRagContext(hits) },
    mode === 'rag' ? 'rag' : 'plain',
  );
  const grounding = pipeline ? groundAnswer(result.content, hits) : undefined;
  const usage = sumUsage(result.usage, pipeline?.usage);
  return {
    mode,
    answer: grounding ? renderGrounding(grounding) : result.content,
    model: result.model,
    hits,
    pipeline,
    grounding,
    rawAnswer: grounding ? result.content : undefined,
    usage,
    costByn: estimateCostByn(result.model, usage),
    durationMs: Date.now() - started,
    requests: [...(pipeline?.requests ?? []), ...result.requests],
  };
}
