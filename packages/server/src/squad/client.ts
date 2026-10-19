import { createHash, createHmac } from "node:crypto";
import { SQUAD_ENDPOINT, type SquadConnection } from "@atm/shared";
import { HttpClient, HttpError, type Query, type RetryInfo } from "../http/httpClient.js";
import { sharedRateLimiter } from "../http/rateLimiter.js";
import { failureText } from "../zephyr/client.js";
import { shapeOf } from "../zephyr/diagnostics.js";
import type { SquadAttachment, SquadStep } from "./types.js";

/** Receives the lines of the detailed log: requests, answers and what was read, never keys or text. */
export type SquadTrace = (message: string) => void;

export interface ZapiClientOptions {
  onRetry?: (info: RetryInfo) => void;
  trace?: SquadTrace;
}

/** Seconds a signed request stays valid. */
const TOKEN_LIFETIME = 3600;

/** Percent-encoding of the Atlassian query string hash: RFC 3986, spaces as %20, `~` kept. */
function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * The canonical request of a URL, as the Atlassian query string hash (qsh) defines it: the method,
 * the path below the API address, and the query sorted by name with the values of a name sorted and
 * joined by commas.
 */
export function canonicalRequest(method: string, url: string, base: string): string {
  const parsed = new URL(url);
  const basePath = new URL(base).pathname.replace(/\/+$/, "");
  let path = parsed.pathname.startsWith(basePath) ? parsed.pathname.slice(basePath.length) : parsed.pathname;
  path = path.replace(/&/g, "%26");
  if (path === "") {
    path = "/";
  } else if (path.length > 1) {
    path = path.replace(/\/+$/, "");
  }
  const values = new Map<string, string[]>();
  for (const [name, value] of parsed.searchParams) {
    if (name !== "jwt") {
      values.set(name, [...(values.get(name) ?? []), value]);
    }
  }
  const query = [...values.entries()]
    .map(([name, list]) => [encode(name), list.map(encode).sort().join(",")] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, list]) => `${name}=${list}`)
    .join("&");
  return `${method.toUpperCase()}&${path}&${query}`;
}

const base64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");

/**
 * A JWT for one Zephyr Squad request: HS256 signed with the secret key, issued by the access key
 * for the Jira account, bound to the method, path and query through the query string hash.
 */
export function zapiToken(method: string, url: string, base: string, keys: { accessKey: string; secretKey: string; accountId: string }, now = Date.now()): string {
  const issued = Math.floor(now / 1000);
  const claims = {
    sub: keys.accountId,
    qsh: createHash("sha256").update(canonicalRequest(method, url, base)).digest("hex"),
    iss: keys.accessKey,
    iat: issued,
    exp: issued + TOKEN_LIFETIME,
  };
  const unsigned = `${base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${base64url(JSON.stringify(claims))}`;
  return `${unsigned}.${base64url(createHmac("sha256", keys.secretKey).update(unsigned).digest())}`;
}

/** Steps arrive as a list, or inside an object, depending on the version of the API. */
function stepsOf(answer: unknown): { steps: SquadStep[]; total: number | null } {
  if (Array.isArray(answer)) {
    return { steps: answer as SquadStep[], total: null };
  }
  if (answer && typeof answer === "object") {
    const object = answer as Record<string, unknown>;
    for (const key of ["testSteps", "stepBeanCollection", "values", "steps"]) {
      if (Array.isArray(object[key])) {
        const total = typeof object.totalCount === "number" ? object.totalCount : typeof object.total === "number" ? object.total : null;
        return { steps: object[key] as SquadStep[], total };
      }
    }
  }
  return { steps: [], total: null };
}

const notFound = (error: unknown) => error instanceof HttpError && error.status === 404;

/**
 * Zephyr Squad API (ZAPI) of the old Zephyr Squad: every request carries the access key and a JWT
 * signed for that request. Zephyr Squad limits requests per user without publishing the number:
 * requests are paced and a 429 makes every request to the same address wait as long as it asks.
 */
export class ZapiClient {
  readonly http: HttpClient;
  private readonly trace: SquadTrace;
  private readonly base: string;
  private accountId = "";
  private readonly described = new Set<string>();

  constructor(
    private readonly connection: Pick<SquadConnection, "endpoint" | "accessKey" | "secretKey" | "requestsPerMinute">,
    options: ZapiClientOptions = {},
  ) {
    this.base = (connection.endpoint.trim() || SQUAD_ENDPOINT).replace(/\/+$/, "");
    this.http = new HttpClient({
      baseUrl: this.base,
      headers: { zapiAccessKey: connection.accessKey.trim(), Accept: "application/json" },
      rateLimiter: sharedRateLimiter(this.base, connection.requestsPerMinute),
      retries: 8,
      ...(options.onRetry ? { onRetry: options.onRetry } : {}),
    });
    this.trace = options.trace ?? (() => undefined);
  }

  get endpoint(): string {
    return this.http.baseUrl;
  }

  /** The Jira account the API keys belong to; requests are signed for it. */
  signFor(accountId: string): void {
    this.accountId = accountId;
  }

  private authorization(method: string, url: string): Record<string, string> {
    if (!this.accountId) {
      throw new Error("The Jira account to sign Zephyr Squad requests for is not known yet.");
    }
    const token = zapiToken(method, url, this.base, { accessKey: this.connection.accessKey.trim(), secretKey: this.connection.secretKey.trim(), accountId: this.accountId });
    return { Authorization: `JWT ${token}` };
  }

  private shapeOnce(kind: string, value: unknown): string {
    if (this.described.has(kind) || value === undefined) {
      return "";
    }
    this.described.add(kind);
    return `first ${kind} ${shapeOf(value)}`;
  }

  private async traced<T>(label: string, request: () => Promise<T>, describe?: (result: T) => string): Promise<T> {
    const started = Date.now();
    try {
      const result = await request();
      const extra = describe ? describe(result) : "";
      this.trace(`${label}: ok in ${Date.now() - started} ms${extra ? `, ${extra}` : ""}.`);
      return result;
    } catch (error) {
      this.trace(`${label}: failed in ${Date.now() - started} ms, ${failureText(error)}.`);
      throw error;
    }
  }

  private get<T>(path: string, query: Query = {}): Promise<T> {
    return this.http.json<T>("GET", path, { query, headers: this.authorization("GET", this.http.url(path, query)) });
  }

  serverInfo(): Promise<unknown> {
    return this.traced("GET public/rest/api/1.0/serverinfo", () => this.get<unknown>("public/rest/api/1.0/serverinfo"), (info) => shapeOf(info));
  }

  /** Steps of a test, in their order. */
  async steps(issueId: string, projectId: string): Promise<SquadStep[]> {
    const path = `public/rest/api/2.0/teststep/${issueId}`;
    const result: SquadStep[] = [];
    for (let offset = 0; ; ) {
      const query: Query = offset > 0 ? { projectId, offsetOpt: offset } : { projectId };
      const answer = await this.traced(`GET ${path}?${offset > 0 ? `offsetOpt=${offset}&` : ""}projectId=${projectId}`, () => this.get<unknown>(path, query), (a) => {
        const { steps, total } = stepsOf(a);
        return [Array.isArray(a) ? "a list" : `keys ${Object.keys((a as object | null) ?? {}).join("/")}`, `${steps.length} step(s)`, total !== null ? `total ${total}` : "", this.shapeOnce("step", steps[0])].filter(Boolean).join(", ");
      });
      const { steps, total } = stepsOf(answer);
      result.push(...steps);
      offset += steps.length;
      if (steps.length === 0 || total === null || offset >= total) {
        return result.sort((a, b) => (a.orderId ?? 0) - (b.orderId ?? 0));
      }
    }
  }

  /** Files of one step; for step lists that do not name them. */
  async stepAttachments(issueId: string, projectId: string, stepId: string): Promise<SquadAttachment[]> {
    const path = "public/rest/api/1.0/attachment/search/teststep";
    try {
      const answer = await this.traced(`GET ${path}?entityId=${stepId}`, () => this.get<unknown>(path, { entityId: stepId, projectId, issueId }), (a) => {
        const list = Array.isArray(a) ? a : [];
        return [`${list.length} file(s)`, this.shapeOnce("step file", list[0])].filter(Boolean).join(", ");
      });
      return Array.isArray(answer) ? (answer as SquadAttachment[]) : [];
    } catch (error) {
      if (notFound(error)) {
        return [];
      }
      throw error;
    }
  }

  /** Bytes of a file of a step. */
  download(attachmentId: string, issueId: string, projectId: string): Promise<{ data: Buffer; contentType: string | null; fileName: string | null }> {
    const path = `public/rest/api/1.0/attachment/${encodeURIComponent(attachmentId)}`;
    const query = { projectId, issueId };
    const url = this.http.url(path, query);
    return this.traced(`GET public/rest/api/1.0/attachment/${attachmentId}`, () => this.http.bytes(url, { Accept: "*/*", ...this.authorization("GET", url) }), (file) => `${file.data.length} bytes, ${file.contentType ?? "no content type"}`);
  }
}
