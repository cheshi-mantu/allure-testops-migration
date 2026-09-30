/**
 * Keeps the number of requests within any window of `windowMs` at or below `limit`.
 * Requests wait in order; a 429 from the server pauses everyone for the time it asks for.
 */
export class RateLimiter {
  private readonly stamps: number[] = [];
  private pausedUntil = 0;
  private queue: Promise<void> = Promise.resolve();
  /** Total time requests spent waiting for the limiter, for reporting. */
  waitedMs = 0;
  requests = 0;

  constructor(
    private limit: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  get requestsPerWindow(): number {
    return this.limit;
  }

  setLimit(limit: number) {
    this.limit = Math.max(1, Math.floor(limit));
  }

  /** Called when the server answered 429 with Retry-After. */
  pauseFor(ms: number) {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms);
  }

  /**
   * Waits for a free slot. Call the returned function when the response arrives: the slot is then
   * counted from that moment, because the server counts the request when it receives it, which can
   * be later than when it was sent. Counting from the send time would free slots too early.
   */
  async acquire(): Promise<() => void> {
    const turn = this.queue.then(() => this.take());
    this.queue = turn.then(
      () => undefined,
      () => undefined,
    );
    const stamp = await turn;
    return () => {
      const index = this.stamps.indexOf(stamp.value);
      if (index >= 0) {
        stamp.value = this.now();
        this.stamps[index] = stamp.value;
        this.stamps.sort((a, b) => a - b);
      }
    };
  }

  private async take(): Promise<{ value: number }> {
    for (;;) {
      const now = this.now();
      while (this.stamps.length > 0 && this.stamps[0]! <= now - this.windowMs) {
        this.stamps.shift();
      }
      let wait = 0;
      if (this.pausedUntil > now) {
        wait = this.pausedUntil - now;
      } else if (this.stamps.length >= this.limit) {
        wait = this.stamps[0]! + this.windowMs - now;
      }
      if (wait <= 0) {
        this.stamps.push(now);
        this.requests += 1;
        return { value: now };
      }
      this.waitedMs += wait;
      await this.sleep(wait);
    }
  }
}

const shared = new Map<string, RateLimiter>();

/**
 * TestRail counts requests per instance, so every client talking to the same instance
 * (discovery, preview, runs of different profiles) shares one limiter.
 */
export function sharedRateLimiter(endpoint: string, requestsPerMinute: number): RateLimiter {
  let key: string;
  try {
    key = new URL(endpoint).origin.toLowerCase();
  } catch {
    key = endpoint.trim().toLowerCase();
  }
  let limiter = shared.get(key);
  if (!limiter) {
    limiter = new RateLimiter(requestsPerMinute);
    shared.set(key, limiter);
  } else {
    limiter.setLimit(requestsPerMinute);
  }
  return limiter;
}
