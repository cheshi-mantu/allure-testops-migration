/** Shapes of the Qase REST API v1, as far as the migration reads them. Empty values are left out by Qase. */

export interface QasePage<T> {
  total: number;
  filtered: number;
  count: number;
  entities: T[];
}

export interface QaseProject {
  title: string;
  code: string;
  counts?: { cases?: number; suites?: number };
}

export interface QaseSuite {
  id: number;
  title: string;
  description?: string | null;
  preconditions?: string | null;
  position?: number;
  parent_id?: number | null;
  cases_count?: number;
}

export interface QaseAttachment {
  hash?: string;
  filename: string;
  mime?: string;
  size?: number;
  url: string;
}

export interface QaseStep {
  /** Set on steps that come from a shared step; steps of one shared step follow each other. */
  shared_step_hash?: string | null;
  /** The step of the shared step this one stands for. */
  shared_step_nested_hash?: string | null;
  position?: number;
  /** A classic step, or the whole scenario of a Gherkin case. */
  action?: string | null;
  expected_result?: string | null;
  data?: string | null;
  attachments?: QaseAttachment[];
  steps?: QaseStep[];
}

/** A shared parameter comes resolved, with its `shared_id`. */
export type QaseParameter =
  | { type: "single"; shared_id?: string | null; item: { title: string; values: string[] } }
  | { type: "group"; shared_id?: string | null; items: { title: string; values: string[] }[] }
  | { type: "shared"; shared_id?: string | null };

export interface QaseCase {
  id: number;
  title: string;
  description?: string | null;
  preconditions?: string | null;
  postconditions?: string | null;
  severity?: number;
  priority?: number;
  type?: number;
  layer?: number;
  is_flaky?: number;
  behavior?: number;
  /** 0 manual, 1 to be automated, 2 automated. */
  automation?: number;
  isManual?: boolean;
  isToBeAutomated?: boolean;
  status?: number;
  milestone_id?: number | null;
  suite_id?: number | null;
  /** One entry per value: a multi-select field repeats its id. */
  custom_fields?: { id: number; value: string | null }[];
  attachments?: QaseAttachment[];
  steps_type?: "classic" | "gherkin" | null;
  steps?: QaseStep[];
  parameters?: QaseParameter[];
  tags?: { title: string; internal_id?: number }[];
  /** Id of the user who created the case. */
  member_id?: number;
  author_id?: number;
  external_issues?: { type: string; issues: { id: string; link?: string }[] }[];
  created_at?: string;
  updated_at?: string;
}

export interface QaseSharedStep {
  hash: string;
  title: string;
  steps?: QaseStep[];
  action?: string;
  expected_result?: string;
  data?: string;
}

export interface QaseCustomField {
  id: number;
  title: string;
  entity: string;
  /** number, string, text, selectbox, checkbox, radio, multiselect, url, user or datetime, in any letter case. */
  type: string;
  /** Options of select fields as JSON: `[{"id": 1, "title": "Chrome"}]`. */
  value?: string | null;
  is_enabled_for_all_projects?: boolean;
  projects_codes?: string[];
}

export interface QaseSystemField {
  title: string;
  slug: string;
  options?: { id: number; title: string; slug: string }[] | null;
}

export interface QaseMilestone {
  id: number;
  title: string;
}

export interface QaseAuthor {
  id: number;
  author_id: number;
  /** "user" for people; `entity_id` is then the user id. */
  entity_type?: string;
  entity_id?: number;
  email?: string;
  name?: string;
  is_active?: boolean;
}

export interface QaseUser {
  id: number;
  name: string;
  email?: string;
  status?: number;
}
