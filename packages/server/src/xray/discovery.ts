import type { Profile, SectionLevelInfo, SourceDiscovery } from "@atm/shared";
import { KnownProblem } from "../engine/problems.js";
import type { RetryInfo } from "../http/httpClient.js";
import { folderLevels, XrayCatalog } from "./catalog.js";
import { JiraClient, scopeJql, XrayClient } from "./client.js";
import type { JiraField, JiraIssue, JiraProject, XrayCase, XrayStep } from "./types.js";

const SAMPLE_SIZE = 300;
const EXAMPLE_PATHS = 5;
const JIRA_PAGE = 100;

export interface XrayProjectContext {
  xray: XrayClient;
  jira: JiraClient;
  project: JiraProject;
  /** Jira issue type of Xray tests in the project, usually "Test". */
  issueType: string;
  totalTests: number;
  fields: JiraField[];
  catalog: XrayCatalog;
  warnings: string[];
}

function requireSettings(profile: Profile): void {
  const connection = profile.xray.connection;
  if (!connection.clientId || !connection.clientSecret || !connection.jiraUrl || !connection.jiraEmail || !connection.jiraApiToken) {
    throw new KnownProblem({
      key: "xray-connection-incomplete",
      title: "The Xray and Jira connection is incomplete.",
      hint: "Enter the Xray API key (client id and secret) and the Jira site, email and API token on the Connections step.",
      fix: { step: "connections" },
    });
  }
  if (!profile.xray.scope.projectKey.trim()) {
    throw new KnownProblem({
      key: "no-xray-project",
      title: "No Jira project is chosen.",
      hint: "Choose the Jira project whose Xray tests should be migrated.",
      fix: { step: "scope" },
    });
  }
}

/** Clients, project, test issue type and the field catalog; used by discovery, preview and runs. */
export async function loadXrayContext(profile: Profile, onRetry?: (info: RetryInfo) => void): Promise<XrayProjectContext> {
  requireSettings(profile);
  const xray = new XrayClient(profile.xray.connection, onRetry);
  const jira = new JiraClient(profile.xray.connection, onRetry);
  const warnings: string[] = [];
  const key = profile.xray.scope.projectKey.trim();
  const project = await jira.http.get<JiraProject>(`rest/api/3/project/${encodeURIComponent(key)}`);
  const [tests, fields] = await Promise.all([xray.projectTests(project.id), jira.fields()]);
  if (tests.total === 0) {
    warnings.push(`Xray has no tests in project ${project.key}.`);
  }
  return {
    xray,
    jira,
    project,
    issueType: tests.issueType ?? "Test",
    totalTests: tests.total,
    fields,
    catalog: new XrayCatalog(fields),
    warnings,
  };
}

/** Joins Jira issues with their Xray details; issues that are not Xray tests are dropped. */
async function withXray(xray: XrayClient, issues: JiraIssue[]): Promise<XrayCase[]> {
  const tests = new Map((await xray.tests(issues.map((issue) => issue.id))).map((test) => [test.issueId, test]));
  return issues.filter((issue) => tests.has(issue.id)).map((issue) => ({ issue, test: tests.get(issue.id)! }));
}

/** Tests of the scope, page by page. */
export async function* readXrayCases(context: XrayProjectContext, profile: Profile, limit?: number): AsyncGenerator<XrayCase[]> {
  const scope = profile.xray.scope;
  const keys = scope.issueKeys.map((key) => key.trim().toUpperCase()).filter(Boolean);
  const jql = scopeJql(context.project.key, context.issueType, scope.jql, keys);
  for await (const issues of context.jira.search(jql, { pageSize: JIRA_PAGE, limit })) {
    yield await withXray(context.xray, issues);
  }
}

/** One test by issue key, for the preview. */
export async function readXrayCase(context: XrayProjectContext, key: string): Promise<XrayCase | null> {
  for await (const issues of context.jira.search(`key = "${key.replace(/"/g, "")}"`, { pageSize: 1, limit: 1 })) {
    return (await withXray(context.xray, issues))[0] ?? null;
  }
  return null;
}

/** Tests called by steps of these tests (and by the called tests), by Xray issue id. */
export async function readCalledTests(context: XrayProjectContext, cases: XrayCase[], known = new Map<string, XrayCase>()): Promise<Map<string, XrayCase>> {
  const byId = new Map(cases.map((c) => [c.issue.id, c]));
  const called = known;
  const wanted = (steps: XrayStep[] | null | undefined) =>
    (steps ?? []).map((s) => s.callTestIssueId).filter((id): id is string => Boolean(id) && !called.has(id!));
  let pending = [...new Set(cases.flatMap((c) => wanted(c.test.steps)))];
  for (let round = 0; pending.length > 0 && round < 5; round++) {
    const missing = pending.filter((id) => !byId.has(id));
    pending.filter((id) => byId.has(id)).forEach((id) => called.set(id, byId.get(id)!));
    const loaded: XrayCase[] = [];
    for (let i = 0; i < missing.length; i += JIRA_PAGE) {
      const ids = missing.slice(i, i + JIRA_PAGE);
      for await (const issues of context.jira.search(`id in (${ids.join(", ")})`, { pageSize: JIRA_PAGE })) {
        loaded.push(...(await withXray(context.xray, issues)));
      }
    }
    loaded.forEach((c) => called.set(c.issue.id, c));
    pending = [...new Set(loaded.flatMap((c) => wanted(c.test.steps)))];
  }
  return called;
}

function levelStats(paths: string[][]): SectionLevelInfo[] {
  const depth = paths.reduce((max, path) => Math.max(max, path.length), 0);
  return Array.from({ length: depth }, (_, index) => {
    const names = new Set(paths.filter((p) => p.length > index).map((p) => p.slice(0, index + 1).join("/")));
    return {
      level: index + 1,
      sectionCount: names.size,
      caseCount: paths.filter((p) => p.length === index + 1).length,
      examples: [...new Set(paths.filter((p) => p.length > index).map((p) => p[index]!))].slice(0, 5),
    };
  });
}

/** Everything the mapping screens show about the Xray side, from a sample of tests. */
export async function discoverXray(profile: Profile): Promise<SourceDiscovery> {
  const first = await loadXrayContext(profile);
  const sample: XrayCase[] = [];
  for await (const page of readXrayCases(first, profile, SAMPLE_SIZE)) {
    sample.push(...page);
  }
  // The catalog lists the issue link directions found in the sample.
  const context = { ...first, catalog: new XrayCatalog(first.fields, XrayCatalog.linkDirections(sample)) };
  const paths = sample.map((c) => folderLevels(c.test.folder?.path));
  const distinctPaths = [...new Map(paths.filter((p) => p.length > 0).map((p) => [p.join("/"), p])).values()].sort((a, b) => b.length - a.length);
  const levels = levelStats(paths);
  const maxDepth = levels.length;
  const warnings = [...context.warnings];
  if (context.totalTests > sample.length && sample.length > 0) {
    warnings.push(`Examples and counts come from ${sample.length} of ${context.totalTests} tests.`);
  }
  if (sample.length === 0 && context.totalTests > 0) {
    warnings.push("No test matches the JQL filter on the Projects step.");
  }
  const projectId = Number(context.project.id) || 0;
  return {
    source: "xray",
    project: { id: projectId, name: `${context.project.name} (${context.project.key})`, suiteMode: 1 },
    suites: [],
    structure: [
      {
        suite: { id: projectId, name: "Test repository" },
        sectionCount: new Set(paths.flatMap((p) => p.map((_, i) => p.slice(0, i + 1).join("/")))).size,
        maxDepth,
        levels,
        examplePaths: distinctPaths.slice(0, EXAMPLE_PATHS),
      },
    ],
    maxDepth,
    levels,
    fields: context.catalog.toInfo(sample),
    sampledCases: sample.length,
    sampleCaseIds: sample.slice(0, 50).map((c) => ({ id: c.issue.key, name: String(c.issue.fields.summary ?? "") })),
    warnings,
  };
}
