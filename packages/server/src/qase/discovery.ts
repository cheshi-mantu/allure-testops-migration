import type { Profile, SourceDiscovery } from "@atm/shared";
import { levelsOf } from "../csv/discovery.js";
import { KnownProblem } from "../engine/problems.js";
import { HttpError, type RetryInfo } from "../http/httpClient.js";
import { QaseAssets } from "./assets.js";
import { QaseCatalog } from "./catalog.js";
import { QaseClient } from "./client.js";
import { qaseCaseKey, qaseSteps, suitePath, type QaseContext } from "./transform.js";
import type { QaseCase, QaseProject, QaseSuite } from "./types.js";

const SAMPLE_SIZE = 300;
const EXAMPLE_PATHS = 5;

export interface QaseProjectContext extends QaseContext {
  client: QaseClient;
  project: QaseProject;
  totalCases: number;
  warnings: string[];
}

function requireSettings(profile: Profile): void {
  const connection = profile.qase.connection;
  if (!connection.apiToken) {
    throw new KnownProblem({
      key: "qase-connection-incomplete",
      title: "The Qase connection is incomplete.",
      hint: "Enter the Qase API token on the Connections step.",
      fix: { step: "connections" },
    });
  }
  if (!profile.qase.scope.projectCode.trim()) {
    throw new KnownProblem({
      key: "no-qase-project",
      title: "No Qase project is chosen.",
      hint: "Choose the Qase project whose test cases should be migrated.",
      fix: { step: "scope" },
    });
  }
}

/** Client, project, suites, field catalog and shared steps; used by discovery, preview and runs. */
export async function loadQaseContext(profile: Profile, onRetry?: (info: RetryInfo) => void): Promise<QaseProjectContext> {
  requireSettings(profile);
  const client = new QaseClient(profile.qase.connection, onRetry);
  const code = profile.qase.scope.projectCode.trim().toUpperCase();
  const warnings: string[] = [];
  const project = await client.project(code);
  /** Lists a user of the token may not be allowed to read: the migration goes on without them. */
  const optional = async <T>(what: string, read: () => Promise<T[]>): Promise<T[]> => {
    try {
      return await read();
    } catch (error) {
      if (error instanceof HttpError && [401, 403, 404].includes(error.status)) {
        warnings.push(`Qase did not give the list of ${what} to this API token, so ${what} are shown by their ids.`);
        return [];
      }
      throw error;
    }
  };
  const [suites, systemFields, customFields, milestones, sharedSteps, users, authors, totalCases] = await Promise.all([
    client.suites(code),
    client.systemFields(),
    client.customFields(),
    client.milestones(code),
    client.sharedSteps(code),
    optional("users", () => client.users()),
    optional("authors", () => client.authors()),
    client.caseCount(code),
  ]);
  if (totalCases === 0) {
    warnings.push(`Qase project ${code} has no test cases.`);
  }
  const catalog = new QaseCatalog({
    systemFields,
    customFields: customFields.filter((field) => field.is_enabled_for_all_projects || (field.projects_codes ?? []).includes(code)),
    milestones,
    authors,
    users,
  });
  const assets = new QaseAssets(client, sharedSteps);
  const context: QaseProjectContext = { profile, catalog, assets, code, suites: new Map(suites.map((suite) => [suite.id, suite])), client, project, totalCases, warnings };
  assets.convertSteps = (steps) => qaseSteps(steps, context, false, { format: profile.options.textFormat });
  return context;
}

/** Ids of the chosen suites and of every suite inside them; null when no suite is chosen. */
function chosenSuites(profile: Profile, suites: Map<number, QaseSuite>): Set<number> | null {
  const chosen = profile.qase.scope.suiteIds;
  if (chosen.length === 0) {
    return null;
  }
  const result = new Set(chosen);
  for (let grew = true; grew; ) {
    grew = false;
    for (const suite of suites.values()) {
      if (suite.parent_id && result.has(suite.parent_id) && !result.has(suite.id)) {
        result.add(suite.id);
        grew = true;
      }
    }
  }
  return result;
}

/** Cases of the scope, page by page, in the order Qase lists them. */
export async function* readQaseCases(context: QaseProjectContext, profile: Profile, limit = Infinity): AsyncGenerator<QaseCase[]> {
  const ids = profile.qase.scope.caseIds;
  if (ids.length > 0) {
    // A trial run on a few cases: read them one by one instead of the whole project.
    const cases: QaseCase[] = [];
    for (const id of ids.slice(0, limit)) {
      const found = await readQaseCase(context, id);
      if (found) {
        cases.push(found);
      }
    }
    if (cases.length > 0) {
      yield cases;
    }
    return;
  }
  const suites = chosenSuites(profile, context.suites);
  let count = 0;
  for await (const page of context.client.cases(context.code)) {
    const wanted = (suites ? page.filter((testCase) => testCase.suite_id && suites.has(testCase.suite_id)) : page).slice(0, limit - count);
    count += wanted.length;
    if (wanted.length > 0) {
      yield wanted;
    }
    if (count >= limit) {
      return;
    }
  }
}

/** One case by id; null when the project has no such case. */
export async function readQaseCase(context: QaseProjectContext, id: number): Promise<QaseCase | null> {
  try {
    return await context.client.testCase(context.code, id);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

/** "DEMO-12", "demo-12" or "12" to the case id; null for anything else or another project. */
export function parseQaseCaseId(raw: string, code: string): number | null {
  const match = /^\s*(?:([A-Za-z0-9_]+)-)?(\d+)\s*$/.exec(raw);
  if (!match || (match[1] && match[1].toUpperCase() !== code.toUpperCase())) {
    return null;
  }
  return Number(match[2]);
}

/** Everything the mapping screens show about the Qase side, from a sample of cases. */
export async function discoverQase(profile: Profile): Promise<SourceDiscovery> {
  const context = await loadQaseContext(profile);
  const sample: QaseCase[] = [];
  for await (const page of readQaseCases(context, profile, SAMPLE_SIZE)) {
    sample.push(...page);
  }
  const paths = sample.map((testCase) => suitePath(testCase.suite_id, context.suites));
  const levels = levelsOf(paths);
  const distinct = [...new Map(paths.filter((path) => path.length > 0).map((path) => [path.join("\u0000"), path])).values()].sort((a, b) => b.length - a.length);
  const warnings = [...context.warnings];
  const scoped = profile.qase.scope.suiteIds.length > 0 || profile.qase.scope.caseIds.length > 0;
  if (!scoped && context.totalCases > sample.length && sample.length > 0) {
    warnings.push(`Examples and counts come from ${sample.length} of ${context.totalCases} cases.`);
  }
  if (sample.length === 0 && context.totalCases > 0) {
    warnings.push("No case matches the suites or case ids chosen on the Projects step.");
  }
  const sectionCount = new Set(paths.flatMap((path) => path.map((_name, index) => path.slice(0, index + 1).join("\u0000")))).size;
  return {
    source: "qase",
    project: { id: 0, name: `${context.project.title} (${context.code})`, suiteMode: 1 },
    suites: [],
    structure: [{ suite: { id: 0, name: "Suites" }, sectionCount, maxDepth: levels.length, levels, examplePaths: distinct.slice(0, EXAMPLE_PATHS) }],
    maxDepth: levels.length,
    levels,
    fields: context.catalog.toInfo(sample),
    sampledCases: sample.length,
    sampleCaseIds: sample.slice(0, 50).map((testCase) => ({ id: qaseCaseKey(context.code, testCase.id), name: testCase.title })),
    warnings,
  };
}
