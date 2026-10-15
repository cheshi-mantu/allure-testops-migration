import { maskSecrets, normalizePlanned, type PlannedCase, type Profile } from "@atm/shared";
import { groupCases, type CsvCase } from "../csv/cases.js";
import { detectPathSeparator, loadCsv } from "../csv/discovery.js";
import { transformCsvCase } from "../csv/transform.js";
import { transformCase, type SourceContext } from "../convert/transform.js";
import type { FileStore } from "../storage/fileStore.js";
import type { RetryInfo } from "../http/httpClient.js";
import { TestRailClient } from "../testrail/client.js";
import { loadTestRailContext } from "../testrail/discovery.js";
import type { TrCase } from "../testrail/types.js";
import { noAssets, testRailAssets, type SourceAssets } from "./assets.js";
import { KnownProblem } from "./problems.js";
import { loadXml, requireNameField, transformXmlCase, xmlCases, type XmlCase } from "../xml/source.js";
import { prepareFromTestOps } from "../fromtestops/source.js";
import { loadAlmContext, readAlmTests, readCalledTests as readAlmCalledTests } from "../alm/discovery.js";
import { testSummary } from "../alm/diagnostics.js";
import { almLabel, transformAlmTest } from "../alm/transform.js";
import { idOf, one, type AlmTest } from "../alm/types.js";
import { loadQaseContext, readQaseCases } from "../qase/discovery.js";
import { qaseCaseKey, transformQaseCase } from "../qase/transform.js";
import type { QaseCase } from "../qase/types.js";
import { XrayAssets } from "../xray/assets.js";
import { loadXrayContext, readCalledTests, readXrayCases } from "../xray/discovery.js";
import { transformXrayCase, type XrayContext } from "../xray/transform.js";
import type { XrayCase } from "../xray/types.js";

export interface SourceCase {
  key: string;
  title: string;
  /** CSV: 1-based line of the first row in the file. */
  line?: number;
  /** How people name the record, e.g. a Jira issue key. */
  label?: string;
}

/** "Line 12" for CSV records, "C123" for TestRail cases, the issue key for Xray: how a person finds the record in the source. */
export function caseLabel(testCase: SourceCase): string {
  return testCase.label ?? (testCase.line !== undefined ? `Line ${testCase.line}` : `C${testCase.key}`);
}

export interface Transformed {
  planned: PlannedCase;
  linkedCaseIds: string[];
}

type Log = (level: "debug" | "info" | "warn", message: string, caseId?: string) => void;

/** A source ready to hand out cases: TestRail or a CSV file. */
export interface PreparedSource<C extends SourceCase = SourceCase> {
  name: string;
  assets: SourceAssets;
  readCases(log: Log, isCancelled: () => boolean): Promise<C[]>;
  transform(testCase: C): Transformed;
  /** TestRail client when the source is TestRail, for rate limit reporting and request estimates. */
  testrail: TestRailClient | null;
  /** Ends a session the source opened, e.g. an ALM login. */
  close?(): Promise<void>;
}

export interface SourceDeps {
  files: FileStore;
}

export async function prepareSource(profile: Profile, deps: SourceDeps, log: Log, onRetry?: (info: RetryInfo) => void): Promise<PreparedSource> {
  const prepared = await readySource(profile, deps, log, onRetry);
  // Whatever the source, values are written trimmed, and tags, layers and statuses in lower case.
  const transform = prepared.transform.bind(prepared);
  return {
    ...prepared,
    transform: (testCase) => {
      const result = transform(testCase);
      return { ...result, planned: normalizePlanned(result.planned) };
    },
  };
}

function readySource(profile: Profile, deps: SourceDeps, log: Log, onRetry?: (info: RetryInfo) => void): Promise<PreparedSource> {
  switch (profile.source) {
    case "csv":
      return prepareCsv(profile, deps, log);
    case "xml":
      return prepareXml(profile, deps, log, onRetry);
    case "xray":
      return prepareXray(profile, log, onRetry);
    case "qase":
      return prepareQase(profile, log, onRetry);
    case "alm":
      return prepareAlm(profile, log, onRetry);
    case "testops":
      return prepareFromTestOps(profile, log, onRetry) as Promise<PreparedSource>;
    default:
      return prepareTestRail(profile, log, onRetry);
  }
}

type XmlSourceCase = SourceCase & { raw: XmlCase };

async function prepareXml(profile: Profile, deps: SourceDeps, log: Log, onRetry?: (info: RetryInfo) => void): Promise<PreparedSource<XmlSourceCase>> {
  requireNameField(profile);
  const { doc, fileName, xmlFiles } = await loadXml(profile, deps.files, onRetry);
  if (xmlFiles.enabled) {
    log("info", `Attached files and images are downloaded from ${xmlFiles.origin}.`);
  } else if (profile.xml.files.download) {
    log("warn", "Attached files are not downloaded: the address of the source system is not set (Connection step).");
  }
  doc.warnings.forEach((warning) => log("warn", warning));
  const { cases, warnings } = xmlCases(doc, profile);
  warnings.forEach((warning) => log("warn", warning));
  const lists = doc.stepLists.map((list) => `"${list.field}"`).join(", ");
  log("info", `File "${fileName}": ${cases.length} "${doc.caseElement}" element(s)${lists ? `, steps in ${lists}` : ""}.`);
  return {
    name: "XML",
    assets: xmlFiles.enabled ? xmlFiles : noAssets,
    testrail: null,
    transform: (testCase) => transformXmlCase(testCase.raw, profile, doc, xmlFiles),
    readCases: async () => {
      const all = cases.map((raw) => ({ key: raw.key, title: raw.name || `line ${raw.line}`, line: raw.line, raw }));
      // A trial run on a few cases, chosen by id or name.
      const only = new Set(profile.xml.onlyCases.map((v) => v.trim().toLowerCase()).filter(Boolean));
      return only.size > 0 ? all.filter((c) => only.has(c.key.toLowerCase()) || only.has(c.title.toLowerCase())) : all;
    },
  };
}

type QaseSourceCase = SourceCase & { raw: QaseCase };

async function prepareQase(profile: Profile, log: Log, onRetry?: (info: RetryInfo) => void): Promise<PreparedSource<QaseSourceCase>> {
  const context = await loadQaseContext(profile, onRetry);
  context.warnings.forEach((warning) => log("warn", warning));
  log("info", `Qase project ${context.project.title} (${context.code}): ${context.totalCases} test case(s), ${context.suites.size} suite(s).`);
  return {
    name: "Qase",
    assets: context.assets,
    testrail: null,
    transform: (testCase) => transformQaseCase(testCase.raw, context),
    readCases: async (logCase, isCancelled) => {
      const cases: QaseCase[] = [];
      for await (const page of readQaseCases(context, profile)) {
        cases.push(...page);
        logCase("info", `Read ${cases.length} case(s) from Qase...`);
        if (isCancelled()) {
          break;
        }
      }
      const missing = profile.qase.scope.caseIds.filter((id) => !cases.some((c) => c.id === id));
      missing.forEach((id) => logCase("warn", `${qaseCaseKey(context.code, id)} is not a case of Qase project ${context.code}.`, qaseCaseKey(context.code, id)));
      // Which images in text are Qase files is told by the hosts of the attachments.
      context.assets.learn(cases);
      return cases.map((raw) => ({ key: qaseCaseKey(context.code, raw.id), title: raw.title, label: qaseCaseKey(context.code, raw.id), raw }));
    },
  };
}

type AlmSourceCase = SourceCase & { raw: AlmTest };

async function prepareAlm(profile: Profile, log: Log, onRetry?: (info: RetryInfo) => void): Promise<PreparedSource<AlmSourceCase>> {
  const detailed = profile.alm.detailedLog;
  const trace = (message: string, caseId?: string) => log("debug", `ALM: ${message}`, caseId);
  if (detailed) {
    // The settings the run uses, without credentials, so the log alone explains what happened.
    const settings = maskSecrets(profile, "strip");
    trace(`Detailed log is on. Tool on Node.js ${process.version}. Settings: ${JSON.stringify({ alm: { ...settings.alm, connection: { ...settings.alm.connection, username: settings.alm.connection.username ? "(set)" : "", clientId: settings.alm.connection.clientId ? "(set)" : "" } }, structure: settings.structure, options: settings.options, fields: settings.fields })}`);
  }
  const context = await loadAlmContext(profile, onRetry, trace);
  context.warnings.forEach((warning) => log("warn", warning));
  log("info", `ALM project ${context.domain} / ${context.project}: ${context.totalTests} test(s), ${[...context.folders.values()].filter((folder) => folder.parentId !== 0).length} Test Plan folder(s).`);
  return {
    name: "ALM",
    assets: context.assets,
    testrail: null,
    close: () => context.client.logout(),
    transform: (testCase) => {
      const result = transformAlmTest(testCase.raw, context);
      if (detailed) {
        trace(`${testCase.label}: ${testSummary(testCase.raw, result.planned)}`, testCase.key);
      }
      return result;
    },
    readCases: async (logCase, isCancelled) => {
      const tests: AlmTest[] = [];
      for await (const page of readAlmTests(context, profile)) {
        tests.push(...page);
        logCase("info", `Read ${tests.length} test(s) from ALM...`);
        if (isCancelled()) {
          break;
        }
      }
      const missing = profile.alm.scope.testIds.filter((id) => !tests.some((test) => idOf(test.test) === id));
      missing.forEach((id) => logCase("warn", `${almLabel(id)} is not a test of ALM project ${context.domain} / ${context.project}.`, String(id)));
      await readAlmCalledTests(context, tests);
      if (context.called.size > 0) {
        logCase("info", `${context.called.size} test(s) are called by steps of other tests.`);
      }
      return tests.map((raw) => ({ key: String(idOf(raw.test)), title: one(raw.test, "name") ?? almLabel(idOf(raw.test)), label: almLabel(idOf(raw.test)), raw }));
    },
  };
}

type XraySourceCase = SourceCase & { raw: XrayCase };

async function prepareXray(profile: Profile, log: Log, onRetry?: (info: RetryInfo) => void): Promise<PreparedSource<XraySourceCase>> {
  const xrayContext = await loadXrayContext(profile, onRetry);
  xrayContext.warnings.forEach((warning) => log("warn", warning));
  log("info", `Jira project ${xrayContext.project.key}: ${xrayContext.totalTests} Xray test(s), issue type "${xrayContext.issueType}".`);
  const context: XrayContext = { profile, catalog: xrayContext.catalog, jiraBase: xrayContext.jira.endpoint, called: new Map() };
  const assets = new XrayAssets(xrayContext.xray, xrayContext.jira, context);
  return {
    name: "Jira and Xray",
    assets,
    testrail: null,
    transform: (testCase) => transformXrayCase(testCase.raw, context),
    readCases: async (logCase, isCancelled) => {
      const cases: XrayCase[] = [];
      for await (const page of readXrayCases(xrayContext, profile)) {
        cases.push(...page);
        logCase("info", `Read ${cases.length} test(s) from Jira and Xray...`);
        if (isCancelled()) {
          break;
        }
      }
      const missing = profile.xray.scope.issueKeys.filter((key) => !cases.some((c) => c.issue.key === key.trim().toUpperCase()));
      missing.forEach((key) => logCase("warn", `${key} is not an Xray test of project ${xrayContext.project.key}, or does not match the JQL filter.`, key));
      await readCalledTests(xrayContext, cases, context.called);
      if (context.called.size > 0) {
        logCase("info", `${context.called.size} test(s) are called by steps of other tests.`);
      }
      assets.register(cases);
      return cases.map((raw) => ({ key: raw.issue.key, title: String(raw.issue.fields.summary ?? raw.issue.key), label: raw.issue.key, raw }));
    },
  };
}

type TrSourceCase = SourceCase & { raw: TrCase };

async function prepareTestRail(profile: Profile, log: Log, onRetry?: (info: RetryInfo) => void): Promise<PreparedSource<TrSourceCase>> {
  const trContext = await loadTestRailContext(profile, new TestRailClient(profile.testrail.connection, undefined, onRetry));
  trContext.warnings.forEach((warning) => log("warn", warning));
  const context: SourceContext = {
    catalog: trContext.catalog,
    profile,
    endpoint: trContext.client.endpoint,
    project: trContext.project,
    suites: new Map(trContext.suites.map((suite) => [suite.id, suite])),
    sections: trContext.sections,
  };
  const client = trContext.client;
  const wrap = (raw: TrCase): TrSourceCase => ({ key: String(raw.id), title: raw.title, raw });
  return {
    name: "TestRail",
    assets: testRailAssets(client, profile),
    testrail: client,
    transform: (testCase) => transformCase(testCase.raw, context),
    readCases: async (logCase, isCancelled) => {
      const caseIds = profile.testrail.scope.caseIds;
      if (caseIds.length > 0) {
        const cases: TrSourceCase[] = [];
        for (const id of caseIds) {
          try {
            cases.push(wrap(await client.getCase(id)));
          } catch (error) {
            logCase("warn", `Case C${id} cannot be read: ${error instanceof Error ? error.message : String(error)}`, String(id));
          }
        }
        return cases;
      }
      const cases: TrSourceCase[] = [];
      for (const suite of trContext.suites) {
        if (isCancelled()) {
          break;
        }
        const suiteCases = await client.getCases(trContext.project.id, suite.id, profile.options.includeDeleted);
        logCase("info", `Suite "${suite.name}": ${suiteCases.length} case(s).`);
        cases.push(...suiteCases.map(wrap));
      }
      return cases;
    },
  };
}

type CsvSourceCase = SourceCase & { raw: CsvCase };

async function prepareCsv(profile: Profile, deps: SourceDeps, log: Log): Promise<PreparedSource<CsvSourceCase>> {
  if (!profile.fields.some((m) => m.target.kind === "name")) {
    throw new KnownProblem({
      key: "no-name-column",
      title: "No column is mapped to the test case name, so nothing can be imported.",
      hint: "The name is the only required value. On the Columns step, map the column that holds the test case names to \"Test case name\".",
      fix: { step: "fields" },
    });
  }
  const { table, fileName } = await loadCsv(profile, deps.files);
  table.warnings.forEach((warning) => log("warn", warning));
  const grouped = groupCases(table, profile);
  grouped.warnings.forEach((warning) => log("warn", warning));
  const pathColumn = profile.csv.pathColumn;
  const pathSeparator = pathColumn
    ? profile.csv.pathSeparator === "auto"
      ? (detectPathSeparator(table.rows.map((row) => (row[pathColumn] ?? "").trim())) ?? " > ")
      : profile.csv.pathSeparator
    : null;
  log(
    "info",
    `File "${fileName}": ${table.rows.length} row(s), ${grouped.cases.length} case(s)${grouped.multiRow ? " (cases span several rows)" : ""}.`,
  );
  const context = { profile, pathSeparator, multiRow: grouped.multiRow };
  return {
    name: "CSV",
    assets: noAssets,
    testrail: null,
    transform: (testCase) => transformCsvCase(testCase.raw, context),
    readCases: async () => {
      const cases = grouped.cases.map((raw) => ({ key: raw.key, title: raw.name || `line ${raw.line}`, line: raw.line, raw }));
      // A trial run on a few cases, chosen by id or name.
      const only = new Set(profile.csv.onlyCases.map((v) => v.trim().toLowerCase()).filter(Boolean));
      return only.size > 0 ? cases.filter((c) => only.has(c.key.toLowerCase()) || only.has(c.title.toLowerCase())) : cases;
    },
  };
}
