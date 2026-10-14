import type { Profile, SourceDiscovery } from "@atm/shared";
import type { CaseAttachments, SharedStepContent, SourceAssets } from "../engine/assets.js";
import { contentTypeFor, safeFileName, type DownloadedAttachment } from "../engine/attachments.js";
import { KnownProblem } from "../engine/problems.js";
import type { RetryInfo } from "../http/httpClient.js";
import { TestOpsClient, type ToNamed } from "../testops/client.js";
import { CASE_FILE, scenarioSteps, SHARED_FILE, transformTestOpsCase, type FromTestOpsContext, type SourceTestCase } from "./transform.js";

/** The source Allure TestOps; the target is `profile.testops`. */
export function sourceClient(profile: Profile, onRetry?: (info: RetryInfo) => void): TestOpsClient {
  const connection = profile.testopsSource.connection;
  if (!connection.endpoint.trim() || !connection.apiToken) {
    throw new KnownProblem({
      key: "testops-source-incomplete",
      title: "The connection to the source Allure TestOps is incomplete.",
      hint: "Enter the URL and an API token of the source Allure TestOps on the Connections step.",
      fix: { step: "connections" },
    });
  }
  return new TestOpsClient(connection, undefined, onRetry);
}

/** Whether a case is migrated by its automated flag. */
export function wantedByType(profile: Profile, automated: boolean | null | undefined): boolean {
  return automated ? profile.testopsSource.automated : profile.testopsSource.manual;
}

export function requireProjects(profile: Profile): void {
  if (!profile.testopsSource.manual && !profile.testopsSource.automated) {
    throw new KnownProblem({
      key: "testops-no-case-type",
      title: "Neither manual nor automated test cases are chosen, so nothing would be migrated.",
      hint: "Turn on manual or automated test cases, or both, on the Projects step.",
      fix: { step: "scope" },
    });
  }
  if (profile.testopsSource.projects.length === 0) {
    throw new KnownProblem({
      key: "no-testops-projects",
      title: "No project of the source Allure TestOps is chosen.",
      hint: "Choose the projects to migrate on the Projects step.",
      fix: { step: "scope" },
    });
  }
}

/** Reads one test case with everything that is migrated. */
export async function readTestCase(client: TestOpsClient, id: number): Promise<SourceTestCase> {
  const [overview, scenario, comments] = await Promise.all([client.overview(id), client.scenario(id), client.comments(id).catch(() => [])]);
  return { overview, scenario, comments };
}

export async function fromTestOpsContext(profile: Profile, client: TestOpsClient): Promise<FromTestOpsContext> {
  const integrationNames = new Map<number, string>();
  for (const pair of profile.testopsSource.projects) {
    for (const integration of await client.projectIntegrations(pair.sourceId).catch(() => [])) {
      integrationNames.set(integration.id, integration.name);
    }
  }
  return {
    profile,
    sourceBase: client.endpoint,
    integrations: new Map(Object.entries(profile.testopsSource.integrations).map(([source, target]) => [Number(source), target])),
    integrationNames,
  };
}

/**
 * Files and shared steps of the source. Files of a case are all migrated, also those its text
 * does not show; names stay as they are, made unique within a case.
 */
export class FromTestOpsAssets implements SourceAssets {
  readonly sourceName = "the source Allure TestOps";
  readonly attachmentHint = "Check that the API token of the source Allure TestOps can read the project and its files. Cases stay migrated; run again to add the files.";
  private readonly names = new Map<string, string>();
  private sharedNames: Promise<Map<number, string>> | null = null;

  constructor(
    private readonly client: TestOpsClient,
    private readonly projectId: number,
    private readonly useSharedSteps: boolean,
  ) {}

  attachments(caseKey: string | null): CaseAttachments {
    const used = new Map<string, string>();
    // The files of the case, read once: they name the files images in text refer to.
    let listed: Promise<{ id: string }[]> | null = null;
    const list = () =>
      (listed ??= caseKey === null
        ? Promise.resolve([])
        : this.client.testCaseAttachments(Number(caseKey)).then((files) => {
            files.forEach((file) => this.names.set(`${CASE_FILE}${file.id}`, file.name));
            return files.map((file) => ({ id: `${CASE_FILE}${file.id}` }));
          }));
    return {
      caseAttachments: list,
      download: async (key) => {
        if (key.startsWith(CASE_FILE)) {
          await list().catch(() => []);
        }
        const file = await this.download(key);
        let fileName = file.fileName;
        for (let copy = 2; used.has(fileName) && used.get(fileName) !== key; copy += 1) {
          fileName = file.fileName.replace(/(\.[A-Za-z0-9]{1,5})?$/, (extension) => `-${copy}${extension}`);
        }
        used.set(fileName, key);
        return { ...file, fileName };
      },
    };
  }

  private async download(key: string): Promise<DownloadedAttachment> {
    const id = Number(key.slice(1));
    const result = key.startsWith(SHARED_FILE) ? await this.client.sharedStepAttachmentContent(id) : await this.client.testCaseAttachmentContent(id);
    const fileName = safeFileName(this.names.get(key) ?? result.fileName ?? `attachment-${id}`);
    return { fileName, data: result.data, contentType: contentTypeFor(fileName, result.contentType) };
  }

  /** Names of the shared steps of the project; a name used twice gets the source id, to keep them apart. */
  private async sharedStepNames(): Promise<Map<number, string>> {
    this.sharedNames ??= this.client
      .all<ToNamed>("api/rs/sharedstep", { projectId: this.projectId, archived: false })
      .then((steps) => {
        const counts = new Map<string, number>();
        steps.forEach((step) => counts.set(step.name, (counts.get(step.name) ?? 0) + 1));
        return new Map(steps.map((step) => [step.id, counts.get(step.name)! > 1 ? `${step.name} [${step.id}]` : step.name]));
      })
      .catch(() => new Map());
    return this.sharedNames;
  }

  async sharedStep(id: number): Promise<SharedStepContent> {
    const [info, scenario, names, files] = await Promise.all([
      this.client.sharedStep(id),
      this.client.sharedStepScenario(id),
      this.sharedStepNames(),
      this.client.sharedStepAttachments(id).catch(() => []),
    ]);
    files.forEach((file) => this.names.set(`${SHARED_FILE}${file.id}`, file.name));
    // The scenario of a shared step lists its own steps and files like a case does.
    (Object.values(scenario.attachments ?? {}) as { id: number; name?: string | null }[]).forEach((file) => file.name && this.names.set(`${SHARED_FILE}${file.id}`, file.name));
    const own = { ...scenario, sharedStepScenarioSteps: scenario.scenarioSteps, sharedStepAttachments: scenario.attachments };
    const steps = scenarioSteps(scenario.root?.children ?? [], own, { useSharedSteps: this.useSharedSteps, inShared: true });
    const name = names.get(id) ?? info.name;
    return { id, title: info.name, name, steps, attachments: files.map((file) => ({ sourceId: `${SHARED_FILE}${file.id}`, fileName: file.name })) };
  }
}

export interface FromTestOpsSourceCase {
  key: string;
  title: string;
  label: string;
  raw: { id: number };
}

/** The source as the runner uses it, for the first project of the profile (the runner passes one at a time). */
export async function prepareFromTestOps(profile: Profile, log: (level: "info" | "warn", message: string, caseId?: string) => void, onRetry?: (info: RetryInfo) => void) {
  requireProjects(profile);
  const client = sourceClient(profile, onRetry);
  const pair = profile.testopsSource.projects[0]!;
  const context = await fromTestOpsContext(profile, client);
  const assets = new FromTestOpsAssets(client, pair.sourceId, profile.options.migrateSharedSteps);
  const read = new Map<string, SourceTestCase>();
  return {
    name: `Allure TestOps project ${pair.sourceName}`,
    assets,
    testrail: null,
    readCases: async (logCase: typeof log, isCancelled: () => boolean): Promise<FromTestOpsSourceCase[]> => {
      const wanted = new Set(profile.testopsSource.caseIds);
      const all = (await client.testCaseIds(pair.sourceId)).filter((testCase) => wanted.size === 0 || wanted.has(testCase.id));
      const listed = all.filter((testCase) => wantedByType(profile, testCase.automated));
      const left = all.length - listed.length;
      logCase(
        "info",
        `Project ${pair.sourceName} (#${pair.sourceId}): ${listed.length} test case(s)${left > 0 ? `; ${left} ${profile.testopsSource.manual ? "automated" : "manual"} case(s) are left out by the filter on the Projects step` : ""}.`,
      );
      const cases: FromTestOpsSourceCase[] = [];
      // Reading is three requests a case: a few at a time, like writing.
      const batch = Math.max(1, profile.options.concurrency * 2);
      for (let index = 0; index < listed.length && !isCancelled(); index += batch) {
        const part = listed.slice(index, index + batch);
        const loaded = await Promise.all(part.map((testCase) => readTestCase(client, testCase.id)));
        loaded.forEach((testCase) => {
          read.set(String(testCase.overview.id), testCase);
          cases.push({ key: String(testCase.overview.id), title: testCase.overview.name, label: `#${testCase.overview.id}`, raw: { id: testCase.overview.id } });
        });
        logCase("info", `Read ${cases.length} of ${listed.length} case(s)...`);
      }
      return cases;
    },
    transform: (testCase: FromTestOpsSourceCase) => transformTestOpsCase(read.get(testCase.key)!, context),
  };
}

/** What the Preview step needs: a sample of cases of the chosen projects. */
export async function discoverFromTestOps(profile: Profile): Promise<SourceDiscovery> {
  requireProjects(profile);
  const client = sourceClient(profile);
  const sample: { id: string; name: string }[] = [];
  for (const pair of profile.testopsSource.projects) {
    const cases = await client.all<{ id: number; name: string; automated?: boolean | null }>("api/rs/testcase/__search", { projectId: pair.sourceId, rql: "true", sort: "id,asc" }, 1);
    sample.push(...cases.filter((testCase) => wantedByType(profile, testCase.automated)).slice(0, 20).map((testCase) => ({ id: String(testCase.id), name: `${testCase.name} (${pair.sourceName})` })));
  }
  return {
    source: "testops",
    project: { id: 0, name: profile.testopsSource.projects.map((p) => p.sourceName).join(", "), suiteMode: 1 },
    suites: [],
    structure: [],
    maxDepth: 0,
    levels: [],
    fields: [],
    sampledCases: sample.length,
    sampleCaseIds: sample,
    warnings: [],
  };
}
