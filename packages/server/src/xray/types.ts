/** Jira Cloud REST v3 and Xray Cloud GraphQL payloads, only the parts the migration uses. */

export interface JiraField {
  id: string;
  name: string;
  custom: boolean;
  schema?: { type: string; items?: string; system?: string; custom?: string };
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
}

export interface JiraUser {
  accountId: string;
  displayName?: string;
  emailAddress?: string;
}

export interface JiraAttachment {
  id: string;
  filename: string;
  mimeType?: string;
  size?: number;
  /** Download URL; needs Jira credentials. */
  content: string;
}

export interface JiraIssueLink {
  type: { name: string; inward: string; outward: string };
  inwardIssue?: { key: string; fields?: { summary?: string } };
  outwardIssue?: { key: string; fields?: { summary?: string } };
}

export interface JiraComment {
  id: string;
  author?: JiraUser;
  created?: string;
}

export interface JiraIssue {
  id: string;
  key: string;
  /** Raw field values by field id. */
  fields: Record<string, unknown>;
  /** Rich text fields as HTML (search with `expand: renderedFields`). */
  renderedFields?: Record<string, unknown>;
}

export interface JiraSearchPage {
  issues: JiraIssue[];
  nextPageToken?: string;
  isLast?: boolean;
}

export interface XrayAttachment {
  id: string;
  filename: string;
  storedInJira?: boolean;
  downloadLink: string;
}

export interface XrayStep {
  id: string;
  action?: string | null;
  data?: string | null;
  result?: string | null;
  attachments?: XrayAttachment[] | null;
  customFields?: { id?: string; name?: string; value?: unknown }[] | null;
  /** Set when the step calls another test. */
  callTestIssueId?: string | null;
}

export interface XrayLinkedIssue {
  issueId: string;
  jira?: { key?: string; summary?: string } | null;
}

export interface XrayPrecondition extends XrayLinkedIssue {
  preconditionType?: { name?: string; kind?: string } | null;
  definition?: string | null;
}

export interface XrayResults<T> {
  total: number;
  results: T[];
}

export interface XrayTest {
  issueId: string;
  projectId?: string;
  testType?: { name: string; kind: "Steps" | "Gherkin" | "Unstructured" | string } | null;
  steps?: XrayStep[] | null;
  unstructured?: string | null;
  gherkin?: string | null;
  scenarioType?: string | null;
  folder?: { name?: string; path?: string } | null;
  preconditions?: XrayResults<XrayPrecondition> | null;
  testSets?: XrayResults<XrayLinkedIssue> | null;
  testPlans?: XrayResults<XrayLinkedIssue> | null;
  jira?: { key?: string; summary?: string } | null;
  lastModified?: string | null;
}

/** One Xray test with its Jira issue. */
export interface XrayCase {
  issue: JiraIssue;
  test: XrayTest;
}
