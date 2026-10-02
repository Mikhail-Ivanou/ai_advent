// Document indexing for RAG (Day 21): documents are loaded into a common
// section tree, split into chunks by one of two strategies, embedded locally
// and stored as a JSON index per strategy (data/rag/<strategy>.json).

export type DocumentKind = 'fb2' | 'markdown' | 'html' | 'pdf' | 'code' | 'text';

/**
 * One structural unit of a document — a book section, a markdown/HTML
 * heading block, a PDF page, a top-level code block. `start`/`end` are
 * offsets of `text` in the document's full text (`LoadedDocument.text`).
 */
export interface DocSection {
  /** Heading path from the top, e.g. ["Часть первая", "Глава 3"]. Empty for text before the first heading. */
  path: string[];
  text: string;
  start: number;
  end: number;
}

export interface LoadedDocument {
  /** Where it came from: a URL or the uploaded file's name. Re-indexing the same source replaces it. */
  source: string;
  title: string;
  kind: DocumentKind;
  /** Full plain text — the sections joined with blank lines. */
  text: string;
  sections: DocSection[];
}

export type ChunkingStrategy = 'fixed' | 'structural';

export const CHUNKING_STRATEGIES: ChunkingStrategy[] = ['fixed', 'structural'];

export interface FixedChunkingParams {
  /** Target chunk length in characters. */
  size: number;
  /** Characters shared by neighbouring chunks. */
  overlap: number;
}

export interface StructuralChunkingParams {
  /** A section longer than this is split by paragraphs into parts of at most this many characters. */
  maxSize: number;
  /** A section shorter than this is merged with its sibling or parent text. */
  minSize: number;
}

export interface ChunkingParams {
  fixed: FixedChunkingParams;
  structural: StructuralChunkingParams;
}

export const DEFAULT_CHUNKING_PARAMS: ChunkingParams = {
  fixed: { size: 1000, overlap: 150 },
  // ~1400 characters of Russian text is ~400 model tokens — under e5's 512 limit with the heading header.
  structural: { maxSize: 1400, minSize: 300 },
};

export interface ChunkMetadata {
  /** "<strategy>:<document id>:<ordinal>" — unique within an index. */
  chunk_id: string;
  /** URL or file name of the document. */
  source: string;
  /** Document title (book title, page <title>, first heading, file name). */
  title: string;
  /** File name for uploads, last URL path segment for web documents. */
  file: string;
  /** Heading path of the section the chunk starts in, joined with " › ". */
  section: string;
  strategy: ChunkingStrategy;
  /** Ordinal of the chunk within its document, 0-based. */
  index: number;
  /** Character offsets of the chunk in the document's full text. */
  start: number;
  end: number;
  /** Number of distinct sections the chunk's text spans (1 = stays inside one section). */
  sectionsSpanned: number;
  /** For a structural section split into several parts: "2/5". */
  part?: string;
}

export interface Chunk {
  metadata: ChunkMetadata;
  text: string;
}

export interface IndexedChunk extends Chunk {
  /** Model tokens of the embedded input; more than the model's limit means the tail was truncated. */
  tokens: number;
  /** L2-normalized embedding, so cosine similarity is a dot product. */
  embedding: number[];
}

export interface IndexedDocumentInfo {
  id: string;
  source: string;
  title: string;
  file: string;
  kind: DocumentKind;
  chars: number;
  sections: number;
  indexedAt: string;
}

/** On-disk shape of data/rag/<strategy>.json. */
export interface RagIndexFile {
  version: 1;
  strategy: ChunkingStrategy;
  params: FixedChunkingParams | StructuralChunkingParams;
  embedding: { model: string; dim: number; maxTokens: number };
  updatedAt: string;
  documents: (IndexedDocumentInfo & { embedMs: number })[];
  chunks: IndexedChunk[];
}

/**
 * How chunks are found: "vector" — cosine similarity of embeddings only;
 * "hybrid" — embeddings and BM25 ranked separately and fused (reciprocal rank
 * fusion), so rare names/terms matched literally also count (Day 22).
 */
export type SearchMode = 'vector' | 'hybrid';

export interface SearchHit {
  /** Cosine similarity to the query (shown in both modes; in hybrid mode the order is by fused rank). */
  score: number;
  /** Hybrid mode: BM25 score of the chunk, 0 when no query term occurs in it. */
  lexical?: number;
  metadata: ChunkMetadata;
  text: string;
}

/** Per-strategy statistics for the comparison table. */
export interface StrategyStats {
  strategy: ChunkingStrategy;
  params: FixedChunkingParams | StructuralChunkingParams;
  documents: number;
  chunks: number;
  chars: { avg: number; median: number; min: number; max: number; stdDev: number };
  tokens: { avg: number; max: number };
  /** Share of chunks whose input exceeded the model's token limit (tail lost when embedding). */
  truncatedShare: number;
  /** Share of chunks spanning more than one section — i.e. mixing topics. */
  crossSectionShare: number;
  /** Share of chunks ending mid-sentence. */
  brokenEndShare: number;
  /** Total chunk characters / document characters (> 1 means overlap duplicates text). */
  redundancy: number;
  /** Share of chunks shorter than 200 characters — too little context to be useful alone. */
  tinyShare: number;
  embedMs: number;
  indexBytes: number;
}

/**
 * Retrieval checks that need no labelled data, so they compare strategies on
 * any document set:
 * - "sentence": a random sentence of a document is the query; a hit is a
 *   chunk covering that place of the text among the top-k.
 * - "heading": a section heading is the query ("about what is this part?");
 *   a hit is a chunk of which at least half lies inside that section — it
 *   measures whether chunks keep a topic together.
 */
export type RetrievalEvalKind = 'sentence' | 'heading';

export interface RetrievalEval {
  kind: RetrievalEvalKind;
  strategy: ChunkingStrategy;
  queries: number;
  hitAt1: number;
  hitAt3: number;
  hitAt5: number;
  mrr: number;
}

export interface CompareResult {
  stats: StrategyStats[];
  evaluation?: { sample: number; seed: number; results: RetrievalEval[] };
}
