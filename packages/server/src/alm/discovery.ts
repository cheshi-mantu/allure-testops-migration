import type { Profile, SourceDiscovery } from "@atm/shared";
import { levelsOf } from "../csv/discovery.js";
import { KnownProblem } from "../engine/problems.js";
import { HttpError, type RetryInfo } from "../http/httpClient.js";
import { AlmAssets } from "./assets.js";
import { AlmCatalog } from "./catalog.js";
import { AlmClient, failureText, type AlmTrace } from "./client.js";
import { almLabel, almSteps, folderPath, type AlmContext, type AlmFolder } from "./transform.js";
import { idOf, one, type AlmRecord, type AlmTest } from "./types.js";

const SAMPLE_SIZE = 300;
const EXAMPLE_PATHS = 5;
/** Attachment lists read at the same time. */
const PARALLEL = 4;

export interface AlmProjectContext extends AlmContext {
  client: AlmClient;
  /** The detailed log; does nothing when it is off. */
  trace: AlmTrace;
  domain: string;
  project: string;
  totalTests: number;
  warnings: string[];
}

function requireSettings(profile: Profile): void {
  const connection = profile.alm.connection;
  const complete = connection.endpoint.trim() && (connection.auth === "apiKey" ? connection.clientId && connection.secret : connection.username && connection.password);
  if (!complete) {
    throw new KnownProblem({
      key: "alm-connection-incomplete",
      title: "The ALM connection is incomplete.",
      hint: connection.auth === "apiKey" ? "Enter the ALM address, the client id and the secret of the API key on the Connections step." : "Enter the ALM address, the user name and the password on the Connections step.",
      fix: { step: "connections" },
    });
  }
  if (!profile.alm.scope.domain.trim() || !profile.alm.scope.project.trim()) {
    throw new KnownProblem({
      key: "no-alm-project",
      title: "No ALM project is chosen.",
      hint: "Choose the domain and the project whose tests should be migrated.",
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

const stepOrder = (step: AlmRecord) => Number(one(step, "step-order") ?? 0);

/** Design steps, parameters and attachment lists of a page of tests. */
export async function withDetails(context: Pick<AlmProjectContext, "client" | "domain" | "project" | "warnings" | "trace">, tests: AlmRecord[]): Promise<AlmTest[]> {
  const { client, domain, project } = context;
  if (tests.length === 0) {
    return [];
  }
  const ids = tests.map(idOf);
  const [steps, parameters] = await Promise.all([
    client.designSteps(domain, project, ids),
    client.testParameters(domain, project, ids).catch((error) => {
      if (error instanceof HttpError && [400, 404].includes(error.status)) {
        if (!context.warnings.some((warning) => warning.includes("test parameters"))) {
          context.warnings.push("This ALM does not give test parameters through its API, so parameters are not migrated.");
        }
        return [];
      }
      throw error;
    }),
  ]);
  const result: AlmTest[] = tests.map((test) => ({
    test,
    steps: steps.filter((step) => one(step, "parent-id") === String(idOf(test))).sort((a, b) => stepOrder(a) - stepOrder(b) || idOf(a) - idOf(b)),
    parameters: parameters.filter((parameter) => one(parameter, "parent-id") === String(idOf(test))),
    attachments: [],
    stepAttachments: new Map(),
  }));
  // ALM marks tests and steps that have attachments; only those are asked for their lists.
  const lists: (() => Promise<void>)[] = [];
  for (const item of result) {
    if (one(item.test, "attachment") === "Y") {
      lists.push(async () => void (item.attachments = await client.attachments(domain, project, "tests", idOf(item.test))));
    }
    for (const step of item.steps) {
      if (one(step, "attachment") === "Y") {
        lists.push(async () => void item.stepAttachments.set(String(idOf(step)), await client.attachments(domain, project, "design-steps", idOf(step))));
      }
    }
  }
  await inParallel(lists, (list) => list());
  const orphans = steps.filter((step) => !result.some((item) => String(idOf(item.test)) === one(step, "parent-id"))).length;
  context.trace(
    `Read ${tests.length} test(s) (ids ${ids[0]}..${ids[ids.length - 1]}): ${steps.length} design step(s), ${parameters.length} parameter(s), ` +
      `${result.filter((item) => one(item.test, "attachment") === "Y").length} test(s) and ${result.reduce((sum, item) => sum + item.stepAttachments.size, 0)} step(s) marked with attachments` +
      `${orphans > 0 ? `; ${orphans} design step(s) belong to none of these tests` : ""}.`,
  );
  return result;
}

/** Tests called by design steps of these tests, and the tests those call, a few levels deep. */
export async function readCalledTests(context: AlmProjectContext, tests: AlmTest[]): Promise<void> {
  const known = new Map(tests.map((test) => [idOf(test.test), test]));
  const wanted = (items: AlmTest[]) => [...new Set(items.flatMap((item) => item.steps.map((step) => Number(one(step, "link-test") ?? 0)).filter((id) => id > 0 && !context.called.has(id))))];
  let pending = wanted(tests);
  for (let round = 0; pending.length > 0 && round < 5; round++) {
    pending.filter((id) => known.has(id)).forEach((id) => context.called.set(id, known.get(id)!));
    const missing = pending.filter((id) => !known.has(id));
    const loaded = await withDetails(context, missing.length > 0 ? await context.client.testsByIds(context.domain, context.project, missing) : []);
    loaded.forEach((test) => context.called.set(idOf(test.test), test));
    const unread = missing.filter((id) => !loaded.some((test) => idOf(test.test) === id));
    context.trace(`Called tests, round ${round + 1}: ${pending.length} called, ${missing.length} read from ALM${unread.length > 0 ? `, not found: ${unread.join(", ")}` : ""}.`);
    // Tests read here already had their own calls listed with them; only the loaded ones add more.
    pending = wanted(loaded);
  }
}

/** Client, folders, field catalog and users; used by discovery, preview and runs. */
export async function loadAlmContext(profile: Profile, onRetry?: (info: RetryInfo) => void, trace?: AlmTrace): Promise<AlmProjectContext> {
  requireSettings(profile);
  const log: AlmTrace = profile.alm.detailedLog && trace ? trace : () => undefined;
  const client = new AlmClient(profile.alm.connection, { ...(onRetry ? { onRetry } : {}), trace: log });
  const domain = profile.alm.scope.domain.trim();
  const project = profile.alm.scope.project.trim();
  const warnings: string[] = [];
  /** Lists the user may not be allowed to read: the migration goes on without them. */
  const optional = async <T>(what: string, read: () => Promise<T[]>): Promise<T[]> => {
    try {
      return await read();
    } catch (error) {
      // Anything but a rejected login or a server out of reach: the list is optional.
      if (error instanceof HttpError && error.status !== 401 && error.status !== 0) {
        log(`Going on without ${what}: ${failureText(error)}`);
        warnings.push(`ALM did not give ${what} to this user, so ${what === "the users" ? "users are shown by their user names" : "fields are shown by their names"}.`);
        return [];
      }
      throw error;
    }
  };
  try {
    return await projectContext(profile, client, domain, project, warnings, optional, log);
  } catch (error) {
    await client.logout();
    throw error;
  }
}

async function projectContext(
  profile: Profile,
  client: AlmClient,
  domain: string,
  project: string,
  warnings: string[],
  optional: <T>(what: string, read: () => Promise<T[]>) => Promise<T[]>,
  trace: AlmTrace,
): Promise<AlmProjectContext> {
  const [folders, definitions, users, totalTests] = await Promise.all([
    client.testFolders(domain, project),
    optional("the field settings of the project", () => client.testFields(domain, project)),
    optional("the users", () => client.users(domain, project)),
    client.testCount(domain, project),
  ]);
  if (totalTests === 0) {
    warnings.push(`ALM project ${domain} / ${project} has no tests.`);
  }
  // Without the field settings, the fields are those the first tests have.
  let sample: AlmRecord[] = [];
  if (definitions.length === 0) {
    for await (const page of client.tests(domain, project, null)) {
      sample = page;
      break;
    }
  }
  const catalog = new AlmCatalog(definitions, users, sample);
  trace(
    `Project ${domain} / ${project}: ${totalTests} test(s), ${folders.length} Test Plan folder(s) (${folders.filter((folder) => one(folder, "parent-id") === "0").map((folder) => `root "${one(folder, "name")}" id ${idOf(folder)}`).join(", ") || "no root folder with parent-id 0"}), ` +
      `${users.length} user(s), ${users.filter((user) => user.email).length} with an email.`,
  );
  trace(
    definitions.length > 0
      ? `Field settings: ${definitions.map((field) => `${field.name} "${field.label}" ${field.type || "?"}${field.multiValue ? " multi" : ""}${field.active ? "" : " inactive"}`).join("; ")}.`
      : `No field settings; fields seen on the first tests: ${[...new Set(sample.flatMap((record) => Object.keys(record.fields)))].join(", ")}.`,
  );
  trace(`Fields offered for mapping: ${catalog.fields.map((field) => `${field.systemName} (${field.kind})`).join(", ")}.`);
  const called = new Map<number, AlmTest>();
  const assets = new AlmAssets(client, domain, project, called);
  const context: AlmProjectContext = {
    profile,
    catalog,
    assets,
    folders: new Map<number, AlmFolder>(folders.map((folder) => [idOf(folder), { name: one(folder, "name") ?? `Folder ${idOf(folder)}`, parentId: Number(one(folder, "parent-id") ?? 0) }])),
    called,
    client,
    trace,
    domain,
    project,
    totalTests,
    warnings,
  };
  assets.convertSteps = (test) => almSteps(test, context, false);
  return context;
}

/** Ids of the chosen folders and of every folder inside them; null when no folder is chosen. */
function chosenFolders(profile: Profile, folders: Map<number, AlmFolder>): number[] | null {
  const chosen = profile.alm.scope.folderIds;
  if (chosen.length === 0) {
    return null;
  }
  const result = new Set(chosen);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [id, folder] of folders) {
      if (result.has(folder.parentId) && !result.has(id)) {
        result.add(id);
        grew = true;
      }
    }
  }
  return [...result];
}

/** Tests of the scope with their details, page by page. */
export async function* readAlmTests(context: AlmProjectContext, profile: Profile, limit = Infinity): AsyncGenerator<AlmTest[]> {
  const ids = profile.alm.scope.testIds;
  if (ids.length > 0) {
    // A trial run on a few tests: read just them.
    const tests = await context.client.testsByIds(context.domain, context.project, ids.slice(0, limit));
    if (tests.length > 0) {
      yield await withDetails(context, tests);
    }
    return;
  }
  let count = 0;
  for await (const page of context.client.tests(context.domain, context.project, chosenFolders(profile, context.folders))) {
    const wanted = page.slice(0, limit - count);
    count += wanted.length;
    if (wanted.length > 0) {
      yield await withDetails(context, wanted);
    }
    if (count >= limit) {
      return;
    }
  }
}

/** One test by id; null when the project has no such test. */
export async function readAlmTest(context: AlmProjectContext, id: number): Promise<AlmTest | null> {
  const [test] = await context.client.testsByIds(context.domain, context.project, [id]);
  if (!test) {
    return null;
  }
  const [detailed] = await withDetails(context, [test]);
  await readCalledTests(context, [detailed!]);
  return detailed!;
}

/** "12", "#12" or "Test 12" to the test id; null for anything else. */
export function parseAlmTestId(raw: string): number | null {
  const match = /^\s*(?:test\s*)?#?(\d+)\s*$/i.exec(raw);
  return match ? Number(match[1]) : null;
}

/** Folders of the project with their full paths, to narrow a migration. */
export function folderChoices(folders: Map<number, AlmFolder>): { id: number; name: string }[] {
  return [...folders.entries()]
    .filter(([, folder]) => folder.parentId !== 0)
    .map(([id, folder]) => ({ id, name: [...folderPath(folder.parentId, folders), folder.name].join(" / ") }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Everything the mapping screens show about the ALM side, from a sample of tests. */
export async function discoverAlm(profile: Profile): Promise<SourceDiscovery> {
  const context = await loadAlmContext(profile);
  try {
    const sample: AlmTest[] = [];
    for await (const page of readAlmTests(context, profile, SAMPLE_SIZE)) {
      sample.push(...page);
    }
    const paths = sample.map((test) => folderPath(Number(one(test.test, "parent-id") ?? 0) || null, context.folders));
    const levels = levelsOf(paths);
    const distinct = [...new Map(paths.filter((path) => path.length > 0).map((path) => [path.join("\u0000"), path])).values()].sort((a, b) => b.length - a.length);
    const warnings = [...context.warnings];
    const scoped = profile.alm.scope.folderIds.length > 0 || profile.alm.scope.testIds.length > 0;
    if (!scoped && context.totalTests > sample.length && sample.length > 0) {
      warnings.push(`Examples and counts come from ${sample.length} of ${context.totalTests} tests.`);
    }
    if (sample.length === 0 && context.totalTests > 0) {
      warnings.push("No test matches the folders or test ids chosen on the Projects step.");
    }
    const sectionCount = new Set(paths.flatMap((path) => path.map((_name, index) => path.slice(0, index + 1).join("\u0000")))).size;
    return {
      source: "alm",
      project: { id: 0, name: `${context.domain} / ${context.project}`, suiteMode: 1 },
      suites: [],
      structure: [{ suite: { id: 0, name: "Test Plan" }, sectionCount, maxDepth: levels.length, levels, examplePaths: distinct.slice(0, EXAMPLE_PATHS) }],
      maxDepth: levels.length,
      levels,
      fields: context.catalog.toInfo(sample),
      sampledCases: sample.length,
      sampleCaseIds: sample.slice(0, 50).map((test) => ({ id: String(idOf(test.test)), name: one(test.test, "name") ?? almLabel(idOf(test.test)) })),
      warnings,
    };
  } finally {
    await context.client.logout();
  }
}
