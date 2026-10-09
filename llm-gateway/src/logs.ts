import { Response } from 'express';

/** What the live log page shows for one /v1/chat/completions call; it fills in as the request goes. */
export interface LogEntry {
  id: string;
  startedAt: number;
  client: string;
  /** `X-Client-Name` header, e.g. which simulator — several devices may share one key. */
  device?: string;
  model?: string;
  stream?: boolean;
  messages?: number;
  /** Last user message, shortened. */
  preview?: string;
  state: 'queued' | 'generating' | 'done';
  /** Text generated so far / in total. */
  chars: number;
  completionTokens?: number;
  promptTokens?: number;
  /** Response body size on the wire. */
  bytes?: number;
  status?: number;
  finishReason?: 'stop' | 'length';
  outcome?: string;
  error?: string;
  queuedMs?: number;
  /** Time to the first generated token. */
  firstTokenMs?: number;
  durationMs?: number;
}

const MAX_ENTRIES = 300;
const PROGRESS_EVERY_MS = 200;

/** Keeps the latest entries and pushes every change to the open log pages over SSE. */
export class LogHub {
  private readonly entries: LogEntry[] = [];
  private readonly subscribers = new Set<Response>();
  private readonly lastProgress = new Map<string, number>();

  add(entry: LogEntry) {
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
    this.broadcast(entry);
  }

  /** Merges `patch` into the entry and broadcasts it; `throttle` drops updates that come too often (token progress). */
  update(entry: LogEntry, patch: Partial<LogEntry>, throttle = false) {
    Object.assign(entry, patch);
    if (throttle) {
      const now = Date.now();
      if (now - (this.lastProgress.get(entry.id) ?? 0) < PROGRESS_EVERY_MS) return;
      this.lastProgress.set(entry.id, now);
    } else if (entry.state === 'done') {
      this.lastProgress.delete(entry.id);
    }
    this.broadcast(entry);
  }

  subscribe(res: Response) {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write(`event: snapshot\ndata: ${JSON.stringify(this.entries)}\n\n`);
    this.subscribers.add(res);
    // Comments keep proxies and idle timeouts from closing a quiet stream.
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    res.on('close', () => {
      clearInterval(ping);
      this.subscribers.delete(res);
    });
  }

  private broadcast(entry: LogEntry) {
    const message = `data: ${JSON.stringify(entry)}\n\n`;
    for (const res of this.subscribers) res.write(message);
  }
}
