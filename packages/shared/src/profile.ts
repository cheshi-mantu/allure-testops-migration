import { z } from "zod";

/**
 * A migration profile is everything the tool needs to run one migration:
 * where to read from, where to write to, and how source data maps onto Allure TestOps.
 * Profiles are stored as JSON files in the data volume and can be exported/imported.
 */

export const PROFILE_FORMAT_VERSION = 1;

/** Placeholder the API returns instead of a stored secret. Sending it back keeps the stored value. */
export const SECRET_MASK = "********";

export const TestRailConnectionSchema = z.object({
  endpoint: z.string().default(""),
  username: z.string().default(""),
  /** TestRail API key (preferred) or password. */
  apiKey: z.string().default(""),
  /**
   * Optional browser session cookie (`tr_session=...`). Only needed for inline images on
   * TestRail instances where the attachment API does not serve them.
   */
  sessionCookie: z.string().default(""),
  insecureTls: z.boolean().default(false),
  /**
   * TestRail Cloud limits API requests per instance: 180 per minute on Professional, 300 on
   * Enterprise. TestRail Server has no limit.
   */
  rateLimit: z.enum(["professional", "enterprise", "custom", "off"]).default("professional"),
  /** Used when `rateLimit` is `custom`. */
  requestsPerMinute: z.number().int().min(1).max(100_000).default(180),
});
export type TestRailConnection = z.infer<typeof TestRailConnectionSchema>;

export const TESTRAIL_RATE_LIMITS = { professional: 180, enterprise: 300 } as const;

/** Requests per minute the tool allows itself against TestRail, or null for no limit. */
export function testRailRequestsPerMinute(connection: Pick<TestRailConnection, "rateLimit" | "requestsPerMinute">): number | null {
  switch (connection.rateLimit) {
    case "off":
      return null;
    case "custom":
      return connection.requestsPerMinute;
    default:
      return TESTRAIL_RATE_LIMITS[connection.rateLimit];
  }
}

export const TestOpsConnectionSchema = z.object({
  endpoint: z.string().default(""),
  apiToken: z.string().default(""),
  insecureTls: z.boolean().default(false),
});
export type TestOpsConnection = z.infer<typeof TestOpsConnectionSchema>;

export const TestRailScopeSchema = z.object({
  projectId: z.number().int().positive().nullable().default(null),
  /** Empty means all suites of the project. */
  suiteIds: z.array(z.number().int().positive()).default([]),
  /** When not empty only these cases are migrated. */
  caseIds: z.array(z.number().int().positive()).default([]),
});
export type TestRailScope = z.infer<typeof TestRailScopeSchema>;

export const TestOpsScopeSchema = z.object({
  projectId: z.number().int().positive().nullable().default(null),
});
export type TestOpsScope = z.infer<typeof TestOpsScopeSchema>;

/**
 * How the TestRail suite/section hierarchy becomes Allure TestOps custom fields.
 * Each nesting level of sections maps to its own custom field, so a tree can be built from them.
 */
export const StructureMappingSchema = z.object({
  /** Custom field that receives the suite name, null to skip. Useful for multi-suite projects. */
  suiteField: z.string().nullable().default(null),
  /** Index 0 is the top level section. A null entry skips that level. */
  levels: z.array(z.string().nullable()).default([]),
  /** What to do with sections nested deeper than `levels.length`. */
  deeperLevels: z.enum(["join", "drop"]).default("join"),
  /** Separator used when deeper levels are joined into the last mapped level. */
  joinSeparator: z.string().default(" / "),
  /** Create (or reuse) an Allure TestOps tree built from the mapped fields. */
  createTree: z.boolean().default(true),
  treeName: z.string().default("TestRail sections"),
});
export type StructureMapping = z.infer<typeof StructureMappingSchema>;

export const SOURCES = ["testrail", "csv"] as const;
export type SourceType = (typeof SOURCES)[number];

export const CSV_ENCODINGS = ["auto", "utf-8", "utf-16le", "utf-16be", "windows-1252", "windows-1251", "iso-8859-1"] as const;
export const CSV_STEP_FORMATS = ["auto", "lines", "indented", "numbered", "testops", "regex", "single"] as const;

/** How a CSV file is read and how its rows become test cases. */
export const CsvSourceSchema = z.object({
  /** File in the tool's file library (data volume). */
  fileId: z.string().nullable().default(null),
  /** `auto` detects `,`, `;`, tab or `|`. */
  delimiter: z.string().default("auto"),
  quote: z.string().length(1).default('"'),
  encoding: z.enum(CSV_ENCODINGS).default("auto"),
  /**
   * `single`: every row is a test case. `multi`: a row without a name (or with the same id as the row before)
   * continues the previous case, typically adding one more step. `auto` decides from the data.
   */
  rows: z.enum(["auto", "single", "multi"]).default("auto"),
  /** Column holding the section path, e.g. `Web > Checkout > Payment`. Its levels are mapped like TestRail sections. */
  pathColumn: z.string().nullable().default(null),
  /** The user decided the file has no section path: no hints or warnings about it. */
  withoutPath: z.boolean().default(false),
  /** Separator between path levels, `auto` detects ` > `, `/`, `\\`, `»`, `::` or `|`. */
  pathSeparator: z.string().default("auto"),
  /** Trial run: only cases with these ids or names. Empty means all. */
  onlyCases: z.array(z.string()).default([]),
  /** How the scenario column is split into steps. */
  steps: z
    .object({
      format: z.enum(CSV_STEP_FORMATS).default("auto"),
      /** For `regex`: every match starts a new step, e.g. `Step\\s+\\d+[:.]`. */
      stepPattern: z.string().default(""),
      /** Lines or sub-steps starting with a match become the expected result of their step, e.g. `(?i)expected( result)?:`. */
      expectedPattern: z.string().default(""),
    })
    .prefault({}),
});
export type CsvSource = z.infer<typeof CsvSourceSchema>;
export type CsvStepFormat = (typeof CSV_STEP_FORMATS)[number];

export const TEXT_TARGETS = ["description", "precondition", "expectedResult"] as const;
export type TextTarget = (typeof TEXT_TARGETS)[number];

export const FieldTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ignore") }),
  z.object({ kind: z.literal("customField"), name: z.string().min(1) }),
  z.object({ kind: z.literal("tag") }),
  z.object({ kind: z.literal("layer") }),
  z.object({ kind: z.literal("status") }),
  z.object({ kind: z.literal("owner") }),
  z.object({ kind: z.literal("link") }),
  z.object({ kind: z.literal("issue"), integrationId: z.number().int().positive().nullable().default(null) }),
  z.object({
    kind: z.enum(TEXT_TARGETS),
    /** Optional heading written above the value, useful when several fields share one target. */
    heading: z.string().default(""),
  }),
  z.object({ kind: z.literal("comment") }),
  z.object({ kind: z.literal("scenario") }),
  /** CSV: expected results lined up with the steps of the scenario column. */
  z.object({ kind: z.literal("scenarioExpected") }),
  /** CSV: the test case name. */
  z.object({ kind: z.literal("name") }),
  /** CSV: a stable id of the case in the source; reruns find migrated cases by it. */
  z.object({ kind: z.literal("sourceId") }),
  /** CSV: id of an existing Allure TestOps test case to update, e.g. in a file exported from Allure TestOps. */
  z.object({ kind: z.literal("allureId") }),
  /** Test case members with an Allure TestOps role, e.g. Reviewer. */
  z.object({ kind: z.literal("role"), role: z.string().default("") }),
]);
export type FieldTarget = z.infer<typeof FieldTargetSchema>;
export type FieldTargetKind = FieldTarget["kind"];

export const FieldMappingSchema = z.object({
  /** TestRail field system name, e.g. `priority_id` or `custom_automation_type`. */
  source: z.string().min(1),
  target: FieldTargetSchema,
  /**
   * Value translation for fields with a closed set of values (dropdowns, priorities, users...).
   * Key is the TestRail value id as a string. A missing key means "use the TestRail label as is",
   * a null value means "skip this value".
   */
  values: z.record(z.string(), z.string().nullable()).default({}),
  /** Split free text values into several values (tags, links, issues). Empty means no split. */
  separator: z.string().default(""),
});
export type FieldMapping = z.infer<typeof FieldMappingSchema>;

export const MigrationOptionsSchema = z.object({
  /** Tag `<prefix>:<caseId>` identifies migrated cases, so reruns update instead of duplicating. Required to run; may be empty while editing. */
  migrationTagPrefix: z.string().default("testrail"),
  /** Extra tag put on every migrated case, e.g. the migration date. */
  additionalTag: z.string().default(""),
  /** Add a link back to the source case (TestRail only). */
  selfLink: z.boolean().default(true),
  /** How to read TestRail text: `auto` detects HTML produced by the new TestRail editor. */
  textFormat: z.enum(["auto", "markdown", "html"]).default("auto"),
  /** Prepend suite and section descriptions to the case description. */
  parentDescriptions: z.boolean().default(false),
  /** How a plain text steps field becomes a scenario. */
  textSteps: z.enum(["lines", "single"]).default("lines"),
  migrateAttachments: z.boolean().default(true),
  migrateSharedSteps: z.boolean().default(true),
  /** Migrate cases that were deleted in TestRail (only available for TestRail versions that expose them). */
  includeDeleted: z.boolean().default(false),
  /** Cases processed in parallel. */
  concurrency: z.number().int().min(1).max(16).default(2),
});
export type MigrationOptions = z.infer<typeof MigrationOptionsSchema>;

export const ProfileSchema = z.object({
  formatVersion: z.literal(PROFILE_FORMAT_VERSION).default(PROFILE_FORMAT_VERSION),
  id: z.string().min(1),
  name: z.string().min(1),
  source: z.enum(SOURCES).default("testrail"),
  createdAt: z.string(),
  updatedAt: z.string(),
  testrail: z.object({
    connection: TestRailConnectionSchema.prefault({}),
    scope: TestRailScopeSchema.prefault({}),
  }).prefault({}),
  csv: CsvSourceSchema.prefault({}),
  testops: z.object({
    connection: TestOpsConnectionSchema.prefault({}),
    scope: TestOpsScopeSchema.prefault({}),
  }).prefault({}),
  structure: StructureMappingSchema.prefault({}),
  fields: z.array(FieldMappingSchema).default([]),
  options: MigrationOptionsSchema.prefault({}),
});
export type Profile = z.infer<typeof ProfileSchema>;

/** Paths of secret values inside a profile. */
export const SECRET_PATHS = [
  ["testrail", "connection", "apiKey"],
  ["testrail", "connection", "sessionCookie"],
  ["testops", "connection", "apiToken"],
] as const;

type SecretOwner = Record<string, unknown>;

function secretParent(profile: unknown, path: readonly string[]): SecretOwner | undefined {
  let current: unknown = profile;
  for (const key of path.slice(0, -1)) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as SecretOwner)[key];
  }
  return current !== null && typeof current === "object" ? (current as SecretOwner) : undefined;
}

/** Returns a copy where every non-empty secret is replaced with {@link SECRET_MASK} or removed. */
export function maskSecrets<T>(profile: T, mode: "mask" | "strip" = "mask"): T {
  const copy = JSON.parse(JSON.stringify(profile)) as T;
  for (const path of SECRET_PATHS) {
    const parent = secretParent(copy, path);
    const key = path[path.length - 1]!;
    if (parent && typeof parent[key] === "string" && parent[key] !== "") {
      parent[key] = mode === "mask" ? SECRET_MASK : "";
    }
  }
  return copy;
}

/** Puts stored secrets back where the incoming profile still carries {@link SECRET_MASK}. */
export function restoreSecrets<T>(incoming: T, stored: T): T {
  const copy = JSON.parse(JSON.stringify(incoming)) as T;
  for (const path of SECRET_PATHS) {
    const parent = secretParent(copy, path);
    const storedParent = secretParent(stored, path);
    const key = path[path.length - 1]!;
    if (parent && parent[key] === SECRET_MASK) {
      parent[key] = storedParent?.[key] ?? "";
    }
  }
  return copy;
}

/** Secrets a profile needs but does not have, e.g. after importing an export without credentials. */
export function missingSecrets(profile: Profile): string[] {
  const missing: string[] = [];
  if (profile.testrail.connection.endpoint && !profile.testrail.connection.apiKey) {
    missing.push("TestRail API key");
  }
  if (profile.testops.connection.endpoint && !profile.testops.connection.apiToken) {
    missing.push("Allure TestOps API token");
  }
  return missing;
}
