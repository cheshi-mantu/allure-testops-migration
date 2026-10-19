import type { Profile, SourceDiscovery } from "@atm/shared";
import { levelsOf } from "../csv/discovery.js";
import { KnownProblem } from "../engine/problems.js";
import { HttpError, type RetryInfo } from "../http/httpClient.js";
import { JiraClient } from "../jira/client.js";
import { ZephyrAssets } from "./assets.js";
import { ZephyrCatalog, type ZephyrDictionaries } from "./catalog.js";
import { failureText, ZephyrClient, type ZephyrTrace } from "./client.js";
import { isAccountId } from "./diagnostics.js";
import { zephyrSteps, type ZephyrContext } from "./transform.js";
import type { ZephyrCase, ZephyrFolder, ZephyrOption, ZephyrProject, ZephyrTestCase, ZephyrTestStep } from "./types.js";

const SAMPLE_SIZE = 300;
const EXAMPLE_PATHS = 5;
/** Test cases read at the same time; each needs a few requests. */
const PARALLEL = 4;

export interface ZephyrProjectContext extends ZephyrContext {
  client: ZephyrClient;
  jira: JiraClient;
  /** The detailed log; does nothing when it is off. */
  trace: ZephyrTrace;
  project: ZephyrProject;
  /** Name of the Jira project, for messages. */
  projectName: string;
  folders: ZephyrFolder[];
  totalTests: number;
  warnings: string[];
}

function requireSettings(profile: Profile): void {
  const connection = profile.zephyr.connection;
  if (!connection.apiToken.trim() || !connection.jiraUrl.trim() || !connection.jiraEmail.trim() || !connection.jiraApiToken.trim()) {
    throw new KnownProblem({
      key: "zephyr-connection-incomplete",
      title: "The Zephyr and Jira connection is incomplete.",
      hint: "Enter the Zephyr API access token and the Jira site, email and API token on the Connections step.",
      fix: { step: "connections" },
    });
  }
  if (!profile.zephyr.scope.projectKey.trim()) {
    throw new KnownProblem({
      key: "no-zephyr-project",
      title: "No Jira project is chosen.",
      hint: "Choose the Jira project whose Zephyr test cases should be migrated.",
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

/** Folder paths, outermost first, by folder id. */
export function folderPaths(folders: ZephyrFolder[]): Map<number, string[]> {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const result = new Map<number, string[]>();
  for (const folder of folders) {
    const path: string[] = [];
    const seen = new Set<number>();
    for (let current: ZephyrFolder | undefined = folder; current && !seen.has(current.id); current = current.parentId ? byId.get(current.parentId) : undefined) {
      seen.add(current.id);
      path.unshift(current.name);
    }
    result.set(folder.id, path);
  }
  return result;
}

/** Account ids in the owner and in custom fields: Jira gives their names. */
function accountIds(testCase: ZephyrTestCase): string[] {
  const values = Object.values(testCase.customFields ?? {}).flatMap((value) => (Array.isArray(value) ? value : [value]));
  return [testCase.owner?.accountId ?? "", ...values.filter((value): value is string => typeof value === "string" && isAccountId(value))].filter(Boolean);
}

/** Names of users and keys of issues the test cases refer to, read from Jira once. */
async function resolveJira(context: Pick<ZephyrProjectContext, "jira" | "catalog" | "warnings" | "trace">, cases: ZephyrCase[]): Promise<void> {
  const { users, issues } = context.catalog.dictionaries;
  const wantedUsers = [...new Set(cases.flatMap((item) => accountIds(item.testCase)))].filter((id) => !users.has(id));
  const wantedIssues = [...new Set(cases.flatMap((item) => (item.testCase.links?.issues ?? []).map((link) => link.issueId)))].filter((id) => !issues.has(id));
  if (wantedUsers.length > 0) {
    try {
      const found = await context.jira.users(wantedUsers);
      found.forEach((user) => users.set(user.accountId, { accountId: user.accountId, displayName: user.displayName ?? user.accountId, email: user.emailAddress || null }));
      context.trace(`Jira users: ${wantedUsers.length} asked, ${found.length} found, ${found.filter((user) => user.emailAddress).length} with a visible email.`);
    } catch (error) {
      context.trace(`Jira users could not be read: ${failureText(error)}.`);
      if (!context.warnings.some((warning) => warning.includes("Jira users"))) {
        context.warnings.push("Jira did not give the users of the test cases, so owners and user fields show account ids. The Jira user needs the global permission \"Browse users and groups\".");
      }
    }
    // Ask once: users Jira does not know keep their account id.
    wantedUsers.filter((id) => !users.has(id)).forEach((id) => users.set(id, { accountId: id, displayName: id, email: null }));
  }
  if (wantedIssues.length > 0) {
    try {
      const found = await context.jira.issueKeys(wantedIssues);
      found.forEach((issue) => issues.set(Number(issue.id), { key: issue.key, summary: issue.summary }));
      context.trace(`Jira issues linked to test cases: ${wantedIssues.length} asked, ${found.length} found.`);
    } catch (error) {
      if (!(error instanceof HttpError) || error.status === 401 || error.status === 0) {
        throw error;
      }
      context.trace(`Jira issues could not be read: ${failureText(error)}.`);
      if (!context.warnings.some((warning) => warning.includes("linked Jira issues"))) {
        context.warnings.push("Jira did not give the keys of the linked Jira issues, so they are not linked. Check that the Jira user can browse the projects of those issues.");
      }
    }
  }
}

/** Steps or script, files and step files of these test cases. */
export async function withDetails(context: ZephyrProjectContext, testCases: ZephyrTestCase[]): Promise<ZephyrCase[]> {
  const { client } = context;
  const stepFiles = context.profile.zephyr.scope.stepFiles;
  const result: ZephyrCase[] = testCases.map((testCase) => ({ testCase, steps: [], script: null, attachments: [], stepAttachments: new Map() }));
  await inParallel(result, async (item) => {
    const key = item.testCase.key;
    const kind = item.testCase.testScript?.self?.split("/").pop() ?? null;
    if (kind === "testscript") {
      item.script = await client.testScript(key);
    } else if (kind === "teststeps" || kind === null) {
      try {
        item.steps = await client.testSteps(key);
      } catch (error) {
        // 422: the test case has a plain text or BDD script instead of steps.
        if (!(error instanceof HttpError) || ![404, 422].includes(error.status)) {
          throw error;
        }
        item.script = error.status === 422 ? await client.testScript(key) : null;
      }
    }
    item.attachments = await client.attachments(key);
    if (stepFiles) {
      for (const step of item.steps) {
        if (step.inline && step.id !== null && step.id !== undefined) {
          item.stepAttachments.set(String(step.id), await client.stepAttachments(key, String(step.id)));
        }
      }
    }
  });
  await resolveJira(context, result);
  context.trace(
    `Read ${result.length} test case(s) (${result[0]?.testCase.key}..${result[result.length - 1]?.testCase.key}): ` +
      `${result.reduce((sum, item) => sum + item.steps.length, 0)} step(s), ${result.filter((item) => item.script).length} script(s), ` +
      `${result.reduce((sum, item) => sum + item.attachments.length, 0)} file(s), ${result.reduce((sum, item) => sum + [...item.stepAttachments.values()].flat().length, 0)} step file(s).`,
  );
  return result;
}

/** Test cases called by steps of these test cases, and those they call, a few levels deep. */
export async function readCalledTests(context: ZephyrProjectContext, cases: ZephyrCase[]): Promise<void> {
  const known = new Map(cases.map((item) => [item.testCase.key, item]));
  const wanted = (items: ZephyrCase[]) => [...new Set(items.flatMap((item) => item.steps.map((step: ZephyrTestStep) => step.testCase?.testCaseKey ?? "").filter((key) => key && !context.called.has(key))))];
  let pending = wanted(cases);
  for (let round = 0; pending.length > 0 && round < 5; round++) {
    pending.filter((key) => known.has(key)).forEach((key) => context.called.set(key, known.get(key)!));
    const missing = pending.filter((key) => !known.has(key));
    const found: ZephyrTestCase[] = [];
    for (const key of missing) {
      const testCase = await context.client.testCase(key);
      if (testCase) {
        found.push(testCase);
      }
    }
    const loaded = found.length > 0 ? await withDetails(context, found) : [];
    loaded.forEach((item) => context.called.set(item.testCase.key, item));
    const unread = missing.filter((key) => !loaded.some((item) => item.testCase.key === key));
    context.trace(`Called test cases, round ${round + 1}: ${pending.length} called, ${missing.length} read from Zephyr${unread.length > 0 ? `, not found: ${unread.join(", ")}` : ""}.`);
    pending = wanted(loaded);
  }
}

/** Clients, project, folders, statuses, priorities and the field catalog; used by discovery, preview and runs. */
export async function loadZephyrContext(profile: Profile, onRetry?: (info: RetryInfo) => void, trace?: ZephyrTrace): Promise<ZephyrProjectContext> {
  requireSettings(profile);
  const log: ZephyrTrace = profile.zephyr.detailedLog && trace ? trace : () => undefined;
  const connection = profile.zephyr.connection;
  const client = new ZephyrClient(connection, { ...(onRetry ? { onRetry } : {}), trace: log });
  const jira = new JiraClient(connection, onRetry);
  const key = profile.zephyr.scope.projectKey.trim();
  const warnings: string[] = [];
  /** Lists that only add names: the migration goes on without them. */
  const optional = async <T>(what: string, read: () => Promise<T[]>): Promise<T[]> => {
    try {
      return await read();
    } catch (error) {
      if (error instanceof HttpError && error.status !== 401 && error.status !== 0) {
        log(`Going on without ${what}: ${failureText(error)}.`);
        warnings.push(`Could not read ${what}, so they are shown by their ids.`);
        return [];
      }
      throw error;
    }
  };
  let project: ZephyrProject;
  try {
    project = await client.project(key);
  } catch (error) {
    if (error instanceof HttpError && [400, 404].includes(error.status)) {
      throw new KnownProblem({
        key: "zephyr-project-not-found",
        title: `Zephyr has no project ${key}.`,
        hint: "Check the project key, and that Zephyr is turned on for the project (Jira project settings, Apps, Zephyr). If the project key was changed, Zephyr may still know the project by the old key. Projects of the old Zephyr Squad are not available through this API.",
        fix: { step: "scope" },
      });
    }
    throw error;
  }
  const [jiraProject, folders, statuses, priorities, components, totalTests, firstPage] = await Promise.all([
    jira.http.get<{ id: string; key: string; name: string }>(`rest/api/3/project/${encodeURIComponent(key)}`).catch((error: unknown) => {
      log(`Jira project ${key} could not be read: ${failureText(error)}.`);
      return null;
    }),
    client.folders(key),
    optional<ZephyrOption>("the statuses", () => client.statuses(key)),
    optional<ZephyrOption>("the priorities", () => client.priorities(key)),
    optional("the Jira components", () => jira.components(key)),
    client.testCount(key),
    (async () => {
      for await (const page of client.testCases(key)) {
        return page;
      }
      return [] as ZephyrTestCase[];
    })(),
  ]);
  if (totalTests === 0) {
    warnings.push(`Zephyr has no test cases in project ${key}.`);
  }
  const dictionaries: ZephyrDictionaries = {
    statuses: new Map(statuses.map((status) => [status.id, status])),
    priorities: new Map(priorities.map((priority) => [priority.id, priority])),
    components: new Map(components.map((component) => [Number(component.id), component.name])),
    users: new Map(),
    issues: new Map(),
    folderPaths: folderPaths(folders),
  };
  // Zephyr gives no definitions of custom fields: their kinds come from the first test cases.
  const sample: ZephyrCase[] = firstPage.map((testCase) => ({ testCase, steps: [], script: null, attachments: [], stepAttachments: new Map() }));
  const catalog = new ZephyrCatalog(dictionaries, sample);
  log(
    `Project ${key} (Zephyr id ${project.id}, Jira id ${project.jiraProjectId ?? "?"}, enabled ${project.enabled ?? "?"}): ${totalTests} test case(s), ${folders.length} folder(s), ` +
      `statuses ${statuses.map((status) => `${status.id} "${status.name}"${status.archived ? " archived" : ""}`).join(", ") || "none"}, ` +
      `priorities ${priorities.map((priority) => `${priority.id} "${priority.name}"`).join(", ") || "none"}, ${components.length} component(s).`,
  );
  log(`Fields offered for mapping: ${catalog.fields.map((field) => `${field.systemName} (${field.kind})`).join(", ")}.`);
  const called = new Map<string, ZephyrCase>();
  const assets = new ZephyrAssets(client, called);
  const context: ZephyrProjectContext = {
    profile,
    catalog,
    assets,
    jiraBase: jira.endpoint,
    called,
    client,
    jira,
    trace: log,
    project,
    projectName: jiraProject?.name ?? key,
    folders,
    totalTests,
    warnings,
  };
  assets.convertSteps = (item) => zephyrSteps(item, context, false);
  return context;
}

/** Ids of the chosen folders and of every folder inside them; null when no folder is chosen. */
function chosenFolders(profile: Profile, folders: ZephyrFolder[]): Set<number> | null {
  const chosen = profile.zephyr.scope.folderIds;
  if (chosen.length === 0) {
    return null;
  }
  const result = new Set(chosen);
  for (let grew = true; grew; ) {
    grew = false;
    for (const folder of folders) {
      if (folder.parentId && result.has(folder.parentId) && !result.has(folder.id)) {
        result.add(folder.id);
        grew = true;
      }
    }
  }
  return result;
}

/** "CALC-T12" in upper case; null for anything else. */
export function parseTestCaseKey(raw: string): string | null {
  const key = raw.trim().toUpperCase();
  return /^[A-Z][A-Z0-9_]*-T\d+$/.test(key) ? key : null;
}

/** Test cases of the scope with their details, page by page. */
export async function* readZephyrCases(context: ZephyrProjectContext, profile: Profile, limit = Infinity): AsyncGenerator<ZephyrCase[]> {
  const key = context.project.key;
  const keys = profile.zephyr.scope.testCaseKeys.map(parseTestCaseKey).filter((value): value is string => value !== null);
  if (keys.length > 0) {
    // A trial run on a few test cases: read just them.
    const found: ZephyrTestCase[] = [];
    for (const caseKey of keys.slice(0, limit)) {
      const testCase = await context.client.testCase(caseKey);
      if (testCase) {
        found.push(testCase);
      }
    }
    if (found.length > 0) {
      yield await withDetails(context, found);
    }
    return;
  }
  const folders = chosenFolders(profile, context.folders);
  const seen = new Set<string>();
  let count = 0;
  for (const folderId of folders ? [...folders] : [null]) {
    for await (const page of context.client.testCases(key, folderId)) {
      // A folder may also list the test cases of the folders inside it: each is read once.
      const wanted = page.filter((testCase) => !seen.has(testCase.key) && (folderId === null || testCase.folder?.id === folderId)).slice(0, limit - count);
      wanted.forEach((testCase) => seen.add(testCase.key));
      count += wanted.length;
      if (wanted.length > 0) {
        yield await withDetails(context, wanted);
      }
      if (count >= limit) {
        return;
      }
    }
  }
}

/** One test case by key for the preview; null when the project has no such test case. */
export async function readZephyrCase(context: ZephyrProjectContext, key: string): Promise<ZephyrCase | null> {
  const testCase = await context.client.testCase(key);
  if (!testCase) {
    return null;
  }
  const [item] = await withDetails(context, [testCase]);
  await readCalledTests(context, [item!]);
  return item!;
}

/** Folders of the project with their full paths, to narrow a migration. */
export function folderChoices(folders: ZephyrFolder[]): { id: number; name: string }[] {
  const paths = folderPaths(folders);
  return folders.map((folder) => ({ id: folder.id, name: (paths.get(folder.id) ?? [folder.name]).join(" / ") })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Everything the mapping screens show about the Zephyr side, from a sample of test cases. */
export async function discoverZephyr(profile: Profile): Promise<SourceDiscovery> {
  const first = await loadZephyrContext(profile);
  const sample: ZephyrCase[] = [];
  for await (const page of readZephyrCases(first, profile, SAMPLE_SIZE)) {
    sample.push(...page);
  }
  // Kinds of custom fields and the types of issue links come from the whole sample.
  const context = { ...first, catalog: new ZephyrCatalog(first.catalog.dictionaries, sample) };
  const paths = sample.map((item) => (item.testCase.folder ? (context.catalog.dictionaries.folderPaths.get(item.testCase.folder.id) ?? []) : []));
  const levels = levelsOf(paths);
  const distinct = [...new Map(paths.filter((path) => path.length > 0).map((path) => [path.join("\u0000"), path])).values()].sort((a, b) => b.length - a.length);
  const warnings = [...context.warnings];
  const scoped = profile.zephyr.scope.folderIds.length > 0 || profile.zephyr.scope.testCaseKeys.length > 0;
  if (!scoped && context.totalTests > sample.length && sample.length > 0) {
    warnings.push(`Examples and counts come from ${sample.length} of ${context.totalTests} test cases.`);
  }
  if (sample.length === 0 && context.totalTests > 0) {
    warnings.push("No test case matches the folders or keys chosen on the Projects step.");
  }
  const sectionCount = new Set(paths.flatMap((path) => path.map((_name, index) => path.slice(0, index + 1).join("\u0000")))).size;
  return {
    source: "zephyr",
    project: { id: context.project.id, name: `${context.projectName} (${context.project.key})`, suiteMode: 1 },
    suites: [],
    structure: [{ suite: { id: context.project.id, name: "Test cases" }, sectionCount, maxDepth: levels.length, levels, examplePaths: distinct.slice(0, EXAMPLE_PATHS) }],
    maxDepth: levels.length,
    levels,
    fields: context.catalog.toInfo(sample),
    sampledCases: sample.length,
    sampleCaseIds: sample.slice(0, 50).map((item) => ({ id: item.testCase.key, name: item.testCase.name })),
    warnings,
  };
}
