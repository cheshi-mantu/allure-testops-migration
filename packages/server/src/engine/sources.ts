import type { PlannedCase, Profile } from "@atm/shared";
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

type Log = (level: "info" | "warn", message: string, caseId?: string) => void;

/** A source ready to hand out cases: TestRail or a CSV file. */
export interface PreparedSource<C extends SourceCase = SourceCase> {
  name: string;
  assets: SourceAssets;
  readCases(log: Log, isCancelled: () => boolean): Promise<C[]>;
  transform(testCase: C): Transformed;
  /** TestRail client when the source is TestRail, for rate limit reporting and request estimates. */
  testrail: TestRailClient | null;
}

export interface SourceDeps {
  files: FileStore;
}

export async function prepareSource(profile: Profile, deps: SourceDeps, log: Log, onRetry?: (info: RetryInfo) => void): Promise<PreparedSource> {
  switch (profile.source) {
    case "csv":
      return prepareCsv(profile, deps, log);
    case "xray":
      return prepareXray(profile, log, onRetry);
    default:
      return prepareTestRail(profile, log, onRetry);
  }
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
