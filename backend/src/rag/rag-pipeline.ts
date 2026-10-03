import { callLlm, LlmRequestLog, LlmUsage, sumUsage } from '../llm/llm.client';
import { rerankScores, RerankerKind } from './reranker';
import { RagService } from './rag.service';
import { ChunkingStrategy, SearchHit, SearchMode } from './rag.types';

// Day 23: retrieval as a pipeline —
//   question -> [query rewrite] -> candidates (top-K before) -> [rerank]
//   -> [relevance threshold] -> top-K after -> LLM.
// Every stage is optional, so the evaluation can switch them one by one.

export interface PipelineConfig {
  strategy: ChunkingStrategy;
  search: SearchMode;
  /** Rewrite the question into a search query with the LLM; the original is still searched and both rankings fused. */
  rewrite: boolean;
  rerank: RerankerKind | 'none';
  /** Candidates taken from the first stage (top-K before filtering). */
  candidates: number;
  /** Chunks given to the LLM at most (top-K after filtering). */
  k: number;
  /**
   * Relevance cut-off: chunks scoring below it are dropped, even if that
   * leaves none. Applies to the reranker's 0..1 score; without a reranker,
   * to the cosine similarity. 0 = no threshold.
   */
  minScore: number;
  /** Model for the rewrite / LLM-rerank calls. */
  model?: string;
}

export const DEFAULT_PIPELINE: PipelineConfig = {
  strategy: 'structural',
  search: 'hybrid',
  rewrite: false,
  rerank: 'none',
  candidates: 5,
  k: 5,
  minScore: 0,
};

export interface RankedHit extends SearchHit {
  /** 1-based rank in the first stage (fused, if the query was rewritten). */
  firstRank: number;
  /** Reranker relevance 0..1, when a reranker ran. */
  rerankScore?: number;
}

export interface PipelineResult {
  query: string;
  /** The rewritten search query, when rewriting was on. */
  rewritten?: string;
  /** First-stage candidates in first-stage order, before filtering (with the reranker's score when one ran). */
  candidates: RankedHit[];
  /** What goes to the LLM: reranked, filtered, cut to k. */
  hits: RankedHit[];
  /** Candidates dropped by the threshold. */
  filteredOut: number;
  timings: { rewriteMs: number; searchMs: number; rerankMs: number };
  /** LLM tokens spent by the pipeline itself (rewrite, LLM reranker) — on top of the answer. */
  usage?: LlmUsage;
  requests: LlmRequestLog[];
}

export function normalizePipeline(input: Partial<PipelineConfig> = {}): PipelineConfig {
  const k = Math.min(Math.max(1, Math.round(input.k ?? DEFAULT_PIPELINE.k)), 20);
  const rerank: PipelineConfig['rerank'] = input.rerank === 'cross-encoder' || input.rerank === 'llm' ? input.rerank : 'none';
  return {
    strategy: input.strategy === 'fixed' ? 'fixed' : 'structural',
    search: input.search === 'vector' ? 'vector' : 'hybrid',
    rewrite: !!input.rewrite,
    rerank,
    // Without a reranker there is nothing to reorder, so extra candidates would only be cut again.
    candidates: rerank === 'none' ? k : Math.min(Math.max(k, Math.round(input.candidates ?? 20)), 50),
    k,
    minScore: Math.min(Math.max(0, Number(input.minScore) || 0), 1),
    model: input.model,
  };
}

/**
 * Turns a conversational question into a search query: drops the filler,
 * keeps names and terms, adds the words the answer would likely contain.
 */
export async function rewriteQuery(
  question: string,
  model?: string,
): Promise<{ query: string; request: LlmRequestLog[]; usage?: LlmUsage }> {
  const prompt = [
    'Перепиши вопрос пользователя в поисковый запрос для поиска фрагментов в тексте книги или документации.',
    '- убери вводные слова и вежливость, оставь суть;',
    '- сохрани все имена, названия, места, числа ровно как в вопросе;',
    '- добавь 3–6 слов, которые вероятно стоят рядом с ответом в самом тексте (синонимы, связанные понятия), но не выдумывай сам ответ;',
    '- на языке вопроса, одной строкой.',
    `Вопрос: ${question}`,
    'Верни JSON {"query": "..."}.',
  ].join('\n');
  const result = await callLlm(prompt, { format: 'json', temperature: 0, model }, 'rag:rewrite');
  try {
    const query = String(JSON.parse(result.content).query ?? '').trim();
    return { query: query || question, request: result.requests, usage: result.usage };
  } catch {
    return { query: question, request: result.requests, usage: result.usage };
  }
}

/** Reciprocal rank fusion of several rankings of the same index. */
function fuse(rankings: SearchHit[][], limit: number): RankedHit[] {
  const scored = new Map<string, { hit: SearchHit; fused: number }>();
  for (const ranking of rankings) {
    ranking.forEach((hit, rank) => {
      const entry = scored.get(hit.metadata.chunk_id) ?? { hit, fused: 0 };
      entry.fused += 1 / (60 + rank);
      // Keep the best cosine seen for display.
      if (hit.score > entry.hit.score) entry.hit = hit;
      scored.set(hit.metadata.chunk_id, entry);
    });
  }
  return [...scored.values()]
    .sort((a, b) => b.fused - a.fused)
    .slice(0, limit)
    .map((e, i) => ({ ...e.hit, firstRank: i + 1 }));
}

export async function runPipeline(rag: RagService, question: string, input: Partial<PipelineConfig> = {}): Promise<PipelineResult> {
  const cfg = normalizePipeline(input);
  const requests: LlmRequestLog[] = [];
  const timings = { rewriteMs: 0, searchMs: 0, rerankMs: 0 };
  let usage: LlmUsage | undefined;

  let rewritten: string | undefined;
  if (cfg.rewrite) {
    const started = Date.now();
    const r = await rewriteQuery(question, cfg.model);
    rewritten = r.query;
    requests.push(...r.request);
    usage = sumUsage(usage, r.usage);
    timings.rewriteMs = Date.now() - started;
  }

  const searchStarted = Date.now();
  const queries = rewritten && rewritten !== question ? [question, rewritten] : [question];
  const rankings = await Promise.all(queries.map((q) => rag.retrieve(q, cfg.strategy, cfg.candidates, cfg.search)));
  const found = queries.length > 1 ? fuse(rankings, cfg.candidates) : rankings[0].map((h, i) => ({ ...h, firstRank: i + 1 }));
  timings.searchMs = Date.now() - searchStarted;

  let candidates: RankedHit[] = found;
  let ranked: RankedHit[] = candidates;
  if (cfg.rerank !== 'none' && candidates.length) {
    const started = Date.now();
    // The reranker judges against the user's actual question, not the rewrite.
    const { scores, usage: rerankUsage } = await rerankScores(cfg.rerank, question, candidates.map((c) => c.text), cfg.model);
    usage = sumUsage(usage, rerankUsage);
    // Candidates keep their first-stage order but carry the reranker's score.
    candidates = candidates.map((c, i) => ({ ...c, rerankScore: Math.round(scores[i] * 1e4) / 1e4 }));
    ranked = [...candidates].sort((a, b) => b.rerankScore! - a.rerankScore!);
    timings.rerankMs = Date.now() - started;
  }

  const relevance = (h: RankedHit) => h.rerankScore ?? h.score;
  const passed = cfg.minScore > 0 ? ranked.filter((h) => relevance(h) >= cfg.minScore) : ranked;
  return {
    query: question,
    rewritten,
    candidates,
    hits: passed.slice(0, cfg.k),
    filteredOut: ranked.length - passed.length,
    timings,
    usage,
    requests,
  };
}
