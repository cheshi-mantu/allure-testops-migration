/** Xray Cloud GraphQL payloads, only the parts the migration uses. */
import type { JiraIssue } from "../jira/types.js";

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
