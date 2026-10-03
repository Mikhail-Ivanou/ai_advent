import { callLlm, LlmUsage } from '../llm/llm.client';
import { MODELS_DIR } from './embedder';

// Second stage after retrieval (Day 23): the first stage (embeddings / BM25)
// scores the question and a chunk independently and is tuned for recall;
// a reranker reads the question and the chunk *together* and scores how well
// the chunk answers it, so the right passage can climb from rank 15 to 1 and
// a threshold on its score can cut what is merely on-topic.
//
// - "cross-encoder": a local multilingual model (mMiniLMv2 trained on
//   mMARCO, Russian included) — ~25 ms per pair on CPU, no API calls;
// - "llm": the chat model rates every candidate 0–10 in one call.
// Both return a relevance in 0..1.

export type RerankerKind = 'cross-encoder' | 'llm';

export const CROSS_ENCODER_MODEL = process.env.RAG_RERANK_MODEL ?? 'cross-encoder/mmarco-mMiniLMv2-L12-H384-v1';
const CROSS_ENCODER_FILE = process.env.RAG_RERANK_MODEL_FILE ?? 'model_qint8_arm64';
const BATCH_SIZE = 8;

type CrossEncoder = {
  tokenizer: (a: string[], o: { text_pair: string[]; padding: boolean; truncation: boolean; max_length: number }) => unknown;
  model: (inputs: unknown) => Promise<{ logits: { data: Float32Array } }>;
};

let crossEncoderPromise: Promise<CrossEncoder> | undefined;

function getCrossEncoder(): Promise<CrossEncoder> {
  crossEncoderPromise ??= (async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AutoTokenizer, AutoModelForSequenceClassification, env } = require('@huggingface/transformers');
    env.cacheDir = MODELS_DIR;
    const [tokenizer, model] = await Promise.all([
      AutoTokenizer.from_pretrained(CROSS_ENCODER_MODEL),
      AutoModelForSequenceClassification.from_pretrained(CROSS_ENCODER_MODEL, {
        dtype: 'fp32',
        model_file_name: CROSS_ENCODER_FILE,
      }),
    ]);
    return { tokenizer, model } as CrossEncoder;
  })().catch((error) => {
    crossEncoderPromise = undefined;
    throw error;
  });
  return crossEncoderPromise;
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** Relevance of each text to the query, 0..1 (sigmoid of the cross-encoder logit). */
export async function crossEncoderScores(query: string, texts: string[]): Promise<number[]> {
  const { tokenizer, model } = await getCrossEncoder();
  const scores: number[] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const inputs = tokenizer(new Array(batch.length).fill(query), {
      text_pair: batch,
      padding: true,
      truncation: true,
      max_length: 512,
    });
    const { logits } = await model(inputs);
    scores.push(...Array.from(logits.data, sigmoid));
  }
  return scores;
}

/** Relevance of each text to the query as rated by the LLM (0–10 -> 0..1), one call for all candidates. */
export async function llmScores(query: string, texts: string[], model?: string): Promise<{ scores: number[]; usage?: LlmUsage }> {
  const list = texts.map((t, i) => `<${i + 1}>\n${t.slice(0, 1200)}\n</${i + 1}>`).join('\n');
  const prompt = [
    'Оцени, насколько каждый фрагмент помогает ответить на вопрос.',
    '10 — фрагмент прямо содержит ответ; 5 — по теме, но ответа нет; 0 — не относится к вопросу.',
    `Вопрос: ${query}`,
    '',
    list,
    '',
    `Верни JSON {"scores": [число для фрагмента 1, ..., для фрагмента ${texts.length}]} — ровно ${texts.length} чисел по порядку.`,
  ].join('\n');
  const result = await callLlm(prompt, { format: 'json', temperature: 0, model }, 'rag:rerank-llm');
  try {
    const raw = JSON.parse(result.content).scores as unknown[];
    return { scores: texts.map((_, i) => Math.min(1, Math.max(0, Number(raw?.[i]) / 10 || 0))), usage: result.usage };
  } catch {
    // An unparsable rating must not drop everything — keep the first-stage order.
    return { scores: texts.map((_, i) => 1 - i / (texts.length * 2)), usage: result.usage };
  }
}

/** Relevance 0..1 per text, plus the LLM tokens it cost (LLM reranker only). */
export async function rerankScores(
  kind: RerankerKind,
  query: string,
  texts: string[],
  model?: string,
): Promise<{ scores: number[]; usage?: LlmUsage }> {
  return kind === 'llm' ? llmScores(query, texts, model) : { scores: await crossEncoderScores(query, texts) };
}
