import type { Profile, SourceDiscovery } from "@atm/shared";
import { KnownProblem } from "../engine/problems.js";
import type { RetryInfo } from "../http/httpClient.js";
import { JiraCatalog } from "../jira/catalog.js";
import { JiraClient, scopeJql } from "../jira/client.js";
import type { JiraField, JiraIssue, JiraProject } from "../jira/types.js";
import { shapeOf } from "../zephyr/diagnostics.js";
import { SquadAssets } from "./assets.js";
import { SquadCatalog } from "./catalog.js";
import { ZapiClient, type SquadTrace } from "./client.js";
import type { SquadContext } from "./transform.js";
import type { SquadCase } from "./types.js";

const SAMPLE_SIZE = 300;
const JIRA_PAGE = 100;
/** Tests whose steps are read at the same time. */
const PARALLEL = 4;

export interface SquadProjectContext extends SquadContext {
  zapi: ZapiClient;
  jira: JiraClient;
  assets: SquadAssets;
  /** The detailed log; does nothing when it is off. */
  trace: SquadTrace;
  project: JiraProject;
  issueType: string;
  /** About how many tests the project has; null when Jira does not say. */
  totalTests: number | null;
  fields: JiraField[];
  warnings: string[];
}

function requireSettings(profile: Profile): void {
  const connection = profile.squad.connection;
  if (!connection.accessKey.trim() || !connection.secretKey.trim() || !connection.jiraUrl.trim() || !connection.jiraEmail.trim() || !connection.jiraApiToken.trim()) {
    throw new KnownProblem({
      key: "squad-connection-incomplete",
      title: "The Zephyr Squad and Jira connection is incomplete.",
      hint: "Enter the Jira site, email and API token, and the access key and secret key of the Zephyr Squad API keys, on the Connections step.",
      fix: { step: "connections" },
    });
  }
  if (!profile.squad.scope.projectKey.trim()) {
    throw new KnownProblem({
      key: "no-squad-project",
      title: "No Jira project is chosen.",
      hint: "Choose the Jira project whose Zephyr Squad tests should be migrated.",
      fix: { step: "scope" },
    });
  }
}

async function inParallel<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
      while (next < items.length) {
        await work(items[next++]!);
      }
    }),
  );
}

/** Clients, project and the field catalog; used by discovery, preview and runs. */
export async function loadSquadContext(profile: Profile, onRetry?: (info: RetryInfo) => void, trace?: SquadTrace): Promise<SquadProjectContext> {
  requireSettings(profile);
  const log: SquadTrace = profile.squad.detailedLog && trace ? trace : () => undefined;
  const connection = profile.squad.connection;
  const jira = new JiraClient(connection, onRetry);
  const zapi = new ZapiClient(connection, { ...(onRetry ? { onRetry } : {}), trace: log });
  const key = profile.squad.scope.projectKey.trim();
  const issueType = profile.squad.scope.issueType.trim() || "Test";
  const warnings: string[] = [];
  const [me, project, fields] = await Promise.all([jira.myself(), jira.http.get<JiraProject>(`rest/api/3/project/${encodeURIComponent(key)}`), jira.fields()]);
  // Requests to Zephyr Squad are signed for the Jira account the API keys belong to.
  zapi.signFor(me.accountId);
  const totalTests = await jira.count(scopeJql(project.key, issueType, ""));
  log(`Jira project ${project.key} (id ${project.id}): about ${totalTests ?? "?"} issue(s) of type "${issueType}", ${fields.length} Jira field(s), ${fields.filter((field) => field.schema?.custom?.startsWith("com.thed.zephyr")).map((field) => `"${field.name}"`).join(", ") || "no"} Zephyr field(s).`);
  if (totalTests === 0) {
    warnings.push(`Project ${project.key} has no issues of type "${issueType}". If Zephyr Squad uses another issue type for tests here, enter it on the Projects step.`);
  }
  const catalog = new SquadCatalog(fields);
  const context: SquadProjectContext = {
    profile,
    catalog,
    jiraBase: jira.endpoint,
    zapi,
    jira,
    assets: new SquadAssets(zapi, jira, project.id),
    trace: log,
    project,
    issueType,
    totalTests,
    fields,
    warnings,
  };
  return context;
}

/** Steps of these Jira issues, and the files of steps when the step list does not name them. */
export async function withSteps(context: SquadProjectContext, issues: JiraIssue[]): Promise<SquadCase[]> {
  const cases: SquadCase[] = issues.map((issue) => ({ issue, steps: [], stepAttachments: new Map() }));
  const stepFiles = context.profile.squad.scope.stepFiles;
  await inParallel(cases, async (testCase) => {
    testCase.steps = await context.zapi.steps(testCase.issue.id, context.project.id);
    for (const step of testCase.steps) {
      if (Array.isArray(step.attachments)) {
        testCase.stepAttachments.set(step.id, step.attachments);
      } else if (stepFiles) {
        testCase.stepAttachments.set(step.id, await context.zapi.stepAttachments(testCase.issue.id, context.project.id, step.id));
      }
    }
  });
  context.trace(
    `Read ${cases.length} test(s) (${cases[0]?.issue.key}..${cases[cases.length - 1]?.issue.key}): ${cases.reduce((sum, c) => sum + c.steps.length, 0)} step(s), ` +
      `${cases.reduce((sum, c) => sum + [...c.stepAttachments.values()].flat().length, 0)} step file(s), ${cases.reduce((sum, c) => sum + ((c.issue.fields.attachment as unknown[] | undefined)?.length ?? 0), 0)} issue file(s).`,
  );
  context.assets.register(cases);
  return cases;
}

/** Tests of the scope, page by page. */
export async function* readSquadCases(context: SquadProjectContext, profile: Profile, limit?: number): AsyncGenerator<SquadCase[]> {
  const scope = profile.squad.scope;
  const keys = scope.issueKeys.map((key) => key.trim().toUpperCase()).filter(Boolean);
  const jql = scopeJql(context.project.key, context.issueType, scope.jql, keys);
  let first = true;
  for await (const issues of context.jira.search(jql, { pageSize: JIRA_PAGE, ...(limit !== undefined ? { limit } : {}) })) {
    if (first) {
      context.trace(`Jira search ${jql}: first issue ${shapeOf({ fields: Object.fromEntries(Object.entries(issues[0]?.fields ?? {}).filter(([, value]) => value !== null)) })}.`);
      first = false;
    }
    yield await withSteps(context, issues);
  }
}

/** One test by issue key, for the preview. */
export async function readSquadCase(context: SquadProjectContext, key: string): Promise<SquadCase | null> {
  for await (const issues of context.jira.search(`key = "${key.replace(/"/g, "")}"`, { pageSize: 1, limit: 1 })) {
    return (await withSteps(context, issues))[0] ?? null;
  }
  return null;
}

/** Everything the mapping screens show about the Zephyr Squad side, from a sample of tests. */
export async function discoverSquad(profile: Profile): Promise<SourceDiscovery> {
  const first = await loadSquadContext(profile);
  const sample: SquadCase[] = [];
  for await (const page of readSquadCases(first, profile, SAMPLE_SIZE)) {
    sample.push(...page);
  }
  // The catalog lists the issue link directions found in the sample.
  const catalog = new SquadCatalog(first.fields, JiraCatalog.linkDirections(sample));
  const warnings = [...first.warnings];
  if (first.totalTests !== null && first.totalTests > sample.length && sample.length > 0) {
    warnings.push(`Examples and counts come from ${sample.length} of about ${first.totalTests} tests.`);
  }
  if (sample.length === 0 && (first.totalTests ?? 0) > 0) {
    warnings.push("No test matches the JQL filter or the issue keys on the Projects step.");
  }
  if (sample.length > 0 && sample.every((testCase) => testCase.steps.length === 0)) {
    warnings.push("Zephyr Squad gave no steps for the sampled tests. If the tests have steps in Jira, the project may have moved to the new Zephyr Essential: then use the Zephyr source.");
  }
  const projectId = Number(first.project.id) || 0;
  return {
    source: "squad",
    project: { id: projectId, name: `${first.project.name} (${first.project.key})`, suiteMode: 1 },
    suites: [],
    structure: [],
    maxDepth: 0,
    levels: [],
    fields: catalog.toInfo(sample),
    sampledCases: sample.length,
    sampleCaseIds: sample.slice(0, 50).map((c) => ({ id: c.issue.key, name: String(c.issue.fields.summary ?? "") })),
    warnings,
  };
}
