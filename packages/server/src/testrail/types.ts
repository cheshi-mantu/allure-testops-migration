/** TestRail API v2 payloads, only the parts the migration reads. */

export interface TrProject {
  id: number;
  name: string;
  announcement?: string | null;
  is_completed?: boolean;
  /** 1 single suite, 2 single suite with baselines, 3 multiple suites. */
  suite_mode: number;
  url?: string;
}

export interface TrSuite {
  id: number;
  name: string;
  description?: string | null;
  project_id: number;
  is_master?: boolean;
  is_baseline?: boolean;
  is_completed?: boolean;
}

export interface TrSection {
  id: number;
  suite_id: number | null;
  name: string;
  description?: string | null;
  parent_id: number | null;
  display_order?: number;
  depth: number;
}

/** A case has fixed properties plus any number of `custom_*` fields. */
export interface TrCase {
  id: number;
  title: string;
  section_id: number;
  suite_id: number;
  template_id?: number;
  type_id?: number | null;
  priority_id?: number | null;
  milestone_id?: number | null;
  refs?: string | null;
  created_by?: number;
  created_on?: number;
  updated_by?: number;
  updated_on?: number;
  estimate?: string | null;
  is_deleted?: number;
  [field: string]: unknown;
}

export interface TrStep {
  content?: string | null;
  expected?: string | null;
  additional_info?: string | null;
  refs?: string | null;
  shared_step_id?: number | null;
}

export interface TrSharedStep {
  id: number;
  title: string;
  project_id?: number;
  custom_steps_separated?: TrStep[] | null;
  [field: string]: unknown;
}

export interface TrFieldConfig {
  id?: string;
  context?: { is_global?: boolean; project_ids?: number[] | null };
  options?: { is_required?: boolean; default_value?: string; items?: string; format?: string; rows?: string };
}

export interface TrCaseField {
  id: number;
  system_name: string;
  name: string;
  label: string;
  description?: string | null;
  type_id: number;
  is_active?: boolean;
  include_all?: boolean;
  template_ids?: number[];
  configs?: TrFieldConfig[];
}

export interface TrPriority {
  id: number;
  name: string;
  short_name?: string;
  priority?: number;
  is_default?: boolean;
}

export interface TrCaseType {
  id: number;
  name: string;
  is_default?: boolean;
}

export interface TrCaseStatus {
  case_status_id: number;
  name: string;
  abbreviation?: string;
  is_default?: boolean;
}

export interface TrUser {
  id: number;
  name: string;
  email?: string;
  is_active?: boolean;
}

export interface TrMilestone {
  id: number;
  name: string;
  milestones?: TrMilestone[];
}

export interface TrTemplate {
  id: number;
  name: string;
}

export interface TrAttachment {
  /** Numeric in old TestRail versions, a string in TestRail 7.1+. */
  id: string | number;
  /** Numeric id that inline references use on some TestRail versions. */
  data_id?: string | number | null;
  name?: string | null;
  filename?: string | null;
  filetype?: string | null;
  size?: number;
  cassandra_file_id?: string | null;
}
