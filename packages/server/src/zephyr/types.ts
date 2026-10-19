/** Zephyr Cloud REST API v2 payloads, only the parts the migration uses. */

export interface ZephyrRef {
  id: number;
  self?: string;
}

export interface ZephyrPage<T> {
  next?: string | null;
  startAt?: number;
  maxResults?: number;
  total?: number;
  isLast?: boolean;
  values?: T[];
}

export interface ZephyrProject {
  id: number;
  /** Jira project key. */
  key: string;
  jiraProjectId?: number;
  enabled?: boolean;
}

export interface ZephyrFolder {
  id: number;
  /** Null for a folder at the top. */
  parentId: number | null;
  name: string;
  index?: number;
  folderType?: string;
}

/** A status or a priority of a project. */
export interface ZephyrOption {
  id: number;
  name: string;
  description?: string | null;
  color?: string | null;
  default?: boolean;
  archived?: boolean;
}

export interface ZephyrIssueLink {
  id?: number;
  /** Jira issue id; Jira gives the key. */
  issueId: number;
  type?: string;
}

export interface ZephyrWebLink {
  id?: number;
  url: string;
  description?: string | null;
  type?: string;
}

export interface ZephyrTestCase {
  id: number;
  /** E.g. CALC-T12. */
  key: string;
  name: string;
  project?: ZephyrRef;
  createdOn?: string | null;
  /** Rich text (HTML). */
  objective?: string | null;
  precondition?: string | null;
  /** Milliseconds. */
  estimatedTime?: number | null;
  labels?: string[] | null;
  component?: ZephyrRef | null;
  priority?: ZephyrRef | null;
  status?: ZephyrRef | null;
  folder?: ZephyrRef | null;
  owner?: { accountId?: string | null; self?: string } | null;
  /** `self` ends with `/teststeps` or `/testscript`: which of them the case has. */
  testScript?: { self?: string } | null;
  /** Custom field name -> value: text, HTML, number, boolean, `yyyy-MM-dd`, account id, or a list. */
  customFields?: Record<string, unknown> | null;
  links?: { self?: string; issues?: ZephyrIssueLink[] | null; webLinks?: ZephyrWebLink[] | null } | null;
}

export interface ZephyrStepParameter {
  name: string;
  type?: string;
  value?: string | null;
}

export interface ZephyrTestStep {
  /** Step id, for its files. Older answers may leave it out. */
  id?: number | null;
  inline?: {
    description?: string | null;
    testData?: string | null;
    expectedResult?: string | null;
    customFields?: Record<string, unknown> | null;
  } | null;
  /** A step that calls another test case. */
  testCase?: { testCaseKey: string; self?: string; parameters?: ZephyrStepParameter[] | null } | null;
}

export interface ZephyrTestScript {
  id?: number;
  type: "plain" | "bdd" | string;
  text: string;
}

export interface ZephyrAttachment {
  id: number | string;
  name: string;
}

/** One test case with everything read for it. */
export interface ZephyrCase {
  testCase: ZephyrTestCase;
  steps: ZephyrTestStep[];
  script: ZephyrTestScript | null;
  attachments: ZephyrAttachment[];
  /** Step id -> files of the step. */
  stepAttachments: Map<string, ZephyrAttachment[]>;
}

/** Jira user details for account ids. */
export interface ZephyrUser {
  accountId: string;
  displayName: string;
  email: string | null;
}
