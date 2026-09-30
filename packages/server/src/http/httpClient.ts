import { Agent, fetch, FormData, type Dispatcher, type RequestInit, type Response } from "undici";
import type { RateLimiter } from "./rateLimiter.js";

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface HttpClientOptions {
  /** Base URL, a trailing slash is added when missing. */
  baseUrl: string;
  /** Header values sent with every request, e.g. authorization. Never logged. */
  headers?: Record<string, string>;
  insecureTls?: boolean;
  /** Retries for 429 and 5xx responses and network errors. */
  retries?: number;
  timeoutMs?: number;
  /** Every attempt, including retries, waits for a slot here. */
  rateLimiter?: RateLimiter;
  /** Called before a retry, so long waits are visible in the run log. */
  onRetry?: (info: RetryInfo) => void;
  /** Test seam. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RetryInfo {
  /** URL without credentials. */
  url: string;
  attempt: number;
  of: number;
  reason: string;
  delayMs: number;
}

export type Query = Record<string, string | number | boolean | undefined | null>;

const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const MAX_RETRY_DELAY_MS = 120_000;

export function withTrailingSlash(url: string): string {
  const trimmed = url.trim();
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

/**
 * Small fetch wrapper shared by the TestRail and TestOps clients:
 * base URL handling, optional insecure TLS, retries with Retry-After, readable errors.
 */
export class HttpClient {
  readonly baseUrl: string;
  readonly rateLimiter: RateLimiter | undefined;
  private readonly onRetry: ((info: RetryInfo) => void) | undefined;
  private readonly headers: Record<string, string>;
  private readonly dispatcher: Dispatcher | undefined;
  private readonly retries: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: HttpClientOptions) {
    this.baseUrl = withTrailingSlash(options.baseUrl);
    this.headers = options.headers ?? {};
    this.dispatcher = options.insecureTls ? new Agent({ connect: { rejectUnauthorized: false } }) : undefined;
    this.retries = options.retries ?? 5;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.rateLimiter = options.rateLimiter;
    this.onRetry = options.onRetry;
  }

  /** `path` is appended to the base URL as is, so TestRail style `index.php?/api/v2/...` paths work. */
  url(path: string, query?: Query): string {
    let url = this.baseUrl + path.replace(/^\//, "");
    if (query) {
      const params = Object.entries(query)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
        .join("&");
      if (params) {
        url += (url.includes("?") ? "&" : "?") + params;
      }
    }
    return url;
  }

  async json<T>(method: string, path: string, options: { query?: Query; body?: unknown } = {}): Promise<T> {
    const init: RequestInit = { method, headers: { Accept: "application/json" } };
    if (options.body !== undefined) {
      init.headers = { ...init.headers, "Content-Type": "application/json" } as Record<string, string>;
      init.body = JSON.stringify(options.body);
    }
    const response = await this.send(this.url(path, options.query), init);
    const text = await response.text();
    if (!text) {
      return undefined as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HttpError(`Expected JSON from ${describe(response.url)} but got something else`, response.status, response.url, text.slice(0, 500));
    }
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.json<T>("GET", path, { query });
  }

  async bytes(path: string, extraHeaders: Record<string, string> = {}): Promise<{ data: Buffer; contentType: string | null }> {
    const response = await this.send(this.url(path), { method: "GET", headers: extraHeaders });
    const data = Buffer.from(await response.arrayBuffer());
    return { data, contentType: response.headers.get("content-type") };
  }

  async upload<T>(path: string, query: Query, files: { field: string; name: string; data: Buffer; contentType: string }[]): Promise<T> {
    // FormData cannot be replayed after a failed attempt, so build a fresh one for each try.
    const response = await this.send(this.url(path, query), () => {
      const form = new FormData();
      for (const file of files) {
        form.append(file.field, new Blob([new Uint8Array(file.data)], { type: file.contentType }), file.name);
      }
      return { method: "POST", body: form, headers: { Accept: "application/json" } };
    });
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private async send(url: string, init: RequestInit | (() => RequestInit)): Promise<Response> {
    let attempt = 0;
    for (;;) {
      const base = typeof init === "function" ? init() : init;
      const request: RequestInit = {
        ...base,
        headers: { ...this.headers, ...(base.headers as Record<string, string> | undefined) },
        dispatcher: this.dispatcher,
        signal: AbortSignal.timeout(this.timeoutMs),
      };
      let response: Response;
      try {
        const received = await this.rateLimiter?.acquire();
        try {
          response = await fetch(url, request);
        } finally {
          received?.();
        }
      } catch (error) {
        if (attempt < this.retries) {
          const delay = backoff(attempt);
          this.onRetry?.({ url: describe(url), attempt: attempt + 1, of: this.retries, reason: networkReason(error), delayMs: delay });
          await this.sleep(delay);
          attempt += 1;
          continue;
        }
        throw new HttpError(`Cannot reach ${describe(url)}: ${networkReason(error)}`, 0, url, "");
      }
      if (response.ok) {
        return response;
      }
      if (RETRY_STATUSES.has(response.status) && attempt < this.retries) {
        await response.body?.cancel();
        const delay = retryAfter(response) ?? backoff(attempt);
        if (response.status === 429) {
          // The server counts requests for everyone using this limiter: hold them all.
          this.rateLimiter?.pauseFor(delay);
        }
        this.onRetry?.({
          url: describe(url),
          attempt: attempt + 1,
          of: this.retries,
          reason: response.status === 429 ? "rate limited (429)" : `server answered ${response.status}`,
          delayMs: delay,
        });
        await this.sleep(delay);
        attempt += 1;
        continue;
      }
      const body = await response.text().catch(() => "");
      throw new HttpError(`${base.method ?? "GET"} ${describe(url)} failed with ${response.status}${errorDetail(body)}`, response.status, url, body.slice(0, 2000));
    }
  }
}

function backoff(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000);
}

function retryAfter(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) {
    return null;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
  }
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_DELAY_MS);
}

/** URL without query string credentials, for messages. */
function describe(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}${parsed.search.startsWith("?/") ? parsed.search.split("&")[0] : ""}`;
  } catch {
    return url;
  }
}

function errorDetail(body: string): string {
  if (!body) {
    return "";
  }
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const message = parsed.error ?? parsed.message ?? parsed.errorMessage;
    return typeof message === "string" && message ? `: ${message}` : "";
  } catch {
    return "";
  }
}

function networkReason(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: { code?: string; message?: string } }).cause;
    if (cause?.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || cause?.code === "SELF_SIGNED_CERT_IN_CHAIN" || cause?.code === "DEPTH_ZERO_SELF_SIGNED_CERT") {
      return "the TLS certificate is not trusted (enable 'Skip TLS verification' if this is expected)";
    }
    if (error.name === "TimeoutError") {
      return "the request timed out";
    }
    return cause?.message ?? cause?.code ?? error.message;
  }
  return String(error);
}
