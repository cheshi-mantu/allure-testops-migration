import type { XrayConnection } from "@atm/shared";
import { HttpClient, HttpError, type RetryInfo } from "../http/httpClient.js";
import type { JiraField, JiraIssue, JiraProject, JiraSearchPage, JiraUser } from "./types.js";

/** What a Jira client needs: the site and an Atlassian account with its API token. */
export type JiraConnection = Pick<XrayConnection, "jiraUrl" | "jiraEmail" | "jiraApiToken">;

/** Jira Cloud REST v3 with an Atlassian API token. */
export class JiraClient {
  readonly http: HttpClient;

  constructor(connection: JiraConnection, onRetry?: (info: RetryInfo) => void) {
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

  /** Components of a project. */
  components(projectKey: string): Promise<{ id: string; name: string }[]> {
    return this.http.get<{ id: string; name: string }[]>(`rest/api/3/project/${encodeURIComponent(projectKey)}/components`);
  }

  /** Users by account id; email only where the privacy settings of the user show it. */
  async users(accountIds: string[]): Promise<JiraUser[]> {
    const result: JiraUser[] = [];
    for (let i = 0; i < accountIds.length; i += 50) {
      const ids = accountIds.slice(i, i + 50);
      const query = [...ids.map((id) => `accountId=${encodeURIComponent(id)}`), `maxResults=${ids.length}`].join("&");
      const page = await this.http.get<{ values?: JiraUser[] }>(`rest/api/3/user/bulk?${query}`);
      result.push(...(page.values ?? []));
    }
    return result;
  }

  /** Keys and summaries of issues by id; issues the user cannot see are left out. */
  async issueKeys(ids: (string | number)[]): Promise<{ id: string; key: string; summary: string }[]> {
    const result: { id: string; key: string; summary: string }[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      try {
        for await (const issues of this.search(`id in (${chunk.join(", ")})`, { pageSize: 100, fields: ["summary"] })) {
          result.push(...issues.map((issue) => ({ id: issue.id, key: issue.key, summary: String(issue.fields.summary ?? "") })));
        }
      } catch (error) {
        // JQL fails as a whole when one of the issues is gone or hidden: ask for them one by one.
        if (!(error instanceof HttpError) || error.status !== 400) {
          throw error;
        }
        for (const id of chunk) {
          try {
            const issue = await this.http.get<{ id: string; key: string; fields?: { summary?: string } }>(`rest/api/3/issue/${id}`, { fields: "summary" });
            result.push({ id: issue.id, key: issue.key, summary: issue.fields?.summary ?? "" });
          } catch (inner) {
            if (!(inner instanceof HttpError) || ![403, 404].includes(inner.status)) {
              throw inner;
            }
          }
        }
      }
    }
    return result;
  }

  /** About how many issues match the JQL; Jira counts quickly and not always exactly. */
  async count(jql: string): Promise<number | null> {
    try {
      return (await this.http.json<{ count?: number }>("POST", "rest/api/3/search/approximate-count", { body: { jql } })).count ?? null;
    } catch (error) {
      if (error instanceof HttpError && error.status !== 401 && error.status !== 0) {
        return null;
      }
      throw error;
    }
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
