import { randomUUID, timingSafeEqual } from 'crypto';
import express, { NextFunction, Request, Response } from 'express';
import { networkInterfaces } from 'os';
import { config } from './config.js';
import { LogEntry, LogHub } from './logs.js';
import { LOGS_PAGE } from './logs-page.js';
import { QueueFullError, QueueTimeoutError, RateLimiter, Semaphore } from './limits.js';
import { ApiError, chat, ensureModelAllowed, listModels, parseChatRequest } from './ollama.js';

const limiter = new RateLimiter(config.rateLimitPerMinute);
const slots = new Semaphore(config.maxConcurrent, config.maxQueue, config.queueTimeoutMs);
const keyBuffers = [...config.keys].map(([key, client]) => ({ key: Buffer.from(key), client }));
const logs = new LogHub();

type Authed = Request & { client: string };

/** Client name for a key, or undefined if it matches none. Compares against every key so timing doesn't hint at a near match. */
function clientForKey(raw: string): string | undefined {
  if (keyBuffers.length === 0) return 'anonymous';
  const given = Buffer.from(raw);
  let client: string | undefined;
  for (const k of keyBuffers) {
    if (given.length === k.key.length && timingSafeEqual(given, k.key)) client = k.client;
  }
  return client;
}

const bearer = (req: Request) => {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
};

function sendError(res: Response, error: unknown) {
  const apiError =
    error instanceof ApiError ? error : new ApiError(500, 'api_error', 'internal_error', (error as Error)?.message ?? 'Internal error');
  if (apiError.status >= 500) console.error(`[error] ${apiError.code}: ${apiError.message}`);
  res.locals.outcome = apiError.code;
  res.locals.error = apiError.message;
  res.status(apiError.status).json(apiError);
}

function requireKey(req: Request, res: Response, next: NextFunction) {
  const client = clientForKey(bearer(req));
  if (!client) {
    res.status(401).set('WWW-Authenticate', 'Bearer');
    return sendError(res, new ApiError(401, 'invalid_request_error', 'invalid_api_key', 'Missing or invalid API key'));
  }
  (req as Authed).client = client;
  next();
}

function rateLimit(req: Request, res: Response, next: NextFunction) {
  const { allowed, remaining, retryAfterMs } = limiter.take((req as Authed).client);
  if (config.rateLimitPerMinute) {
    res.set('X-RateLimit-Limit', String(config.rateLimitPerMinute));
    res.set('X-RateLimit-Remaining', String(remaining));
  }
  if (allowed) return next();
  const seconds = Math.ceil(retryAfterMs / 1000);
  res.set('Retry-After', String(seconds));
  sendError(
    res,
    new ApiError(429, 'rate_limit_error', 'rate_limit_exceeded', `Rate limit of ${config.rateLimitPerMinute} requests/min reached; retry in ${seconds} s`),
  );
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: config.maxBodyBytes }));

/**
 * Puts every chat call on the live log page, rejected ones included: an
 * entry when the request arrives, and its outcome, size and timings when the
 * response closes. The handler fills in the middle (`res.locals.log`).
 */
function trackChat(req: Request, res: Response, next: NextFunction) {
  const body = (req.body ?? {}) as { messages?: unknown; model?: unknown; stream?: unknown };
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((m) => m && typeof m === 'object' && (m as { role?: unknown }).role === 'user') as
    | { content?: unknown }
    | undefined;
  const text = typeof lastUser?.content === 'string' ? lastUser.content.replace(/\s+/g, ' ').trim() : '';
  const entry: LogEntry = {
    id: randomUUID(),
    startedAt: Date.now(),
    client: clientForKey(bearer(req)) ?? 'неизвестный ключ',
    device: clientName(req.get('X-Client-Name')),
    model: typeof body.model === 'string' && body.model ? body.model : config.defaultModel,
    stream: body.stream === true,
    messages: messages.length,
    preview: text.length > 200 ? `${text.slice(0, 200)}…` : text,
    state: 'queued',
    chars: 0,
  };
  res.locals.log = entry;
  logs.add(entry);

  let bytes = 0;
  const count = (chunk: unknown) => {
    if (typeof chunk === 'string' || chunk instanceof Uint8Array) bytes += Buffer.byteLength(chunk as string);
  };
  const write = res.write.bind(res) as (...args: unknown[]) => boolean;
  const end = res.end.bind(res) as (...args: unknown[]) => Response;
  res.write = ((chunk: unknown, ...rest: unknown[]) => (count(chunk), write(chunk, ...rest))) as typeof res.write;
  res.end = ((chunk?: unknown, ...rest: unknown[]) => (typeof chunk !== 'function' && count(chunk), end(chunk, ...rest))) as typeof res.end;

  res.on('close', () => {
    const finished = res.writableFinished;
    logs.update(entry, {
      state: 'done',
      status: finished ? res.statusCode : 499,
      outcome: finished ? (res.locals.outcome ?? 'ok') : 'client_closed',
      error: finished ? res.locals.error : undefined,
      bytes,
      durationMs: Date.now() - entry.startedAt,
    });
  });
  next();
}

/** `X-Client-Name` is percent-encoded by clients, since header values must be ASCII. */
function clientName(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch {
    // not encoded
  }
  return name.trim().slice(0, 60) || undefined;
}

/** Loopback sees the logs freely; from the network it takes a gateway key in `?key=` (EventSource can't send headers). */
function canViewLogs(req: Request): boolean {
  const ip = req.socket.remoteAddress ?? '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  return typeof req.query.key === 'string' && clientForKey(req.query.key) !== undefined && keyBuffers.length > 0;
}

app.get('/logs', (req, res) => {
  if (!canViewLogs(req)) return void res.status(401).type('text/plain').send('Open from this machine, or add ?key=<gateway key>');
  res.type('html').send(LOGS_PAGE);
});

app.get('/logs/stream', (req, res) => {
  if (!canViewLogs(req)) return void res.status(401).end();
  logs.subscribe(res);
});

/** Public: liveness, Ollama reachability, current load and the limits clients must respect. */
app.get('/health', async (_req, res) => {
  let ollama = 'ok';
  try {
    await listModels(AbortSignal.timeout(3000));
  } catch (error) {
    ollama = (error as Error).message;
  }
  res.status(ollama === 'ok' ? 200 : 503).json({
    status: ollama === 'ok' ? 'ok' : 'degraded',
    ollama,
    defaultModel: config.defaultModel,
    load: slots.stats,
    limits: {
      maxContextTokens: config.maxContextTokens,
      maxOutputTokens: config.maxOutputTokens,
      maxMessages: config.maxMessages,
      rateLimitPerMinute: config.rateLimitPerMinute,
    },
  });
});

app.get('/v1/models', requireKey, async (_req, res) => {
  try {
    const models = await listModels();
    res.json({ object: 'list', data: models.map((id) => ({ id, object: 'model', created: 0, owned_by: 'local' })) });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/v1/chat/completions', trackChat, requireKey, rateLimit, async (req, res) => {
  const client = (req as Authed).client;
  const log = res.locals.log as LogEntry;
  const started = Date.now();
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(started / 1000);
  // Fires when the client hangs up (or we finish): stops waiting in the queue and stops generation.
  const disconnect = new AbortController();
  res.on('close', () => disconnect.abort());

  let release: (() => void) | undefined;
  let queuedMs = 0;
  let outcome = 'ok';
  let usage = { prompt_tokens: 0, completion_tokens: 0 };
  let model = '?';
  try {
    const chatReq = parseChatRequest(req.body);
    model = chatReq.model;
    await ensureModelAllowed(model, disconnect.signal);

    try {
      release = await slots.acquire(disconnect.signal);
    } catch (error) {
      if (error instanceof QueueFullError || error instanceof QueueTimeoutError) {
        res.set('Retry-After', '10');
        throw new ApiError(503, 'server_busy', 'server_busy', `Server is busy (${error.message}); retry later`);
      }
      throw error;
    }
    queuedMs = Date.now() - started;
    logs.update(log, { state: 'generating', queuedMs, model, stream: chatReq.stream });
    const signal = AbortSignal.any([disconnect.signal, AbortSignal.timeout(config.requestTimeoutMs)]);

    const chunk = (delta: Record<string, unknown>, finishReason: string | null) => ({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });
    const sse = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    // Headers go out with the first token, so a context overflow (known before
    // any token) still gets a proper 400 instead of an error inside a 200 stream.
    const startStream = () => {
      if (res.headersSent) return;
      res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      sse(chunk({ role: 'assistant', content: '' }, null));
    };

    let text = '';
    try {
      const result = await chat(chatReq, signal, (delta) => {
        if (log.firstTokenMs === undefined) log.firstTokenMs = Date.now() - started;
        logs.update(log, { chars: log.chars + delta.length }, true);
        if (chatReq.stream) {
          startStream();
          sse(chunk({ content: delta }, null));
        } else {
          text += delta;
        }
      });
      usage = result.usage;
      log.promptTokens = usage.prompt_tokens;
      log.completionTokens = usage.completion_tokens;
      log.finishReason = result.finishReason;
      if (chatReq.stream) {
        startStream();
        sse(chunk({}, result.finishReason));
        if (chatReq.includeUsage) sse({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: result.usage });
        res.end('data: [DONE]\n\n');
      } else {
        res.json({
          id,
          object: 'chat.completion',
          created,
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: result.finishReason }],
          usage: result.usage,
        });
      }
    } catch (error) {
      if (disconnect.signal.aborted) throw new ApiError(499, 'api_error', 'client_closed', 'Client closed the connection');
      if (signal.aborted) throw new ApiError(504, 'api_error', 'timeout', `Generation took longer than ${config.requestTimeoutMs / 1000} s`);
      throw error;
    }
  } catch (error) {
    outcome = error instanceof ApiError ? error.code : 'internal_error';
    if (disconnect.signal.aborted) {
      outcome = 'client_closed';
    } else if (res.headersSent) {
      // Mid-stream failure: the status is already 200, so report it in-band.
      const body = error instanceof ApiError ? error : new ApiError(500, 'api_error', 'internal_error', (error as Error).message);
      res.locals.outcome = body.code;
      res.locals.error = body.message;
      res.end(`data: ${JSON.stringify(body)}\n\n`);
    } else {
      sendError(res, error);
    }
  } finally {
    release?.();
    console.log(
      `[chat] ${client} ${model} ${outcome} prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} ` +
        `queued=${queuedMs}ms total=${Date.now() - started}ms load=${slots.stats.active}/${slots.stats.queued}`,
    );
  }
});

app.use((_req: Request, res: Response) => {
  sendError(res, new ApiError(404, 'invalid_request_error', 'not_found', 'Unknown endpoint. Use POST /v1/chat/completions, GET /v1/models or GET /health'));
});

// Malformed JSON, oversized body and the like — keep the OpenAI error shape.
app.use((error: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
  if (error.type === 'entity.too.large') {
    return sendError(res, new ApiError(413, 'invalid_request_error', 'request_too_large', `Body exceeds ${config.maxBodyBytes} bytes`));
  }
  if (error.status && error.status < 500) return sendError(res, new ApiError(error.status, 'invalid_request_error', 'invalid_json', error.message));
  sendError(res, error);
});

app.listen(config.port, config.host, () => {
  const lan = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i!.address}:${config.port}`);
  console.log(`LLM gateway on http://${config.host}:${config.port} -> ${config.ollamaUrl} (default model ${config.defaultModel})`);
  if (config.host === '0.0.0.0' && lan.length) console.log(`  on the network: ${lan.join(', ')}`);
  console.log(
    `  clients: ${config.keys.size ? [...config.keys.values()].join(', ') : 'NO AUTH'}; ` +
      `context ${config.maxContextTokens}, output ≤${config.maxOutputTokens}, ${config.rateLimitPerMinute}/min per client, ` +
      `${config.maxConcurrent} at a time + queue ${config.maxQueue}`,
  );
});
