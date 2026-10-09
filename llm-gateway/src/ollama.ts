import { config } from './config.js';

/** An error with an OpenAI-style body, so clients built for that API can read it. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }

  toJSON() {
    return { error: { message: this.message, type: this.type, code: this.code, ...this.extra } };
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  stream: boolean;
  includeUsage: boolean;
  options: Record<string, unknown>;
}

/** One line of Ollama's /api/chat output (the whole body when not streaming). */
interface OllamaChunk {
  message?: { content?: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** Validates an OpenAI `/v1/chat/completions` body and applies the gateway's caps. */
export function parseChatRequest(body: unknown): ChatRequest {
  const bad = (message: string, param?: string) =>
    new ApiError(400, 'invalid_request_error', 'invalid_request', message, param ? { param } : {});
  if (!body || typeof body !== 'object') throw bad('Body must be a JSON object');
  const b = body as Record<string, unknown>;

  if (!Array.isArray(b.messages) || b.messages.length === 0) throw bad('`messages` must be a non-empty array', 'messages');
  if (b.messages.length > config.maxMessages) {
    throw bad(`Too many messages: ${b.messages.length}, the limit is ${config.maxMessages}`, 'messages');
  }
  const messages = b.messages.map((m, i): ChatMessage => {
    const { role, content } = (m ?? {}) as Record<string, unknown>;
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      throw bad(`messages[${i}].role must be system, user or assistant`, `messages[${i}].role`);
    }
    // OpenAI also allows content as an array of parts; only text parts make sense here.
    const text = Array.isArray(content)
      ? content.map((p) => (p && typeof p === 'object' && (p as { type?: unknown }).type === 'text' ? String((p as { text?: unknown }).text ?? '') : '')).join('')
      : content;
    if (typeof text !== 'string') throw bad(`messages[${i}].content must be a string`, `messages[${i}].content`);
    return { role, content: text };
  });

  const requested = b.max_completion_tokens ?? b.max_tokens;
  if (requested !== undefined && (!Number.isInteger(requested) || (requested as number) < 1)) {
    throw bad('`max_tokens` must be a positive integer', 'max_tokens');
  }
  const maxTokens = Math.min((requested as number | undefined) ?? config.maxOutputTokens, config.maxOutputTokens);

  const options: Record<string, unknown> = { num_ctx: config.maxContextTokens, num_predict: maxTokens };
  for (const [from, to] of [
    ['temperature', 'temperature'],
    ['top_p', 'top_p'],
    ['seed', 'seed'],
    ['presence_penalty', 'presence_penalty'],
    ['frequency_penalty', 'frequency_penalty'],
  ] as const) {
    if (b[from] === undefined) continue;
    if (typeof b[from] !== 'number') throw bad(`\`${from}\` must be a number`, from);
    options[to] = b[from];
  }
  if (b.stop !== undefined) options.stop = Array.isArray(b.stop) ? b.stop.map(String) : [String(b.stop)];

  const streamOptions = b.stream_options as { include_usage?: unknown } | undefined;
  return {
    model: typeof b.model === 'string' && b.model.trim() ? b.model.trim() : config.defaultModel,
    messages,
    maxTokens,
    stream: b.stream === true,
    includeUsage: streamOptions?.include_usage === true,
    options,
  };
}

export async function listModels(signal?: AbortSignal): Promise<string[]> {
  const res = await ollamaFetch('/api/tags', undefined, signal);
  const { models } = (await res.json()) as { models: Array<{ name: string }> };
  const names = models.map((m) => m.name);
  return config.allowedModels.length ? names.filter((n) => config.allowedModels.includes(n)) : names;
}

export async function ensureModelAllowed(model: string, signal?: AbortSignal) {
  const models = await listModels(signal);
  if (!models.includes(model)) {
    throw new ApiError(404, 'invalid_request_error', 'model_not_found', `Model "${model}" is not available. Available: ${models.join(', ')}`, {
      param: 'model',
    });
  }
}

/**
 * Runs a chat on Ollama's native /api/chat — not its /v1 endpoint, because
 * only the native one takes `num_ctx` and `truncate: false`. `onDelta` gets
 * every piece of generated text as it arrives.
 */
export async function chat(
  req: ChatRequest,
  signal: AbortSignal,
  onDelta: (text: string) => void,
): Promise<{ finishReason: 'stop' | 'length'; usage: Usage }> {
  const res = await ollamaFetch(
    '/api/chat',
    {
      model: req.model,
      messages: req.messages,
      stream: true,
      truncate: false,
      keep_alive: config.keepAlive,
      options: req.options,
    },
    signal,
  );

  let last: OllamaChunk = {};
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const bytes of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(bytes, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const chunk = JSON.parse(line) as OllamaChunk;
      if (chunk.error) throw new ApiError(502, 'api_error', 'upstream_error', `Model failed mid-answer: ${chunk.error}`);
      if (chunk.message?.content) onDelta(chunk.message.content);
      last = chunk;
    }
  }
  if (!last.done) throw new ApiError(502, 'api_error', 'upstream_error', 'Model stream ended before the answer was complete');

  const prompt = last.prompt_eval_count ?? 0;
  const completion = last.eval_count ?? 0;
  return {
    finishReason: last.done_reason === 'length' ? 'length' : 'stop',
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  };
}

async function ollamaFetch(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${config.ollamaUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError(502, 'api_error', 'upstream_unavailable', `Ollama is unreachable at ${config.ollamaUrl}: ${(error as Error).message}`);
  }
  if (res.ok) return res;
  throw upstreamError(res.status, await res.text());
}

/** Ollama nests llama.cpp's error JSON inside its own `error` string; dig the context overflow out of it. */
function upstreamError(status: number, text: string): ApiError {
  let message = text;
  try {
    message = (JSON.parse(text) as { error?: string }).error ?? text;
  } catch {
    // plain-text body
  }
  try {
    const inner = (JSON.parse(message) as { error?: { type?: string; message?: string; n_prompt_tokens?: number; n_ctx?: number } }).error;
    if (inner?.type === 'exceed_context_size_error') {
      return new ApiError(
        400,
        'invalid_request_error',
        'context_length_exceeded',
        `The conversation is ${inner.n_prompt_tokens} tokens, but the context window is ${inner.n_ctx}. Shorten or drop older messages.`,
        { prompt_tokens: inner.n_prompt_tokens, max_context_tokens: inner.n_ctx },
      );
    }
    if (inner?.message) message = inner.message;
  } catch {
    // not nested JSON
  }
  if (status === 404) return new ApiError(404, 'invalid_request_error', 'model_not_found', message);
  return new ApiError(502, 'api_error', 'upstream_error', `Ollama answered ${status}: ${message}`);
}
