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

export type TestRailFieldKind =
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
  | "unknown";

export interface TestRailFieldOption {
  /** Value id as TestRail stores it, as a string. */
  id: string;
  label: string;
  /** How many sampled cases use this value. */
  count: number;
  /** For user fields: the TestRail user's email. */
  email?: string;
}

export interface TestRailFieldInfo {
  /** System name as it appears on a case, e.g. `priority_id`, `custom_preconds`. */
  systemName: string;
  label: string;
  kind: TestRailFieldKind;
  /** Built-in TestRail field rather than a custom one. */
  system: boolean;
  /** Closed set of values, if any. */
  options: TestRailFieldOption[] | null;
  /** Non-empty values seen in sampled cases. */
  filledCount: number;
  /** A few rendered example values from sampled cases. */
  examples: string[];
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

export interface TestRailDiscovery {
  project: NamedId & { suiteMode: number };
  suites: NamedId[];
  structure: SuiteStructure[];
  /** Deepest section nesting over all selected suites. */
  maxDepth: number;
  /** Merged per-level statistics over all selected suites. */
  levels: SectionLevelInfo[];
  fields: TestRailFieldInfo[];
  sampledCases: number;
  sampleCaseIds: NamedId[];
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
  /** Null when the token is not allowed to list users. */
  users: TestOpsUser[] | null;
  trees: NamedId[];
  warnings: string[];
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
      attachments: PlannedAttachment[];
      /** TestRail "additional info" of a step, becomes a nested step. */
      data: string | null;
      dataAttachments: PlannedAttachment[];
      expected: string | null;
      expectedAttachments: PlannedAttachment[];
    }
  | { type: "shared"; sourceId: number; name: string };

export interface PlannedCase {
  sourceId: number;
  sourceUrl: string;
  name: string;
  description: string;
  precondition: string;
  expectedResult: string;
  tags: string[];
  customFields: Record<string, string[]>;
  layer: string | null;
  status: string | null;
  owner: string | null;
  links: { name: string; url: string }[];
  issues: { key: string; integrationId: number | null }[];
  comments: string[];
  attachments: PlannedAttachment[];
  scenario: PlannedStep[];
  /** Things that will not migrate as the user may expect. */
  notes: string[];
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
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface RunLogEntry {
  seq: number;
  time: string;
  level: LogLevel;
  message: string;
  caseId?: number;
  targetId?: number;
}

export interface ProfileListItem {
  id: string;
  name: string;
  updatedAt: string;
  testrailEndpoint: string;
  testopsEndpoint: string;
  lastRun: RunSummary | null;
}
