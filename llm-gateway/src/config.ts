import 'dotenv/config';

function int(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return value;
}

function list(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** `GATEWAY_KEYS=alice:<key>,bob:<key>` — the name is what logs and per-client limits use. */
function parseKeys(): Map<string, string> {
  const keys = new Map<string, string>();
  for (const entry of list('GATEWAY_KEYS')) {
    const i = entry.indexOf(':');
    const [client, key] = i > 0 ? [entry.slice(0, i), entry.slice(i + 1)] : [`client${keys.size + 1}`, entry];
    if (key.length < 16) throw new Error(`GATEWAY_KEYS: the key for "${client}" is shorter than 16 characters`);
    keys.set(key, client);
  }
  return keys;
}

export const config = {
  port: int('PORT', 8088),
  host: process.env.HOST?.trim() || '0.0.0.0',
  ollamaUrl: (process.env.OLLAMA_URL?.trim() || 'http://127.0.0.1:11434').replace(/\/$/, ''),
  /** key -> client name. Empty only with ALLOW_NO_AUTH=1 (local experiments). */
  keys: parseKeys(),
  allowNoAuth: process.env.ALLOW_NO_AUTH === '1',
  defaultModel: process.env.DEFAULT_MODEL?.trim() || 'qwen2.5:7b',
  /** Models clients may ask for; empty = everything installed in Ollama. */
  allowedModels: list('ALLOWED_MODELS'),

  /**
   * Context window the model is loaded with (Ollama `num_ctx`). Fixed for
   * every request: a different num_ctx makes Ollama reload the model. A
   * prompt that doesn't fit is rejected with its exact token count instead
   * of being silently cut from the start.
   */
  maxContextTokens: int('MAX_CONTEXT_TOKENS', 8192),
  /** Cap on `max_tokens`; also the default when a client sends none. */
  maxOutputTokens: int('MAX_OUTPUT_TOKENS', 1024),
  maxMessages: int('MAX_MESSAGES', 100),
  maxBodyBytes: int('MAX_BODY_BYTES', 512 * 1024),

  /** Per client, sliding 60 s window. 0 disables. */
  rateLimitPerMinute: int('RATE_LIMIT_PER_MINUTE', 20),
  /** Requests generated at the same time; the rest wait in the queue. */
  maxConcurrent: int('MAX_CONCURRENT', 1) || 1,
  /** Waiting requests beyond this get 503 right away. */
  maxQueue: int('MAX_QUEUE', 8),
  queueTimeoutMs: int('QUEUE_TIMEOUT_MS', 120_000),
  /** Whole generation, from the moment a slot is taken. */
  requestTimeoutMs: int('REQUEST_TIMEOUT_MS', 300_000),
  keepAlive: process.env.OLLAMA_KEEP_ALIVE?.trim() || '30m',
};

if (config.keys.size === 0 && !config.allowNoAuth) {
  throw new Error('GATEWAY_KEYS is empty. Set at least one key (see .env.example) or ALLOW_NO_AUTH=1 for local-only use.');
}
