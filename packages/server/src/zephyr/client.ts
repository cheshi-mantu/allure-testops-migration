import type { ZephyrConnection } from "@atm/shared";
import { HttpClient, HttpError, type Query, type RetryInfo } from "../http/httpClient.js";
import { sharedRateLimiter } from "../http/rateLimiter.js";
import { shapeOf } from "./diagnostics.js";
import type { ZephyrAttachment, ZephyrFolder, ZephyrOption, ZephyrPage, ZephyrProject, ZephyrTestCase, ZephyrTestScript, ZephyrTestStep } from "./types.js";

/** Items per page asked for; Zephyr may give fewer and says so in `maxResults`. */
export const ZEPHYR_PAGE = 100;

/** Receives the lines of the detailed log: requests, answers and what was read, never credentials or text. */
export type ZephyrTrace = (message: string) => void;

export interface ZephyrClientOptions {
  onRetry?: (info: RetryInfo) => void;
  trace?: ZephyrTrace;
  pageSize?: number;
}

/** `https://api.zephyrscale.smartbear.com`, with or without `/v2` and a trailing slash, means the same API. */
export function zephyrBase(endpoint: string): string {
  const trimmed = (endpoint.trim() || "https://api.zephyrscale.smartbear.com/v2").replace(/\/+$/, "");
  return `${/\/v2$/.test(trimmed) ? trimmed : `${trimmed}/v2`}/`;
}

/** What went wrong, from the answer of Zephyr: its status and the start of its message. */
export function failureText(error: unknown): string {
  if (error instanceof HttpError) {
    const body = error.body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
    return `${error.status === 0 ? "no answer" : `status ${error.status}`}${error.notApi ? " (a web page instead of API data)" : ""}${body ? `: ${body}` : ""}`;
  }
  return error instanceof Error ? error.message : String(error);
}

const notFound = (error: unknown) => error instanceof HttpError && error.status === 404;

/**
 * Zephyr Cloud REST API v2 (Zephyr, formerly Zephyr Scale, and Zephyr Essential) with an API access
 * token. Zephyr does not publish its rate limits: requests are paced and a 429 makes every request
 * to the same address wait as long as Zephyr asks.
 */
export class ZephyrClient {
  readonly http: HttpClient;
  private readonly trace: ZephyrTrace;
  private readonly pageSize: number;
  /** Kinds of answers whose shape was already written to the detailed log. */
  private readonly described = new Set<string>();

  constructor(connection: Pick<ZephyrConnection, "endpoint" | "apiToken" | "requestsPerMinute">, options: ZephyrClientOptions = {}) {
    const baseUrl = zephyrBase(connection.endpoint);
    this.http = new HttpClient({
      baseUrl,
      headers: { Authorization: `Bearer ${connection.apiToken.trim()}`, Accept: "application/json" },
      rateLimiter: sharedRateLimiter(baseUrl, connection.requestsPerMinute),
      retries: 8,
      ...(options.onRetry ? { onRetry: options.onRetry } : {}),
    });
    this.trace = options.trace ?? (() => undefined);
    this.pageSize = options.pageSize ?? ZEPHYR_PAGE;
  }

  get endpoint(): string {
    return this.http.baseUrl;
  }

  /** Runs a request and writes it to the detailed log with its result and time. */
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

  /** The shape of the first answer of each kind: field names and kinds of values, no text. */
  private shapeOnce(kind: string, value: unknown): string {
    if (this.described.has(kind) || value === undefined) {
      return "";
    }
    this.described.add(kind);
    return `first ${kind} ${shapeOf(value)}`;
  }

  private get<T>(path: string, query?: Query): Promise<T> {
    return this.http.get<T>(path, query);
  }

  /** Every item of an offset paged list. */
  async *pages<T>(path: string, query: Query, kind: string): AsyncGenerator<T[]> {
    for (let startAt = 0; ; ) {
      const label = `GET ${path}?${Object.entries({ ...query, startAt, maxResults: this.pageSize }).map(([k, v]) => `${k}=${String(v)}`).join("&")}`;
      const page = await this.traced(label, () => this.get<ZephyrPage<T>>(path, { ...query, startAt, maxResults: this.pageSize }), (p) =>
        [`${p.values?.length ?? 0} item(s)`, p.total !== undefined ? `total ${p.total}` : "", p.isLast !== undefined ? `isLast ${p.isLast}` : "", p.maxResults !== undefined && p.maxResults !== this.pageSize ? `maxResults lowered to ${p.maxResults}` : "", this.shapeOnce(kind, p.values?.[0])]
          .filter(Boolean)
          .join(", "),
      );
      const values = page.values ?? [];
      if (values.length > 0) {
        yield values;
      }
      startAt += Math.max(values.length, 1);
      if (values.length === 0 || page.isLast === true || (page.isLast === undefined && page.total !== undefined && startAt >= page.total)) {
        return;
      }
    }
  }

  private async all<T>(path: string, query: Query, kind: string): Promise<T[]> {
    const result: T[] = [];
    for await (const page of this.pages<T>(path, query, kind)) {
      result.push(...page);
    }
    return result;
  }

  healthcheck(): Promise<unknown> {
    return this.traced("GET healthcheck", () => this.get<unknown>("healthcheck"));
  }

  projects(): Promise<ZephyrProject[]> {
    return this.all<ZephyrProject>("projects", {}, "project");
  }

  project(key: string): Promise<ZephyrProject> {
    return this.traced(`GET projects/${key}`, () => this.get<ZephyrProject>(`projects/${encodeURIComponent(key)}`), (p) => `enabled ${p.enabled ?? "?"}`);
  }

  folders(projectKey: string): Promise<ZephyrFolder[]> {
    return this.all<ZephyrFolder>("folders", { projectKey, folderType: "TEST_CASE" }, "folder");
  }

  statuses(projectKey: string): Promise<ZephyrOption[]> {
    return this.all<ZephyrOption>("statuses", { projectKey, statusType: "TEST_CASE" }, "status");
  }

  priorities(projectKey: string): Promise<ZephyrOption[]> {
    return this.all<ZephyrOption>("priorities", { projectKey }, "priority");
  }

  /** How many test cases the project has. */
  async testCount(projectKey: string): Promise<number> {
    const page = await this.traced(`GET testcases?projectKey=${projectKey}&maxResults=1`, () => this.get<ZephyrPage<ZephyrTestCase>>("testcases", { projectKey, maxResults: 1, startAt: 0 }), (p) => `total ${p.total ?? "not given"}`);
    return page.total ?? page.values?.length ?? 0;
  }

  /** Test cases of a project or of one folder, page by page. */
  testCases(projectKey: string, folderId: number | null = null): AsyncGenerator<ZephyrTestCase[]> {
    return this.pages<ZephyrTestCase>("testcases", { projectKey, ...(folderId ? { folderId } : {}) }, "test case");
  }

  /** One test case by key; null when there is none. */
  async testCase(key: string): Promise<ZephyrTestCase | null> {
    try {
      return await this.traced(`GET testcases/${key}`, () => this.get<ZephyrTestCase>(`testcases/${encodeURIComponent(key)}`), (testCase) => this.shapeOnce("test case", testCase));
    } catch (error) {
      if (notFound(error)) {
        return null;
      }
      throw error;
    }
  }

  testSteps(key: string): Promise<ZephyrTestStep[]> {
    return this.all<ZephyrTestStep>(`testcases/${encodeURIComponent(key)}/teststeps`, {}, "test step");
  }

  /** The plain text or BDD script of a test case; null when it has none. */
  async testScript(key: string): Promise<ZephyrTestScript | null> {
    try {
      return await this.traced(`GET testcases/${key}/testscript`, () => this.get<ZephyrTestScript>(`testcases/${encodeURIComponent(key)}/testscript`), (script) => `type ${JSON.stringify(script?.type)}, text ${script?.text?.length ?? 0} chars`);
    } catch (error) {
      if (notFound(error)) {
        return null;
      }
      throw error;
    }
  }

  /** Zephyr answers 404 when there are no files. */
  private async fileList(path: string, label: string): Promise<ZephyrAttachment[]> {
    try {
      const answer = await this.traced(`GET ${label}`, () => this.get<{ attachments?: ZephyrAttachment[] } | ZephyrAttachment[] | ZephyrPage<ZephyrAttachment>>(path), (a) => {
        const list = filesOf(a);
        return [`${list.length} file(s)`, list.length > 0 ? this.shapeOnce("file", list[0]) : ""].filter(Boolean).join(", ");
      });
      return filesOf(answer);
    } catch (error) {
      if (notFound(error)) {
        return [];
      }
      throw error;
    }
  }

  attachments(key: string): Promise<ZephyrAttachment[]> {
    return this.fileList(`testcases/${encodeURIComponent(key)}/attachments`, `testcases/${key}/attachments`);
  }

  stepAttachments(key: string, stepId: string): Promise<ZephyrAttachment[]> {
    return this.fileList(`testcases/${encodeURIComponent(key)}/teststeps/${stepId}/attachments`, `testcases/${key}/teststeps/${stepId}/attachments`);
  }

  /** Bytes of a file of a test case, or of one of its steps. */
  download(key: string, stepId: string | null, attachmentId: string): Promise<{ data: Buffer; contentType: string | null; fileName: string | null }> {
    const path = `testcases/${encodeURIComponent(key)}${stepId ? `/teststeps/${stepId}` : ""}/attachments/${encodeURIComponent(attachmentId)}`;
    return this.traced(`GET ${path}`, () => this.http.bytes(path, { Accept: "*/*" }), (file) => `${file.data.length} bytes, ${file.contentType ?? "no content type"}`);
  }

  /** A file at an address Zephyr gave, e.g. an image in rich text; sent with the token only to the Zephyr API host. */
  fetchUrl(url: string): Promise<{ data: Buffer; contentType: string | null; fileName: string | null }> {
    return this.traced(`GET ${new URL(url).pathname}`, () => this.http.bytes(url, { Accept: "*/*" }), (file) => `${file.data.length} bytes, ${file.contentType ?? "no content type"}`);
  }
}

function filesOf(answer: unknown): ZephyrAttachment[] {
  if (Array.isArray(answer)) {
    return answer as ZephyrAttachment[];
  }
  if (answer && typeof answer === "object") {
    const object = answer as { attachments?: unknown; values?: unknown };
    if (Array.isArray(object.attachments)) {
      return object.attachments as ZephyrAttachment[];
    }
    if (Array.isArray(object.values)) {
      return object.values as ZephyrAttachment[];
    }
  }
  return [];
}
