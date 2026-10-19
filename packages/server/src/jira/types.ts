/** Jira Cloud REST v3 payloads, only the parts the migrations use. */

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

