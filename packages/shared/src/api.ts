/**
 * Data shapes exchanged between the server and the UI.
 */

export interface NamedId {
  id: number;
  name: string;
}

export interface ConnectionCheck {
  ok: boolean;
  message: string;
  /** Server version or user name when the service reports it. */
  details?: string;
}

// ---------------------------------------------------------------- TestRail discovery

export type SourceFieldKind =
  | "string"
  | "integer"
  | "text"
  | "url"
  | "checkbox"
  | "dropdown"
  | "user"
  | "date"
  | "milestone"
  | "steps"
  | "multiselect"
  /** A CSV column. */
  | "column"
  | "unknown";
/** @deprecated use SourceFieldKind */
export type TestRailFieldKind = SourceFieldKind;

export interface TestRailFieldOption {
  /** Value id as TestRail stores it, as a string. */
  id: string;
  label: string;
  /** How many sampled cases use this value. */
  count: number;
  /** For user fields: the TestRail user's email. */
  email?: string;
}

/** A field of the source: a TestRail case field or a CSV column. */
export interface SourceFieldInfo {
  /** System name as it appears on a case, e.g. `priority_id`, `custom_preconds`. */
  systemName: string;
  label: string;
  kind: SourceFieldKind;
  /** Built-in TestRail field rather than a custom one. */
  system: boolean;
  /** Closed set of values, if any. */
  options: TestRailFieldOption[] | null;
  /** Non-empty values seen in sampled cases. */
  filledCount: number;
  /** A few rendered example values from sampled cases. */
  examples: string[];
  /** Mapping the source suggests from the data, e.g. from a CSV column header. */
  suggestedTarget?: import("./profile.js").FieldTarget;
  /** Separator the values seem to use, e.g. a comma in "smoke, ui". */
  suggestedSeparator?: string;
}

export interface SectionLevelInfo {
  /** 1-based nesting level. */
  level: number;
  sectionCount: number;
  /** Cases whose deepest section sits on this level (from the sample). */
  caseCount: number;
  examples: string[];
}

export interface SuiteStructure {
  suite: NamedId;
  sectionCount: number;
  maxDepth: number;
  levels: SectionLevelInfo[];
  /** Example full paths, top level first. */
  examplePaths: string[][];
}

/** What the mapping screens show about the source: structure, fields and sample cases. */
export interface SourceDiscovery {
  source: "testrail" | "csv" | "xray";
  project: NamedId & { suiteMode: number };
  suites: NamedId[];
  structure: SuiteStructure[];
  /** Deepest section nesting over all selected suites. */
  maxDepth: number;
  /** Merged per-level statistics over all selected suites. */
  levels: SectionLevelInfo[];
  fields: SourceFieldInfo[];
  /** CSV only: how the file was read. */
  csv?: {
    fileName: string;
    delimiter: string;
    encoding: string;
    rowCount: number;
    caseCount: number;
    multiRow: boolean;
    /** Path column in use (configured or detected) and its separator. */
    pathColumn: string | null;
    pathSeparator: string | null;
    /** Columns that look like a section path, for the path column picker. */
    pathCandidates: { column: string; separator: string }[];
    stepFormat: string | null;
  };
  sampledCases: number;
  sampleCaseIds: { id: string; name: string }[];
  warnings: string[];
}

/** @deprecated use SourceFieldInfo */
export type TestRailFieldInfo = SourceFieldInfo;
/** @deprecated use SourceDiscovery */
export type TestRailDiscovery = SourceDiscovery;

/** A file in the tool's file library. */
export interface StoredFileInfo {
  id: string;
  name: string;
  size: number;
  uploadedAt: string;
  /** Profiles that use the file. */
  usedBy: { id: string; name: string }[];
}

/** First rows of a CSV file as the current settings read it. */
export interface CsvFilePreview {
  delimiter: string;
  encoding: string;
  columns: string[];
  rows: string[][];
  rowCount: number;
  caseCount: number;
  multiRow: boolean;
  warnings: string[];
}

// ---------------------------------------------------------------- TestOps discovery

export interface TestOpsCustomField {
  id: number;
  name: string;
  /** Bound to the selected project. */
  inProject: boolean;
}

export interface TestOpsUser {
  username: string;
  email?: string;
  name?: string;
}

export interface TestOpsDiscovery {
  project: NamedId;
  customFields: TestOpsCustomField[];
  layers: NamedId[];
  statuses: NamedId[];
  integrations: NamedId[];
  /** Test case member roles, e.g. Owner, Reviewer. */
  roles: NamedId[];
  /** Null when the token is not allowed to list users. */
  users: TestOpsUser[] | null;
  trees: NamedId[];
  warnings: string[];
}

// ---------------------------------------------------------------- Problems and how to fix them

/** Profile steps a problem can point to. */
export type FixStep = "connections" | "file" | "scope" | "structure" | "fields" | "options";

/** Where the user fixes a problem: a step of the profile, optionally a field (source field or column). */
export interface FixLink {
  step: FixStep;
  /** Source field system name or CSV column the fix concerns. */
  field?: string;
}

/** Something about one case the user should know, with the way to fix it. */
export interface PlannedNote {
  /** Stable identifier of the kind of problem, e.g. `issue-no-integration`. */
  code: string;
  /** About this case, e.g. naming the value. */
  text: string;
  /** The same problem in general terms, used to group it over many cases. */
  summary?: string;
  hint?: string;
  fix?: FixLink;
}

/** A problem of a run, aggregated over all cases it affects. */
export interface RunProblem {
  /** Groups identical problems, e.g. the same unknown owner. */
  key: string;
  code: string;
  level: "warn" | "error";
  /** What happened, in one sentence. */
  title: string;
  /** Why it happens and how to fix it. */
  hint: string;
  fix?: FixLink;
  /** Error text from the remote system, verbatim, for support. */
  detail?: string;
  count: number;
  /** Affected records: "Line 12" for CSV, "C123" for TestRail. Capped; see `count`. */
  cases: string[];
}

// ---------------------------------------------------------------- Preview

export interface PlannedAttachment {
  /** TestRail attachment id, or null for files the tool generates (tables moved out of step text). */
  sourceId: string | null;
  fileName: string;
  /** Content of generated files. */
  content?: string;
}

export type PlannedStep =
  | {
      type: "step";
      body: string;
      /** Nested steps, e.g. from an indented CSV scenario. */
      steps?: PlannedStep[];
      attachments: PlannedAttachment[];
      /** TestRail "additional info" of a step, becomes a nested step. */
      data: string | null;
      dataAttachments: PlannedAttachment[];
      expected: string | null;
      expectedAttachments: PlannedAttachment[];
    }
  | { type: "shared"; sourceId: number; name: string };

export interface PlannedCase {
  /** Identifies the case in the source; the migration tag is `<prefix>:<sourceId>`. */
  sourceId: string;
  sourceUrl: string | null;
  /** Update this existing Allure TestOps case instead of finding the case by its migration tag. */
  allureId?: number | null;
  name: string;
  description: string;
  precondition: string;
  expectedResult: string;
  tags: string[];
  customFields: Record<string, string[]>;
  layer: string | null;
  status: string | null;
  owner: string | null;
  /** Members with other roles, by role name. */
  members: { name: string; role: string }[];
  links: { name: string; url: string }[];
  issues: { key: string; integrationId: number | null }[];
  /** Keys of the case in a test management system known to Allure TestOps through an integration, e.g. an Xray test key. */
  testKeys?: { key: string; integrationId: number }[];
  comments: string[];
  attachments: PlannedAttachment[];
  scenario: PlannedStep[];
  /** Things that will not migrate as the user may expect. */
  notes: PlannedNote[];
}

// ---------------------------------------------------------------- Runs

export type RunStatus = "running" | "finished" | "failed" | "cancelled";

export interface RunCounters {
  total: number;
  processed: number;
  created: number;
  updated: number;
  failed: number;
  skipped: number;
}

export interface RunSummary {
  id: string;
  profileId: string;
  dryRun: boolean;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  counters: RunCounters;
  phase: string;
  error: string | null;
  /** How to fix `error`, when the run failed. */
  errorHint?: string;
  errorFix?: FixLink;
  /** Problems found so far, most severe first. Missing in runs made by older versions. */
  problems?: RunProblem[];
  /** What the run worked with. Missing in runs made by older versions. */
  context?: RunContext;
}

/** The source, target and tag prefix of a run, to tell runs made with other settings apart. */
export interface RunContext {
  /** Identifies the source: the CSV file id, or the TestRail address and project. */
  source: string;
  /** The source for people: the file name or the TestRail project. */
  sourceLabel: string;
  testopsProjectId: number | null;
  tagPrefix: string;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface RunLogEntry {
  seq: number;
  time: string;
  level: LogLevel;
  message: string;
  /** Source case key: the TestRail case id or the CSV case key. */
  caseId?: string;
  targetId?: number;
  /** Key of the RunProblem this line belongs to. */
  problem?: string;
}

export interface ProfileListItem {
  id: string;
  name: string;
  source: "testrail" | "csv" | "xray";
  /** CSV: name of the chosen file. */
  fileName: string | null;
  updatedAt: string;
  testrailEndpoint: string;
  /** Xray: Jira project key. */
  xrayProject?: string;
  testopsEndpoint: string;
  lastRun: RunSummary | null;
}
