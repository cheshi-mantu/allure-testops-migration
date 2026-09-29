import type { TestRailConnection } from "@atm/shared";
import { HttpClient, HttpError, type Query } from "../http/httpClient.js";
import type {
  TrAttachment,
  TrCase,
  TrCaseField,
  TrCaseStatus,
  TrCaseType,
  TrMilestone,
  TrPriority,
  TrProject,
  TrSection,
  TrSharedStep,
  TrSuite,
  TrTemplate,
  TrUser,
} from "./types.js";

const PAGE_SIZE = 250;

/**
 * TestRail API v2 client. Handles both paginated responses (TestRail 6.7+) and
 * the older plain array responses, so users do not need to know their TestRail version.
 */
export class TestRailClient {
  private readonly http: HttpClient;

  constructor(
    private readonly connection: TestRailConnection,
    http?: HttpClient,
  ) {
    this.http =
      http ??
      new HttpClient({
        baseUrl: connection.endpoint,
        insecureTls: connection.insecureTls,
        headers: {
          Authorization: `Basic ${Buffer.from(`${connection.username}:${connection.apiKey}`).toString("base64")}`,
        },
      });
  }

  get endpoint(): string {
    return this.http.baseUrl;
  }

  caseUrl(caseId: number): string {
    return `${this.http.baseUrl}index.php?/cases/view/${caseId}`;
  }

  private api<T>(method: string, query?: Query): Promise<T> {
    return this.http.get<T>(`index.php?/api/v2/${method}`, query);
  }

  /** Reads every page of a list endpoint. `key` is the property holding items in paginated responses. */
  async list<T>(method: string, key: string, query: Query = {}): Promise<T[]> {
    const items: T[] = [];
    let offset = 0;
    for (;;) {
      const response = await this.api<unknown>(method, { ...query, limit: PAGE_SIZE, offset });
      if (Array.isArray(response)) {
        // Old TestRail: the whole list at once, pagination parameters are ignored.
        return response as T[];
      }
      const page = (response as Record<string, unknown> | null)?.[key];
      if (!Array.isArray(page)) {
        return items;
      }
      const before = items.length;
      for (const item of page as T[]) {
        items.push(item);
      }
      const next = (response as { _links?: { next?: string | null } })._links?.next;
      // Some TestRail versions return the same page for every offset; stop when nothing new arrives.
      if (!next || page.length === 0 || items.length === before) {
        return items;
      }
      offset += page.length;
    }
  }

  getProjects(): Promise<TrProject[]> {
    return this.list<TrProject>("get_projects", "projects");
  }

  getProject(projectId: number): Promise<TrProject> {
    return this.api<TrProject>(`get_project/${projectId}`);
  }

  getSuites(projectId: number): Promise<TrSuite[]> {
    return this.list<TrSuite>(`get_suites/${projectId}`, "suites");
  }

  getSuite(suiteId: number): Promise<TrSuite> {
    return this.api<TrSuite>(`get_suite/${suiteId}`);
  }

  getSections(projectId: number, suiteId: number): Promise<TrSection[]> {
    return this.list<TrSection>(`get_sections/${projectId}`, "sections", { suite_id: suiteId });
  }

  async getCases(projectId: number, suiteId: number, includeDeleted = false): Promise<TrCase[]> {
    const cases = await this.list<TrCase>(`get_cases/${projectId}`, "cases", { suite_id: suiteId });
    if (!includeDeleted) {
      return cases;
    }
    const deleted = await this.list<TrCase>(`get_cases/${projectId}`, "cases", { suite_id: suiteId, is_deleted: 1 }).catch(() => []);
    const seen = new Set(cases.map((c) => c.id));
    return [...cases, ...deleted.filter((c) => !seen.has(c.id))];
  }

  /** First page of cases only, for sampling. */
  async getCasesSample(projectId: number, suiteId: number, limit: number): Promise<TrCase[]> {
    const response = await this.api<unknown>(`get_cases/${projectId}`, { suite_id: suiteId, limit, offset: 0 });
    if (Array.isArray(response)) {
      return (response as TrCase[]).slice(0, limit);
    }
    const cases = (response as { cases?: TrCase[] } | null)?.cases;
    return Array.isArray(cases) ? cases : [];
  }

  getCase(caseId: number): Promise<TrCase> {
    return this.api<TrCase>(`get_case/${caseId}`);
  }

  getCaseFields(): Promise<TrCaseField[]> {
    return this.api<TrCaseField[]>("get_case_fields");
  }

  getPriorities(): Promise<TrPriority[]> {
    return this.api<TrPriority[]>("get_priorities");
  }

  getCaseTypes(): Promise<TrCaseType[]> {
    return this.api<TrCaseType[]>("get_case_types");
  }

  /** Only available on TestRail Enterprise 7.3+, empty elsewhere. */
  async getCaseStatuses(): Promise<TrCaseStatus[]> {
    try {
      return await this.api<TrCaseStatus[]>("get_case_statuses");
    } catch {
      return [];
    }
  }

  getTemplates(projectId: number): Promise<TrTemplate[]> {
    return this.api<TrTemplate[]>(`get_templates/${projectId}`);
  }

  /** Users of the project. Falls back to all users; non-admin tokens may only see project users. */
  async getUsers(projectId: number): Promise<TrUser[]> {
    try {
      return await this.list<TrUser>(`get_users/${projectId}`, "users");
    } catch (error) {
      if (error instanceof HttpError && error.status >= 400 && error.status < 500) {
        return this.list<TrUser>("get_users", "users");
      }
      throw error;
    }
  }

  async getMilestones(projectId: number): Promise<TrMilestone[]> {
    const top = await this.list<TrMilestone>(`get_milestones/${projectId}`, "milestones");
    return top.flatMap((milestone) => [milestone, ...(milestone.milestones ?? [])]);
  }

  getSharedStep(sharedStepId: number): Promise<TrSharedStep> {
    return this.api<TrSharedStep>(`get_shared_step/${sharedStepId}`);
  }

  getCaseAttachments(caseId: number): Promise<TrAttachment[]> {
    return this.list<TrAttachment>(`get_attachments_for_case/${caseId}`, "attachments");
  }

  /** Attachment content through the API. */
  async getAttachment(attachmentId: string): Promise<{ data: Buffer; contentType: string | null }> {
    return this.http.bytes(`index.php?/api/v2/get_attachment/${encodeURIComponent(attachmentId)}`);
  }

  /** Attachment content the way the browser loads inline images; needs a session cookie. */
  async getAttachmentAsBrowser(attachmentId: string): Promise<{ data: Buffer; contentType: string | null }> {
    const cookie = this.connection.sessionCookie.trim();
    return this.http.bytes(`index.php?/attachments/get/${encodeURIComponent(attachmentId)}`, {
      Cookie: cookie.includes("=") ? cookie : `tr_session=${cookie}`,
    });
  }

  get hasSessionCookie(): boolean {
    return this.connection.sessionCookie.trim() !== "";
  }
}
