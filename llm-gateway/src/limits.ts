/** Sliding-window request counter per client. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  /** Records a hit if allowed. `retryAfterMs` is when the oldest hit leaves the window. */
  take(client: string, now = Date.now()): { allowed: boolean; remaining: number; retryAfterMs: number } {
    if (this.limit === 0) return { allowed: true, remaining: Infinity, retryAfterMs: 0 };
    const recent = (this.hits.get(client) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(client, recent);
      return { allowed: false, remaining: 0, retryAfterMs: this.windowMs - (now - recent[0]) };
    }
    recent.push(now);
    this.hits.set(client, recent);
    return { allowed: true, remaining: this.limit - recent.length, retryAfterMs: 0 };
  }
}

export class QueueFullError extends Error {}
export class QueueTimeoutError extends Error {}

/**
 * At most `concurrency` generations at once; the rest wait in FIFO order.
 * Ollama queues on its own too, but here a full queue is a fast 503 and a
 * client that hung up leaves the line instead of holding a slot.
 */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<{ resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = [];

  constructor(
    private readonly concurrency: number,
    private readonly maxQueue: number,
    private readonly timeoutMs: number,
  ) {}

  get stats() {
    return { active: this.active, queued: this.waiting.length, concurrency: this.concurrency, maxQueue: this.maxQueue };
  }

  /** Resolves with a release function; rejects if the queue is full, the wait times out, or `signal` aborts. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.active < this.concurrency) {
      this.active++;
      return Promise.resolve(this.releaser());
    }
    if (this.waiting.length >= this.maxQueue) return Promise.reject(new QueueFullError('queue is full'));
    return new Promise((resolve, reject) => {
      const entry = {
        resolve: () => resolve(this.releaser()),
        reject,
        timer: setTimeout(() => this.drop(entry, new QueueTimeoutError('timed out waiting in the queue')), this.timeoutMs),
      };
      this.waiting.push(entry);
      signal?.addEventListener('abort', () => this.drop(entry, new Error('client went away')), { once: true });
    });
  }

  private drop(entry: (typeof this.waiting)[number], error: Error) {
    const i = this.waiting.indexOf(entry);
    if (i === -1) return;
    this.waiting.splice(i, 1);
    clearTimeout(entry.timer);
    entry.reject(error);
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve(); // the slot passes straight to the next in line
      } else {
        this.active--;
      }
    };
  }
}
