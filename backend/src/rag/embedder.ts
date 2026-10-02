import * as path from 'path';

// Embeddings are computed locally with transformers.js (ONNX on CPU), so
// indexing needs no API key and costs nothing. multilingual-e5-small handles
// Russian and English text and code reasonably and is ~120 MB quantized; it is
// downloaded from Hugging Face once into data/rag/models.
export const EMBEDDING_MODEL = process.env.RAG_EMBEDDING_MODEL ?? 'Xenova/multilingual-e5-small';
export const MODELS_DIR = path.resolve(__dirname, '../../data/rag/models');
const BATCH_SIZE = 16;

type Extractor = {
  (texts: string[], options: { pooling: 'mean'; normalize: boolean }): Promise<{ dims: number[]; data: Float32Array }>;
  tokenizer: { (text: string): { input_ids: { dims: number[] } }; model_max_length: number };
};

let extractorPromise: Promise<Extractor> | undefined;

function getExtractor(): Promise<Extractor> {
  extractorPromise ??= (async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { pipeline, env } = require('@huggingface/transformers');
    env.cacheDir = MODELS_DIR;
    return (await pipeline('feature-extraction', EMBEDDING_MODEL, { dtype: 'q8' })) as Extractor;
  })().catch((error) => {
    extractorPromise = undefined;
    throw error;
  });
  return extractorPromise;
}

export interface EmbeddingInfo {
  model: string;
  dim: number;
  maxTokens: number;
}

export async function embeddingInfo(): Promise<EmbeddingInfo> {
  const extractor = await getExtractor();
  const probe = await extractor(['query: probe'], { pooling: 'mean', normalize: true });
  return { model: EMBEDDING_MODEL, dim: probe.dims[1], maxTokens: Math.min(extractor.tokenizer.model_max_length, 512) };
}

/** E5 models are trained with "query: " / "passage: " prefixes — documents and questions are embedded differently. */
export type EmbedRole = 'passage' | 'query';

export interface Embedded {
  vector: number[];
  /** Tokens of the full input before truncation to the model's limit. */
  tokens: number;
}

export async function embed(
  texts: string[],
  role: EmbedRole,
  onProgress?: (done: number, total: number) => void,
): Promise<Embedded[]> {
  const extractor = await getExtractor();
  const out: Embedded[] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE).map((t) => `${role}: ${t}`);
    const tensor = await extractor(batch, { pooling: 'mean', normalize: true });
    const dim = tensor.dims[1];
    batch.forEach((input, j) => {
      const vector = Array.from(tensor.data.subarray(j * dim, (j + 1) * dim), (v) => Math.round(v * 1e6) / 1e6);
      out.push({ vector, tokens: extractor.tokenizer(input).input_ids.dims[1] });
    });
    onProgress?.(Math.min(i + BATCH_SIZE, texts.length), texts.length);
  }
  return out;
}

export function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
