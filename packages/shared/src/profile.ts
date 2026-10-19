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

/** Xray Cloud regions; the API key works only against the region of the Jira site. */
export const XRAY_REGIONS = [
  { value: "https://xray.cloud.getxray.app", label: "Global (xray.cloud.getxray.app)" },
  { value: "https://us.xray.cloud.getxray.app", label: "United States" },
  { value: "https://eu.xray.cloud.getxray.app", label: "European Union" },
  { value: "https://au.xray.cloud.getxray.app", label: "Australia" },
] as const;

/**
 * Xray Cloud keeps test details (type, steps, definitions, folders, preconditions, sets, plans) and
 * Jira keeps the issue (summary, description, labels, custom fields, comments, links, attachments):
 * a migration reads both.
 */
export const XrayConnectionSchema = z.object({
  /** Xray Cloud API base URL, see {@link XRAY_REGIONS}. */
  endpoint: z.string().default("https://xray.cloud.getxray.app"),
  /** Xray API key: client id and client secret (Jira settings, Apps, Xray, API Keys). */
  clientId: z.string().default(""),
  clientSecret: z.string().default(""),
  /** Jira Cloud site, e.g. https://yourcompany.atlassian.net. */
  jiraUrl: z.string().default(""),
  jiraEmail: z.string().default(""),
  /** Atlassian API token of the Jira user. */
  jiraApiToken: z.string().default(""),
});
export type XrayConnection = z.infer<typeof XrayConnectionSchema>;

export const XrayScopeSchema = z.object({
  /** Jira project key, e.g. CALC. */
  projectKey: z.string().default(""),
  /** Narrows the tests with JQL, e.g. `labels = regression`. Combined with the project. */
  jql: z.string().default(""),
  /** When not empty only these tests (issue keys) are migrated. */
  issueKeys: z.array(z.string()).default([]),
});
export type XrayScope = z.infer<typeof XrayScopeSchema>;

/**
 * Qase limits API requests per workspace, by plan: this many per minute and a sixth of it in any
 * 10 seconds. The tool paces itself below the limit of the chosen plan.
 */
export const QASE_RATE_LIMITS = { free: 150, startup: 300, business: 600, enterprise: 1000 } as const;

export const QaseConnectionSchema = z.object({
  /** Qase API address without the version, e.g. https://api.qase.io. */
  endpoint: z.string().default("https://api.qase.io"),
  /** API token (Qase, Apps or personal settings, API tokens). */
  apiToken: z.string().default(""),
  /** Address people open Qase at, used for links back to the cases. */
  appUrl: z.string().default("https://app.qase.io"),
  rateLimit: z.enum(["free", "startup", "business", "enterprise"]).default("free"),
  insecureTls: z.boolean().default(false),
});
export type QaseConnection = z.infer<typeof QaseConnectionSchema>;

export const QaseScopeSchema = z.object({
  /** Qase project code, e.g. DEMO. */
  projectCode: z.string().default(""),
  /** Only cases of these suites and of the suites inside them. Empty means the whole project. */
  suiteIds: z.array(z.number().int().positive()).default([]),
  /** When not empty only these cases are migrated. */
  caseIds: z.array(z.number().int().positive()).default([]),
});
export type QaseScope = z.infer<typeof QaseScopeSchema>;

/**
 * Addresses of the Zephyr Cloud REST API v2 (formerly Zephyr Scale). Zephyr Essential (the new
 * Zephyr Squad, built on the same platform) answers the same API at its own address.
 */
export const ZEPHYR_REGIONS = [
  { value: "https://api.zephyrscale.smartbear.com/v2", label: "Zephyr, default region (api.zephyrscale.smartbear.com)" },
  { value: "https://eu.api.zephyrscale.smartbear.com/v2", label: "Zephyr, European Union" },
  { value: "https://au.api.zephyrscale.smartbear.com/v2", label: "Zephyr, Australia" },
  { value: "https://de.api.zephyrscale.smartbear.com/v2", label: "Zephyr, Germany" },
  { value: "https://prod-api.zephyr4jiracloud.com/v2", label: "Zephyr Essential (prod-api.zephyr4jiracloud.com)" },
] as const;

/**
 * Zephyr keeps the test cases (folders, steps, scripts, statuses, custom fields, files); Jira knows
 * the issues they cover, the users and the components: a migration reads both.
 */
export const ZephyrConnectionSchema = z.object({
  /** Zephyr REST API v2 address, see {@link ZEPHYR_REGIONS}. */
  endpoint: z.string().default("https://api.zephyrscale.smartbear.com/v2"),
  /** Zephyr API access token (Jira, your profile menu, Zephyr API keys). */
  apiToken: z.string().default(""),
  /** Jira Cloud site, e.g. https://yourcompany.atlassian.net. */
  jiraUrl: z.string().default(""),
  jiraEmail: z.string().default(""),
  /** Atlassian API token of the Jira user. */
  jiraApiToken: z.string().default(""),
  /** Zephyr does not publish its limits; the tool paces itself to this many requests per minute and waits when asked to. */
  requestsPerMinute: z.number().int().min(10).max(6000).default(300),
});
export type ZephyrConnection = z.infer<typeof ZephyrConnectionSchema>;

export const ZephyrScopeSchema = z.object({
  /** Jira project key, e.g. CALC. */
  projectKey: z.string().default(""),
  /** Only test cases of these folders and of the folders inside them. Empty means the whole project. */
  folderIds: z.array(z.number().int().positive()).default([]),
  /** When not empty only these test cases (keys such as CALC-T12) are migrated. */
  testCaseKeys: z.array(z.string()).default([]),
  /** Files of steps need one more request per step; without them a migration is faster. */
  stepFiles: z.boolean().default(true),
});
export type ZephyrScope = z.infer<typeof ZephyrScopeSchema>;

/** The API of the old Zephyr Squad, where tests are Jira issues of type Test. */
export const SQUAD_ENDPOINT = "https://prod-api.zephyr4jiracloud.com/connect";

/**
 * The old Zephyr Squad (now shown as Zephyr Essential in Jira, but not yet moved to the new
 * experience): Jira keeps the test issue (summary, description, fields, comments, links,
 * attachments), the Zephyr Squad API (ZAPI) keeps the test steps.
 */
export const SquadConnectionSchema = z.object({
  /** Zephyr Squad API address, see {@link SQUAD_ENDPOINT}. */
  endpoint: z.string().default(SQUAD_ENDPOINT),
  /** API keys of a Jira user (Jira, Apps, Zephyr Squad, API keys): the access key and the secret key. */
  accessKey: z.string().default(""),
  secretKey: z.string().default(""),
  /** Jira Cloud site, e.g. https://yourcompany.atlassian.net. */
  jiraUrl: z.string().default(""),
  /** The Jira user the API keys belong to: requests to Zephyr Squad are signed for this account. */
  jiraEmail: z.string().default(""),
  /** Atlassian API token of the Jira user. */
  jiraApiToken: z.string().default(""),
  /** Zephyr Squad limits requests per user per minute without saying how many; the tool paces itself and waits when asked to. */
  requestsPerMinute: z.number().int().min(10).max(6000).default(300),
});
export type SquadConnection = z.infer<typeof SquadConnectionSchema>;

export const SquadScopeSchema = z.object({
  /** Jira project key, e.g. CALC. */
  projectKey: z.string().default(""),
  /** Jira issue type of the tests. */
  issueType: z.string().default("Test"),
  /** Narrows the tests with JQL, e.g. `labels = regression`. Combined with the project and the issue type. */
  jql: z.string().default(""),
  /** When not empty only these tests (issue keys) are migrated. */
  issueKeys: z.array(z.string()).default([]),
  /** Files of steps the step list does not name are looked up step by step; without them reading is faster. */
  stepFiles: z.boolean().default(true),
});
export type SquadScope = z.infer<typeof SquadScopeSchema>;

export const ALM_AUTH = ["password", "apiKey"] as const;

/** OpenText (Micro Focus, HP) ALM / Quality Center, read through its REST API. */
export const AlmConnectionSchema = z.object({
  /** Address of ALM, e.g. https://alm.example.com/qcbin. */
  endpoint: z.string().default(""),
  /** `password`: user name and password. `apiKey`: client id and secret of an API key (ALM 12.60 and later). */
  auth: z.enum(ALM_AUTH).default("password"),
  username: z.string().default(""),
  password: z.string().default(""),
  clientId: z.string().default(""),
  secret: z.string().default(""),
  insecureTls: z.boolean().default(false),
});
export type AlmConnection = z.infer<typeof AlmConnectionSchema>;

export const AlmScopeSchema = z.object({
  domain: z.string().default(""),
  project: z.string().default(""),
  /** Only tests of these Test Plan folders and of the folders inside them. Empty means the whole project. */
  folderIds: z.array(z.number().int().positive()).default([]),
  /** When not empty only these tests are migrated. */
  testIds: z.array(z.number().int().positive()).default([]),
});
export type AlmScope = z.infer<typeof AlmScopeSchema>;

export const TestRailScopeSchema = z.object({
  projectId: z.number().int().positive().nullable().default(null),
  /** Empty means all suites of the project. */
  suiteIds: z.array(z.number().int().positive()).default([]),
  /** When not empty only these cases are migrated. */
  caseIds: z.array(z.number().int().positive()).default([]),
});
export type TestRailScope = z.infer<typeof TestRailScopeSchema>;

/** A project of the source Allure TestOps and the project of the target it goes to. */
export const TestOpsProjectPairSchema = z.object({
  sourceId: z.number().int().positive(),
  sourceName: z.string(),
  /** Name of the target project: found by this name, or created with it. */
  targetName: z.string(),
});
export type TestOpsProjectPair = z.infer<typeof TestOpsProjectPairSchema>;

/**
 * Another Allure TestOps instance as the source: the chosen projects are copied one to one, each
 * into a project of the target with the same name.
 */
export const TestOpsSourceSchema = z.object({
  connection: z
    .object({
      endpoint: z.string().default(""),
      apiToken: z.string().default(""),
      insecureTls: z.boolean().default(false),
    })
    .prefault({}),
  projects: z.array(TestOpsProjectPairSchema).default([]),
  /** Integration of the source (issue tracker or test management system) by id -> integration of the target; null skips it. */
  integrations: z.record(z.string(), z.number().int().positive().nullable()).default({}),
  /** Trial run: only these test cases (ids in the source). Empty means all. */
  caseIds: z.array(z.number().int().positive()).default([]),
  /** Which test cases are migrated by their automated flag; both by default. */
  manual: z.boolean().default(true),
  automated: z.boolean().default(true),
});
export type TestOpsSource = z.infer<typeof TestOpsSourceSchema>;

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

export const SOURCES = ["testrail", "csv", "xray", "zephyr", "squad", "xml", "qase", "alm", "testops"] as const;
export type SourceType = (typeof SOURCES)[number];

/** Sources that read an uploaded file instead of connecting to a system. */
export function isFileSource(source: SourceType): source is "csv" | "xml" {
  return source === "csv" || source === "xml";
}

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

/**
 * How an XML export is read. The structure is found in the file: the element that repeats per test
 * case, the named elements around it (suites, sections, folders) and the list of steps inside it.
 */
export const XML_FILE_AUTH = ["basic", "header", "none"] as const;

/**
 * An XML file holds the addresses of attached files and images, not the files. With `download` on,
 * they are read from the system that serves them and attached to the cases.
 */
export const XmlFilesSchema = z.object({
  download: z.boolean().default(false),
  /** Address of the system that serves the files. Files are downloaded only from it; credentials go nowhere else. */
  endpoint: z.string().default(""),
  auth: z.enum(XML_FILE_AUTH).default("basic"),
  username: z.string().default(""),
  /** Password or API key of the user. */
  password: z.string().default(""),
  /** `header` authentication: a request header such as `Authorization: Bearer ...` or `Cookie: ...`. */
  headerName: z.string().default("Authorization"),
  headerValue: z.string().default(""),
  insecureTls: z.boolean().default(false),
});
export type XmlFiles = z.infer<typeof XmlFilesSchema>;

export const XmlSourceSchema = z.object({
  /** File in the tool's file library (data volume). */
  fileId: z.string().nullable().default(null),
  /** Element that holds one test case, e.g. `case` or `testcase`. Null detects it. */
  caseElement: z.string().nullable().default(null),
  /** Trial run: only cases with these ids or names. Empty means all. */
  onlyCases: z.array(z.string()).default([]),
  /** How a text field mapped to the scenario is split into steps; lists of step elements need no settings. */
  steps: z
    .object({
      format: z.enum(CSV_STEP_FORMATS).default("auto"),
      stepPattern: z.string().default(""),
      expectedPattern: z.string().default(""),
    })
    .prefault({}),
  files: XmlFilesSchema.prefault({}),
});
export type XmlSource = z.infer<typeof XmlSourceSchema>;

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
  /** XML: addresses of files to attach to the case; they stay links when files are not downloaded. */
  z.object({ kind: z.literal("attachment") }),
  /** Sets of parameter values that become examples of the test case, e.g. Qase parameters. */
  z.object({ kind: z.literal("examples") }),
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
  /** Add a link back to the source case (TestRail, Xray, Zephyr, Qase). ALM tests have no web address, so ALM ignores it. */
  selfLink: z.boolean().default(true),
  /** How to read TestRail text: `auto` detects HTML produced by the new TestRail editor. */
  textFormat: z.enum(["auto", "markdown", "html"]).default("auto"),
  /** Prepend suite and section descriptions to the case description. TestRail only. */
  parentDescriptions: z.boolean().default(false),
  /** How a plain text steps field becomes a scenario. */
  textSteps: z.enum(["lines", "single"]).default("lines"),
  /** Tables of Gherkin Examples: a Markdown file of the "Examples" step, or examples of the test case. */
  gherkinExamples: z.enum(["attachment", "examples"]).default("attachment"),
  migrateAttachments: z.boolean().default(true),
  migrateSharedSteps: z.boolean().default(true),
  /** Migrate cases that were deleted in TestRail (only available for TestRail versions that expose them). */
  includeDeleted: z.boolean().default(false),
  /**
   * Integration that receives the source key of every case as an Allure TestOps test key (Xray: the
   * issue key). Null writes no test keys.
   */
  testKeyIntegrationId: z.number().int().positive().nullable().default(null),
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
  xml: XmlSourceSchema.prefault({}),
  xray: z.object({
    connection: XrayConnectionSchema.prefault({}),
    scope: XrayScopeSchema.prefault({}),
  }).prefault({}),
  zephyr: z.object({
    connection: ZephyrConnectionSchema.prefault({}),
    scope: ZephyrScopeSchema.prefault({}),
    /**
     * Requests to Zephyr and Jira, the structure of their answers (field names and kinds of values,
     * not the text of test cases) and what was read for every test case go to the run log at the debug level.
     */
    detailedLog: z.boolean().default(true),
  }).prefault({}),
  squad: z.object({
    connection: SquadConnectionSchema.prefault({}),
    scope: SquadScopeSchema.prefault({}),
    /**
     * Requests to Zephyr Squad, the structure of their answers (field names and kinds of values, not
     * the text of tests) and what was read for every test go to the run log at the debug level.
     */
    detailedLog: z.boolean().default(true),
  }).prefault({}),
  qase: z.object({
    connection: QaseConnectionSchema.prefault({}),
    scope: QaseScopeSchema.prefault({}),
  }).prefault({}),
  alm: z.object({
    connection: AlmConnectionSchema.prefault({}),
    scope: AlmScopeSchema.prefault({}),
    /**
     * Requests to ALM, the structure of its answers (field names and kinds of values, not the text of
     * tests) and what was read for every test go to the run log at the debug level.
     */
    detailedLog: z.boolean().default(true),
  }).prefault({}),
  testops: z.object({
    connection: TestOpsConnectionSchema.prefault({}),
    scope: TestOpsScopeSchema.prefault({}),
  }).prefault({}),
  /** Source Allure TestOps, for profiles whose source is "testops"; `testops` above is always the target. */
  testopsSource: TestOpsSourceSchema.prefault({}),
  structure: StructureMappingSchema.prefault({}),
  fields: z.array(FieldMappingSchema).default([]),
  options: MigrationOptionsSchema.prefault({}),
});
export type Profile = z.infer<typeof ProfileSchema>;

/** Paths of secret values inside a profile. */
export const SECRET_PATHS = [
  ["testrail", "connection", "apiKey"],
  ["testrail", "connection", "sessionCookie"],
  ["xray", "connection", "clientSecret"],
  ["xray", "connection", "jiraApiToken"],
  ["zephyr", "connection", "apiToken"],
  ["zephyr", "connection", "jiraApiToken"],
  ["squad", "connection", "secretKey"],
  ["squad", "connection", "jiraApiToken"],
  ["xml", "files", "password"],
  ["xml", "files", "headerValue"],
  ["qase", "connection", "apiToken"],
  ["alm", "connection", "password"],
  ["alm", "connection", "secret"],
  ["testopsSource", "connection", "apiToken"],
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
