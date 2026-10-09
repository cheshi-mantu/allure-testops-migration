import type { XrayConnection } from "@atm/shared";
import { HttpClient, HttpError, type RetryInfo } from "../http/httpClient.js";
import type { JiraField, JiraIssue, JiraProject, JiraSearchPage, JiraUser, XrayResults, XrayTest } from "./types.js";

/** Xray answers GraphQL errors with status 200 and an `errors` list. */
export class XrayQueryError extends HttpError {
  constructor(message: string, url: string) {
    super(`Xray did not accept the query: ${message}`, 400, url, JSON.stringify({ message }));
    this.name = "XrayQueryError";
  }
}

/** Nested lists read per test; more are reported, not read. */
export const NESTED_LIMIT = 10;

const TEST_FIELDS = `
  issueId
  projectId
  testType { name kind }
  steps {
    id action data result callTestIssueId
    attachments { id filename storedInJira downloadLink }
    customFields { id name value }
  }
  unstructured
  gherkin
  scenarioType
  folder { name path }
  preconditions(limit: ${NESTED_LIMIT}) { total results { issueId definition preconditionType { name kind } jira(fields: ["key", "summary"]) } }
  testSets(limit: ${NESTED_LIMIT}) { total results { issueId jira(fields: ["key", "summary"]) } }
  testPlans(limit: ${NESTED_LIMIT}) { total results { issueId jira(fields: ["key", "summary"]) } }
  jira(fields: ["key", "summary"])
  lastModified`;

/** Tests per GraphQL request. Xray allows 100, nested lists make big pages heavy. */
const TESTS_PER_QUERY = 25;

/**
 * Xray Cloud API: authentication with the API key, GraphQL for test details, attachment downloads.
 * Tests are always requested by issue id: a JQL query in Xray fails when it matches more than 100 tests.
 */
export class XrayClient {
  readonly http: HttpClient;
  private token: Promise<string> | null = null;

  constructor(
    private readonly connection: XrayConnection,
    onRetry?: (info: RetryInfo) => void,
  ) {
    this.http = new HttpClient({ baseUrl: connection.endpoint || "https://xray.cloud.getxray.app", onRetry });
  }

  get endpoint(): string {
    return this.http.baseUrl;
  }

  /** Exchanges the API key for a token (valid about a day). */
  async authenticate(force = false): Promise<string> {
    if (!this.token || force) {
      this.token = this.http
        .json<string>("POST", "api/v2/authenticate", { body: { client_id: this.connection.clientId, client_secret: this.connection.clientSecret } })
        .then((token) => {
          if (typeof token !== "string" || !token) {
            throw new Error("Xray did not return a token.");
          }
          this.http.setHeader("Authorization", `Bearer ${token}`);
          return token;
        });
      this.token.catch(() => (this.token = null));
    }
    return this.token;
  }

  private async withToken<T>(call: () => Promise<T>): Promise<T> {
    await this.authenticate();
    try {
      return await call();
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        await this.authenticate(true);
        return call();
      }
      throw error;
    }
  }

  async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const answer = await this.withToken(() =>
      this.http.json<{ data?: T; errors?: { message: string }[] }>("POST", "api/v2/graphql", { body: { query, variables } }),
    );
    if (answer?.errors?.length) {
      throw new XrayQueryError(answer.errors.map((e) => e.message).join("; "), this.http.url("api/v2/graphql"));
    }
    return answer!.data as T;
  }

  /** Xray details of the given tests; ids that are not Xray tests are left out. */
  async tests(issueIds: string[]): Promise<XrayTest[]> {
    const result: XrayTest[] = [];
    for (let i = 0; i < issueIds.length; i += TESTS_PER_QUERY) {
      const ids = issueIds.slice(i, i + TESTS_PER_QUERY);
      const data = await this.query<{ getTests: XrayResults<XrayTest> }>(
        `query Tests($issueIds: [String], $limit: Int!) { getTests(issueIds: $issueIds, limit: $limit) { total results { ${TEST_FIELDS} } } }`,
        { issueIds: ids, limit: ids.length },
      );
      result.push(...(data.getTests?.results ?? []));
    }
    return result;
  }

  /** How many tests the project has and the Jira issue type they use ("Test" unless renamed). */
  async projectTests(projectId: string): Promise<{ total: number; issueType: string | null }> {
    const data = await this.query<{ getTests: XrayResults<{ issueId: string; jira?: { issuetype?: { name?: string } } | null }> }>(
      `query ProjectTests($projectId: String, $limit: Int!) { getTests(projectId: $projectId, limit: $limit) { total results { issueId jira(fields: ["issuetype"]) } } }`,
      { projectId, limit: 1 },
    );
    const first = data.getTests?.results?.[0];
    return { total: data.getTests?.total ?? 0, issueType: first?.jira?.issuetype?.name ?? null };
  }

  async download(link: string): Promise<{ data: Buffer; contentType: string | null; fileName: string | null }> {
    return this.withToken(() => this.http.bytes(link));
  }
}

/** Jira Cloud REST v3 with an Atlassian API token. */
export class JiraClient {
  readonly http: HttpClient;

  constructor(connection: XrayConnection, onRetry?: (info: RetryInfo) => void) {
    const basic = Buffer.from(`${connection.jiraEmail}:${connection.jiraApiToken}`).toString("base64");
    this.http = new HttpClient({ baseUrl: connection.jiraUrl, headers: { Authorization: `Basic ${basic}` }, onRetry });
  }

  get endpoint(): string {
    return this.http.baseUrl;
  }

  issueUrl(key: string): string {
    return `${this.http.baseUrl}browse/${key}`;
  }

  myself(): Promise<JiraUser> {
    return this.http.get<JiraUser>("rest/api/3/myself");
  }

  async projects(): Promise<JiraProject[]> {
    const projects: JiraProject[] = [];
    for (let startAt = 0; ; ) {
      const page = await this.http.get<{ values: JiraProject[]; isLast?: boolean; total?: number }>("rest/api/3/project/search", { startAt, maxResults: 100 });
      projects.push(...(page.values ?? []));
      if (page.isLast !== false || (page.values ?? []).length === 0) {
        return projects;
      }
      startAt += page.values.length;
    }
  }

  fields(): Promise<JiraField[]> {
    return this.http.get<JiraField[]>("rest/api/3/field");
  }

  /** Issues matching the JQL with all fields and rendered rich text, page by page. */
  async *search(jql: string, options: { pageSize?: number; limit?: number; fields?: string[] } = {}): AsyncGenerator<JiraIssue[]> {
    let nextPageToken: string | null = null;
    const seen = new Set<string>();
    let count = 0;
    for (;;) {
      const pageSize = Math.min(options.pageSize ?? 100, options.limit !== undefined ? options.limit - count : Infinity);
      if (pageSize <= 0) {
        return;
      }
      const page: JiraSearchPage = await this.http.json<JiraSearchPage>("POST", "rest/api/3/search/jql", {
        body: { jql, maxResults: pageSize, fields: options.fields ?? ["*all"], expand: "renderedFields", nextPageToken },
      });
      const issues = (page.issues ?? []).filter((issue) => !seen.has(issue.id));
      issues.forEach((issue) => seen.add(issue.id));
      count += issues.length;
      if (issues.length > 0) {
        yield issues;
      }
      // Guard against a token that keeps pointing at pages already read.
      if (page.isLast || !page.nextPageToken || page.nextPageToken === nextPageToken || issues.length === 0) {
        return;
      }
      nextPageToken = page.nextPageToken;
    }
  }

  download(url: string): Promise<{ data: Buffer; contentType: string | null; fileName: string | null }> {
    return this.http.bytes(url);
  }
}

const quote = (value: string) => `"${value.replace(/"/g, '\\"')}"`;

/** JQL for the tests of a scope, in key order so runs read in a stable order. */
export function scopeJql(projectKey: string, issueType: string, filter: string, issueKeys: string[] = []): string {
  const parts = [`project = ${quote(projectKey)}`, `issuetype = ${quote(issueType)}`];
  if (issueKeys.length > 0) {
    parts.push(`key in (${issueKeys.map(quote).join(", ")})`);
  }
  if (filter.trim()) {
    parts.push(`(${filter.trim()})`);
  }
  return `${parts.join(" AND ")} ORDER BY key ASC`;
}
