import { QASE_RATE_LIMITS, type QaseConnection } from "@atm/shared";
import { HttpClient, type Query, type RetryInfo } from "../http/httpClient.js";
import { sharedRateLimiter, type RateLimiter } from "../http/rateLimiter.js";
import type { QaseAuthor, QaseCase, QaseCustomField, QaseMilestone, QasePage, QaseProject, QaseSharedStep, QaseSuite, QaseSystemField, QaseUser } from "./types.js";

/**
 * Qase limits API requests per workspace: a number per minute by plan and, at the same time, a
 * sixth of it in any 10 seconds. Pacing by the 10 second window with a margin keeps both, and a
 * steady pace instead of bursts followed by long waits.
 */
export const QASE_WINDOW_MS = 10_000;
export function qaseRequestsPerWindow(connection: Pick<QaseConnection, "rateLimit">): number {
  return Math.max(1, Math.floor((QASE_RATE_LIMITS[connection.rateLimit] / 6) * 0.8));
}

/** Largest page Qase returns. */
export const QASE_PAGE = 100;

interface Envelope<T> {
  status: boolean;
  result: T;
  errorMessage?: string;
}

/** `https://api.qase.io`, `https://api.qase.io/` and `https://api.qase.io/v1` all mean the same API. */
function apiBase(endpoint: string): string {
  const trimmed = (endpoint.trim() || "https://api.qase.io").replace(/\/+$/, "");
  return /\/v\d+$/.test(trimmed) ? `${trimmed}/` : `${trimmed}/v1/`;
}

/** Qase REST API v1 with an API token. */
export class QaseClient {
  readonly http: HttpClient;
  readonly rateLimiter: RateLimiter;
  /** Files are served from other hosts than the API: they never get the token. */
  private readonly files: HttpClient;

  constructor(connection: QaseConnection, onRetry?: (info: RetryInfo) => void, pageSize = QASE_PAGE) {
    // One limiter for everything this tool sends to that Qase: the limit is counted for the whole workspace.
    this.rateLimiter = sharedRateLimiter(apiBase(connection.endpoint), qaseRequestsPerWindow(connection), QASE_WINDOW_MS);
    const common = { insecureTls: connection.insecureTls, ...(onRetry ? { onRetry } : {}) };
    this.http = new HttpClient({ baseUrl: apiBase(connection.endpoint), headers: { Token: connection.apiToken }, rateLimiter: this.rateLimiter, ...common });
    this.files = new HttpClient({ baseUrl: apiBase(connection.endpoint), retries: 2, ...common });
    this.pageSize = pageSize;
  }

  private readonly pageSize: number;

  get endpoint(): string {
    return this.http.baseUrl;
  }

  async get<T>(path: string, query?: Query): Promise<T> {
    const answer = await this.http.get<Envelope<T>>(path, query);
    return answer.result;
  }

  async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    const answer = await this.http.json<Envelope<T>>(method, path, { body });
    return answer?.result;
  }

  /** All entities of a paged list. */
  async *pages<T>(path: string, query: Query = {}): AsyncGenerator<T[]> {
    for (let offset = 0; ; ) {
      const page = await this.get<QasePage<T>>(path, { ...query, limit: this.pageSize, offset });
      const entities = page?.entities ?? [];
      if (entities.length > 0) {
        yield entities;
      }
      offset += entities.length;
      if (entities.length === 0 || offset >= (page.filtered ?? page.total ?? 0)) {
        return;
      }
    }
  }

  async all<T>(path: string, query: Query = {}): Promise<T[]> {
    const result: T[] = [];
    for await (const page of this.pages<T>(path, query)) {
      result.push(...page);
    }
    return result;
  }

  projects(): Promise<QaseProject[]> {
    return this.all<QaseProject>("project");
  }

  project(code: string): Promise<QaseProject> {
    return this.get<QaseProject>(`project/${encodeURIComponent(code)}`);
  }

  suites(code: string): Promise<QaseSuite[]> {
    return this.all<QaseSuite>(`suite/${encodeURIComponent(code)}`);
  }

  cases(code: string): AsyncGenerator<QaseCase[]> {
    return this.pages<QaseCase>(`case/${encodeURIComponent(code)}`, { include: "external_issues" });
  }

  testCase(code: string, id: number): Promise<QaseCase> {
    return this.get<QaseCase>(`case/${encodeURIComponent(code)}/${id}`, { include: "external_issues" });
  }

  /** Number of cases of the project, without reading them. */
  async caseCount(code: string): Promise<number> {
    const page = await this.get<QasePage<QaseCase>>(`case/${encodeURIComponent(code)}`, { limit: 1, offset: 0 });
    return page?.total ?? 0;
  }

  sharedSteps(code: string): Promise<QaseSharedStep[]> {
    return this.all<QaseSharedStep>(`shared_step/${encodeURIComponent(code)}`);
  }

  milestones(code: string): Promise<QaseMilestone[]> {
    return this.all<QaseMilestone>(`milestone/${encodeURIComponent(code)}`);
  }

  customFields(): Promise<QaseCustomField[]> {
    return this.all<QaseCustomField>("custom_field", { entity: "case" });
  }

  systemFields(): Promise<QaseSystemField[]> {
    return this.get<QaseSystemField[]>("system_field");
  }

  authors(): Promise<QaseAuthor[]> {
    return this.all<QaseAuthor>("author");
  }

  users(): Promise<QaseUser[]> {
    return this.all<QaseUser>("user");
  }

  /** A file by the address Qase gave for it. The token is only sent to the API itself. */
  download(url: string): Promise<{ data: Buffer; contentType: string | null; fileName: string | null }> {
    const sameOrigin = (() => {
      try {
        return new URL(url).origin === new URL(this.http.baseUrl).origin;
      } catch {
        return false;
      }
    })();
    return (sameOrigin ? this.http : this.files).bytes(url);
  }
}
