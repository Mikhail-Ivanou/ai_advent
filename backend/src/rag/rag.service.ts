import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { chunkFixed, chunkStructural, endsMidSentence } from './chunking';
import { dot, embed, EmbeddingInfo, embeddingInfo } from './embedder';
import { Bm25Index } from './lexical';
import { baseName, loadDocument, loadFromUrl } from './loaders';
import {
  CHUNKING_STRATEGIES,
  Chunk,
  ChunkMetadata,
  ChunkingParams,
  ChunkingStrategy,
  CompareResult,
  DEFAULT_CHUNKING_PARAMS,
  IndexedChunk,
  IndexedDocumentInfo,
  LoadedDocument,
  RagIndexFile,
  RetrievalEval,
  RetrievalEvalKind,
  SearchHit,
  SearchMode,
  StrategyStats,
} from './rag.types';

// RAG_DATA_DIR points the index elsewhere (e.g. a scratch index for experiments); the model cache stays put.
const DATA_DIR = path.resolve(process.env.RAG_DATA_DIR ?? path.resolve(__dirname, '../../data/rag'));
const DOCUMENTS_DIR = path.join(DATA_DIR, 'documents');
const indexPath = (strategy: ChunkingStrategy) => path.join(DATA_DIR, `${strategy}.json`);

export interface IndexingStatus {
  busy: boolean;
  /** What is being done right now, e.g. "structural: эмбеддинги 48/120 — book.fb2". */
  phase?: string;
  done?: number;
  total?: number;
  error?: string;
}

export interface RagDocumentView extends IndexedDocumentInfo {
  chunks: Record<ChunkingStrategy, number>;
}

export interface IndexDocumentResult {
  document: RagDocumentView;
  strategies: { strategy: ChunkingStrategy; chunks: number; embedMs: number }[];
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Small seeded PRNG, so an evaluation run is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An evaluation query and the span of the document it should find. */
interface EvalQuery {
  docId: string;
  text: string;
  start: number;
  end: number;
}

const round = (n: number, digits = 3) => Math.round(n * 10 ** digits) / 10 ** digits;

@Injectable()
export class RagService {
  private readonly indexes = new Map<ChunkingStrategy, RagIndexFile>();
  private params: ChunkingParams = structuredClone(DEFAULT_CHUNKING_PARAMS);
  private queue: Promise<unknown> = Promise.resolve();
  private status: IndexingStatus = { busy: false };
  private readonly lexicalCache = new WeakMap<IndexedChunk[], Bm25Index>();

  /** mtime of each index file as last read or written, to notice changes made by the CLI. */
  private readonly loadedAt = new Map<ChunkingStrategy, number>();

  constructor() {
    fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });
    this.sync();
  }

  /** Re-reads index files changed on disk since they were loaded (the CLI and the server share data/rag). */
  private sync(): void {
    for (const strategy of CHUNKING_STRATEGIES) {
      const mtime = fs.existsSync(indexPath(strategy)) ? fs.statSync(indexPath(strategy)).mtimeMs : 0;
      if (this.loadedAt.get(strategy) === mtime) continue;
      this.loadedAt.set(strategy, mtime);
      const index = this.readIndex(strategy);
      if (index) {
        this.indexes.set(strategy, index);
        (this.params as unknown as Record<string, unknown>)[strategy] = index.params;
      } else {
        this.indexes.delete(strategy);
      }
    }
  }

  private readIndex(strategy: ChunkingStrategy): RagIndexFile | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(indexPath(strategy), 'utf8')) as RagIndexFile;
      // Indexes from an older layout are rebuilt rather than misread.
      const valid =
        parsed.version === 1 &&
        Array.isArray(parsed.chunks) &&
        parsed.documents.every((d) => d.id && fs.existsSync(path.join(DOCUMENTS_DIR, `${d.id}.json`)));
      return valid ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private writeIndex(index: RagIndexFile): void {
    index.updatedAt = new Date().toISOString();
    const file = indexPath(index.strategy);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(index));
    fs.renameSync(`${file}.tmp`, file);
    this.loadedAt.set(index.strategy, fs.statSync(file).mtimeMs);
  }

  /** Indexing runs one job at a time: the model is CPU-bound and both jobs would rewrite the same files. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => {
      this.sync();
      return job();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private setStatus(status: Partial<IndexingStatus>): void {
    this.status = { ...this.status, ...status };
  }

  getStatus(): IndexingStatus {
    return this.status;
  }

  getParams(): ChunkingParams {
    this.sync();
    return this.params;
  }

  private async ensureIndex(strategy: ChunkingStrategy, info: EmbeddingInfo): Promise<RagIndexFile> {
    let index = this.indexes.get(strategy);
    if (!index || index.embedding.model !== info.model) {
      index = {
        version: 1,
        strategy,
        params: this.params[strategy],
        embedding: info,
        updatedAt: new Date().toISOString(),
        documents: [],
        chunks: [],
      };
      this.indexes.set(strategy, index);
    }
    return index;
  }

  private chunk(doc: LoadedDocument, id: string, strategy: ChunkingStrategy): Chunk[] {
    const ctx = { docId: id, file: baseName(doc.source) };
    return strategy === 'fixed'
      ? chunkFixed(doc, ctx, this.params.fixed)
      : chunkStructural(doc, ctx, this.params.structural);
  }

  /** Chunks and embeds one document with every strategy, replacing an earlier version of the same source. */
  private async indexLoaded(doc: LoadedDocument): Promise<IndexDocumentResult> {
    const id = createHash('sha1').update(doc.source).digest('hex').slice(0, 12);
    fs.writeFileSync(path.join(DOCUMENTS_DIR, `${id}.json`), JSON.stringify(doc));
    const info: IndexedDocumentInfo = {
      id,
      source: doc.source,
      title: doc.title,
      file: baseName(doc.source),
      kind: doc.kind,
      chars: doc.text.length,
      sections: doc.sections.length,
      indexedAt: new Date().toISOString(),
    };
    this.setStatus({ phase: `загрузка модели эмбеддингов — ${info.file}`, done: 0, total: 0 });
    const embedding = await embeddingInfo();
    const strategies: IndexDocumentResult['strategies'] = [];
    for (const strategy of CHUNKING_STRATEGIES) {
      const index = await this.ensureIndex(strategy, embedding);
      const chunks = this.chunk(doc, id, strategy);
      const started = Date.now();
      const vectors = await embed(
        chunks.map((c) => c.text),
        'passage',
        (done, total) => this.setStatus({ phase: `${strategy}: эмбеддинги — ${info.file}`, done, total }),
      );
      const embedMs = Date.now() - started;
      index.documents = [...index.documents.filter((d) => d.id !== id), { ...info, embedMs }];
      index.chunks = [
        ...index.chunks.filter((c) => !c.metadata.chunk_id.startsWith(`${strategy}:${id}:`)),
        ...chunks.map((c, i) => ({ ...c, tokens: vectors[i].tokens, embedding: vectors[i].vector })),
      ];
      index.params = this.params[strategy];
      this.writeIndex(index);
      strategies.push({ strategy, chunks: chunks.length, embedMs });
    }
    return { document: this.view(info), strategies };
  }

  private async runIndexing<T>(label: string, job: () => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      this.status = { busy: true, phase: label };
      try {
        const result = await job();
        this.status = { busy: false };
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.status = { busy: false, error: message };
        throw new BadRequestException(message);
      }
    });
  }

  addFromUrl(url: string): Promise<IndexDocumentResult> {
    if (!url?.trim()) throw new BadRequestException('url is required');
    return this.runIndexing(`загрузка ${url}`, async () => this.indexLoaded(await loadFromUrl(url.trim())));
  }

  addFromFile(name: string, contentBase64: string): Promise<IndexDocumentResult> {
    if (!name?.trim() || !contentBase64) throw new BadRequestException('name and contentBase64 are required');
    const data = Buffer.from(contentBase64, 'base64');
    return this.runIndexing(`разбор ${name}`, async () => this.indexLoaded(await loadDocument(name.trim(), data)));
  }

  /** Loads a local file by path — used by the CLI. */
  addFromPath(filePath: string): Promise<IndexDocumentResult> {
    return this.runIndexing(`разбор ${filePath}`, async () =>
      this.indexLoaded(await loadDocument(path.basename(filePath), fs.readFileSync(filePath))),
    );
  }

  /** New chunking parameters re-chunk and re-embed every stored document. */
  setParams(params: Partial<ChunkingParams>): Promise<{ params: ChunkingParams; documents: number }> {
    return this.runIndexing('переиндексация', async () => {
      this.params = {
        fixed: { ...this.params.fixed, ...params.fixed },
        structural: { ...this.params.structural, ...params.structural },
      };
      const ids = this.documentIds();
      for (const id of ids) {
        await this.indexLoaded(this.readDocument(id));
      }
      return { params: this.params, documents: ids.length };
    });
  }

  remove(id: string): Promise<{ deleted: true }> {
    return this.enqueue(async () => {
      if (!this.documentIds().includes(id)) throw new NotFoundException(`No document ${id}`);
      for (const index of this.indexes.values()) {
        index.documents = index.documents.filter((d) => d.id !== id);
        index.chunks = index.chunks.filter((c) => !c.metadata.chunk_id.startsWith(`${index.strategy}:${id}:`));
        this.writeIndex(index);
      }
      fs.rmSync(path.join(DOCUMENTS_DIR, `${id}.json`), { force: true });
      return { deleted: true as const };
    });
  }

  private documentIds(): string[] {
    const ids = new Set<string>();
    for (const index of this.indexes.values()) index.documents.forEach((d) => ids.add(d.id));
    return [...ids];
  }

  private view(info: IndexedDocumentInfo): RagDocumentView {
    const chunks = {} as Record<ChunkingStrategy, number>;
    for (const strategy of CHUNKING_STRATEGIES) {
      const prefix = `${strategy}:${info.id}:`;
      chunks[strategy] = this.indexes.get(strategy)?.chunks.filter((c) => c.metadata.chunk_id.startsWith(prefix)).length ?? 0;
    }
    return { ...info, chunks };
  }

  list(): { documents: RagDocumentView[]; params: ChunkingParams; embedding?: EmbeddingInfo; status: IndexingStatus } {
    this.sync();
    const seen = new Map<string, IndexedDocumentInfo>();
    for (const index of this.indexes.values()) index.documents.forEach((d) => seen.set(d.id, d));
    const embedding = [...this.indexes.values()][0]?.embedding;
    return { documents: [...seen.values()].map((d) => this.view(d)), params: this.params, embedding, status: this.status };
  }

  chunks(id: string, strategy: ChunkingStrategy, offset = 0, limit = 20): { total: number; chunks: (Chunk & { tokens: number })[] } {
    this.sync();
    const index = this.indexes.get(strategy);
    if (!index) throw new NotFoundException(`No ${strategy} index`);
    const all = index.chunks.filter((c) => c.metadata.chunk_id.startsWith(`${strategy}:${id}:`));
    return {
      total: all.length,
      chunks: all.slice(offset, offset + limit).map(({ metadata, text, tokens }) => ({ metadata, text, tokens })),
    };
  }

  private rank(strategy: ChunkingStrategy, vector: number[], k: number): SearchHit[] {
    const index = this.indexes.get(strategy);
    if (!index) return [];
    const top: SearchHit[] = [];
    for (const c of index.chunks) {
      const score = dot(vector, c.embedding);
      if (top.length < k || score > top[top.length - 1].score) {
        top.push({ score, metadata: c.metadata, text: c.text });
        top.sort((a, b) => b.score - a.score);
        if (top.length > k) top.pop();
      }
    }
    return top.map((h) => ({ ...h, score: round(h.score, 4) }));
  }

  /** BM25 over an index's chunks, rebuilt whenever its chunk list is replaced. */
  private lexical(chunks: IndexedChunk[]): Bm25Index {
    let bm25 = this.lexicalCache.get(chunks);
    if (!bm25) {
      bm25 = new Bm25Index(chunks.map((c) => c.text));
      this.lexicalCache.set(chunks, bm25);
    }
    return bm25;
  }

  /** Reciprocal rank fusion of the vector and BM25 rankings: score = Σ 1 / (60 + rank). */
  private rankHybrid(strategy: ChunkingStrategy, query: string, vector: number[], k: number): SearchHit[] {
    const index = this.indexes.get(strategy);
    if (!index?.chunks.length) return [];
    const chunks = index.chunks;
    const cosine = chunks.map((c) => dot(vector, c.embedding));
    const bm25 = this.lexical(chunks).scores(query);
    const rankOf = (scores: number[]) => {
      const ranks = new Array<number>(scores.length);
      scores
        .map((s, i) => [s, i])
        .sort((a, b) => b[0] - a[0])
        .forEach(([, i], r) => (ranks[i] = r));
      return ranks;
    };
    const vectorRank = rankOf(cosine);
    const lexicalRank = rankOf(bm25);
    return chunks
      .map((c, i) => ({
        fused: 1 / (60 + vectorRank[i]) + (bm25[i] > 0 ? 1 / (60 + lexicalRank[i]) : 0),
        hit: { score: round(cosine[i], 4), lexical: round(bm25[i], 2), metadata: c.metadata, text: c.text } as SearchHit,
      }))
      .sort((a, b) => b.fused - a.fused)
      .slice(0, k)
      .map((x) => x.hit);
  }

  private rankBy(mode: SearchMode, strategy: ChunkingStrategy, query: string, vector: number[], k: number): SearchHit[] {
    return mode === 'hybrid' ? this.rankHybrid(strategy, query, vector, k) : this.rank(strategy, vector, k);
  }

  async search(query: string, k = 5, mode: SearchMode = 'vector'): Promise<Record<ChunkingStrategy, SearchHit[]>> {
    this.sync();
    if (!query?.trim()) throw new BadRequestException('query is required');
    const [{ vector }] = await embed([query.trim()], 'query');
    const result = {} as Record<ChunkingStrategy, SearchHit[]>;
    for (const strategy of CHUNKING_STRATEGIES) {
      result[strategy] = this.rankBy(mode, strategy, query.trim(), vector, Math.min(Math.max(1, k), 50));
    }
    return result;
  }

  /** Top-k chunks of one strategy for a chat question (Day 21: RAG in the chat). */
  async retrieve(query: string, strategy: ChunkingStrategy, k: number, mode: SearchMode = 'vector'): Promise<SearchHit[]> {
    this.sync();
    if (!this.indexes.get(strategy)?.chunks.length || !query.trim()) return [];
    const [{ vector }] = await embed([query.trim()], 'query');
    return this.rankBy(mode, strategy, query.trim(), vector, Math.min(Math.max(1, k), 20));
  }

  private stats(strategy: ChunkingStrategy): StrategyStats | undefined {
    const index = this.indexes.get(strategy);
    if (!index || !index.chunks.length) return undefined;
    const lengths = index.chunks.map((c) => c.text.length);
    const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const stdDev = Math.sqrt(lengths.reduce((a, l) => a + (l - avg) ** 2, 0) / lengths.length);
    const texts = new Map<string, string>();
    for (const d of index.documents) {
      texts.set(d.id, this.readDocument(d.id).text);
    }
    const docChars = index.documents.reduce((a, d) => a + d.chars, 0);
    const chunks = index.chunks;
    const share = (pred: (c: IndexedChunk) => boolean) => round(chunks.filter(pred).length / chunks.length);
    return {
      strategy,
      params: index.params,
      documents: index.documents.length,
      chunks: index.chunks.length,
      chars: { avg: Math.round(avg), median: Math.round(median(lengths)), min: Math.min(...lengths), max: Math.max(...lengths), stdDev: Math.round(stdDev) },
      tokens: {
        avg: Math.round(index.chunks.reduce((a, c) => a + c.tokens, 0) / index.chunks.length),
        max: Math.max(...index.chunks.map((c) => c.tokens)),
      },
      truncatedShare: share((c) => c.tokens > index.embedding.maxTokens),
      crossSectionShare: share((c) => c.metadata.sectionsSpanned > 1),
      brokenEndShare: share((c) => endsMidSentence(texts.get(c.metadata.chunk_id.split(':')[1]) ?? '', c)),
      redundancy: round(lengths.reduce((a, b) => a + b, 0) / Math.max(1, docChars), 2),
      tinyShare: share((c) => c.text.length < 200),
      embedMs: index.documents.reduce((a, d) => a + d.embedMs, 0),
      indexBytes: fs.existsSync(indexPath(strategy)) ? fs.statSync(indexPath(strategy)).size : 0,
    };
  }

  /** The loaded document as stored at indexing time (data/rag/documents/<id>.json). */
  private readDocument(id: string): LoadedDocument {
    return JSON.parse(fs.readFileSync(path.join(DOCUMENTS_DIR, `${id}.json`), 'utf8')) as LoadedDocument;
  }

  private loadDocuments(): (LoadedDocument & { id: string })[] {
    return this.documentIds().map((id) => ({ id, ...this.readDocument(id) }));
  }

  /**
   * Evaluation queries, sampled reproducibly with documents weighted by size:
   * sentences of 60–300 characters, and section headings (distinct, with a
   * section body of at least 200 characters to find).
   */
  private sampleQueries(sample: number, seed: number): Record<RetrievalEvalKind, EvalQuery[]> {
    const random = mulberry32(seed);
    const docs = this.loadDocuments();
    const candidates: Record<RetrievalEvalKind, { doc: string; items: EvalQuery[] }[]> = {
      sentence: docs.map((doc) => ({
        doc: doc.id,
        items: [...doc.text.matchAll(/[^.!?…\n]+[.!?…]+/g)]
          .filter((m) => m[0].trim().length >= 60 && m[0].trim().length <= 300 && (m[0].match(/\p{L}/gu)?.length ?? 0) > 40)
          .map((m) => ({ docId: doc.id, text: m[0].trim(), start: m.index! + m[0].length / 2, end: m.index! + m[0].length / 2 + 1 })),
      })),
      heading: docs.map((doc) => {
        const seen = new Set<string>();
        const items: EvalQuery[] = [];
        for (const section of doc.sections) {
          const leaf = section.path[section.path.length - 1];
          if (!leaf || leaf.length < 4 || section.text.length < 200 || seen.has(leaf)) continue;
          seen.add(leaf);
          items.push({ docId: doc.id, text: leaf, start: section.start, end: section.end });
        }
        return { doc: doc.id, items };
      }),
    };
    const sizes = new Map(docs.map((d) => [d.id, d.text.length]));
    const result = {} as Record<RetrievalEvalKind, EvalQuery[]>;
    for (const kind of Object.keys(candidates) as RetrievalEvalKind[]) {
      const pools = candidates[kind].filter((p) => p.items.length);
      const total = pools.reduce((a, p) => a + sizes.get(p.doc)!, 0);
      const picked: EvalQuery[] = [];
      const used = new Set<EvalQuery>();
      const available = pools.reduce((a, p) => a + p.items.length, 0);
      for (let attempt = 0; picked.length < Math.min(sample, available) && attempt < sample * 50; attempt++) {
        let r = random() * total;
        const pool = pools.find((p) => (r -= sizes.get(p.doc)!) < 0) ?? pools[pools.length - 1];
        const item = pool.items[Math.floor(random() * pool.items.length)];
        if (used.has(item)) continue;
        used.add(item);
        picked.push(item);
      }
      result[kind] = picked;
    }
    return result;
  }

  async compare(sample = 0, seed = 21): Promise<CompareResult> {
    this.sync();
    const stats = CHUNKING_STRATEGIES.map((s) => this.stats(s)).filter((s): s is StrategyStats => !!s);
    if (!sample || !stats.length) return { stats };
    const queries = this.sampleQueries(Math.min(sample, 500), seed);
    const isHit: Record<RetrievalEvalKind, (q: EvalQuery, m: ChunkMetadata) => boolean> = {
      sentence: (q, m) => m.start <= q.start && q.start < m.end,
      heading: (q, m) => Math.min(m.end, q.end) - Math.max(m.start, q.start) >= (m.end - m.start) / 2,
    };
    const results: RetrievalEval[] = [];
    for (const kind of Object.keys(queries) as RetrievalEvalKind[]) {
      const list = queries[kind];
      if (!list.length) continue;
      const vectors = await embed(list.map((q) => q.text), 'query');
      for (const strategy of CHUNKING_STRATEGIES) {
        if (!this.indexes.get(strategy)?.chunks.length) continue;
        let h1 = 0, h3 = 0, h5 = 0, rr = 0;
        list.forEach((q, i) => {
          const rank = this.rank(strategy, vectors[i].vector, 5).findIndex(
            (h) => h.metadata.chunk_id.split(':')[1] === q.docId && isHit[kind](q, h.metadata),
          );
          if (rank < 0) return;
          if (rank === 0) h1++;
          if (rank < 3) h3++;
          h5++;
          rr += 1 / (rank + 1);
        });
        const n = list.length;
        results.push({ kind, strategy, queries: n, hitAt1: round(h1 / n), hitAt3: round(h3 / n), hitAt5: round(h5 / n), mrr: round(rr / n) });
      }
    }
    return { stats, evaluation: { sample, seed, results } };
  }
}
