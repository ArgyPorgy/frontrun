export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly url: string,
  ) {
    super(`HTTP ${status} from ${new URL(url).host}: ${body.slice(0, 200)}`);
    this.name = "HttpError";
  }
}

export interface FetchJsonOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
  retries?: number;
}

const RETRYABLE = new Set([429, 502, 503, 504]);

export async function fetchJson<T>(url: string, opts: FetchJsonOptions = {}): Promise<T> {
  const { method = "GET", headers = {}, body, timeoutMs = 8_000, signal, retries = 0 } = opts;
  let attempt = 0;
  for (;;) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const res = await fetch(url, {
      method,
      headers: {
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const text = await res.text();
    if (res.ok) return (text ? JSON.parse(text) : undefined) as T;
    if (attempt < retries && RETRYABLE.has(res.status)) {
      attempt++;
      const reset = Number(res.headers.get("ratelimit-reset") ?? res.headers.get("retry-after") ?? 0);
      const jitter = Math.random() * 150;
      await new Promise((r) => setTimeout(r, Math.max(reset * 1000, 200 * 2 ** attempt) + jitter));
      continue;
    }
    throw new HttpError(res.status, text, url);
  }
}

/** Simple token bucket, for staying inside a provider's published rate limit. */
export class RateLimiter {
  private tokens: number;
  private last = Date.now();
  private queue: Array<() => void> = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly perMinute: number,
    private readonly burst: number = Math.max(1, Math.ceil(perMinute / 60)),
  ) {
    this.tokens = burst;
  }

  private refill() {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 60_000) * this.perMinute);
    this.last = now;
  }

  private drain = () => {
    this.timer = undefined;
    this.refill();
    while (this.queue.length && this.tokens >= 1) {
      this.tokens -= 1;
      this.queue.shift()!();
    }
    if (this.queue.length) {
      const wait = ((1 - this.tokens) / this.perMinute) * 60_000;
      this.timer = setTimeout(this.drain, Math.max(wait, 10));
    }
  };

  acquire(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      if (!this.timer) this.drain();
    });
  }

  /** True when a call would have to wait, so callers can serve stale data instead of queueing. */
  get saturated(): boolean {
    this.refill();
    return this.tokens < 1;
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export type WindowResult<T> = { status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown };

/**
 * Runs tasks together and returns when all finish or, past softMs, as soon as at least one has
 * succeeded. It never waits past hardMs. Tasks still running count as rejected.
 */
export function settleWithinWindow<T>(tasks: Array<Promise<T>>, softMs: number, hardMs: number): Promise<Array<WindowResult<T>>> {
  const results: Array<WindowResult<T> | undefined> = tasks.map(() => undefined);
  return new Promise((resolve) => {
    let remaining = tasks.length;
    let softExpired = false;
    let anySuccess = false;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(softTimer);
      clearTimeout(hardTimer);
      resolve(results.map((r) => r ?? { status: "rejected", reason: new Error(`no answer within ${softExpired ? softMs : hardMs}ms`) }));
    };
    const softTimer = setTimeout(() => {
      softExpired = true;
      if (anySuccess) finish();
    }, softMs);
    const hardTimer = setTimeout(finish, hardMs);
    if (!tasks.length) finish();
    tasks.forEach((task, i) => {
      task
        .then((value) => {
          results[i] = { status: "fulfilled", value };
          anySuccess = true;
          if (softExpired) finish();
        })
        .catch((reason: unknown) => {
          results[i] = { status: "rejected", reason };
        })
        .finally(() => {
          remaining--;
          if (remaining === 0) finish();
        });
    });
  });
}
