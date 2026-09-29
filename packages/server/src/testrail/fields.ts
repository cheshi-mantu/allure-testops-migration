import type { TestRailFieldInfo, TestRailFieldKind, TestRailFieldOption } from "@atm/shared";
import type { TrCase, TrCaseField, TrCaseStatus, TrCaseType, TrMilestone, TrPriority, TrTemplate, TrUser } from "./types.js";

const KIND_BY_TYPE_ID: Record<number, TestRailFieldKind> = {
  1: "string",
  2: "integer",
  3: "text",
  4: "url",
  5: "checkbox",
  6: "dropdown",
  7: "user",
  8: "date",
  9: "milestone",
  10: "steps",
  12: "multiselect",
};

export interface FieldDefinition {
  systemName: string;
  label: string;
  kind: TestRailFieldKind;
  system: boolean;
  /** id -> label for fields with a closed set of values. */
  options: Map<string, string> | null;
}

export interface FieldValue {
  /** Raw value ids as strings, for option fields. */
  ids: string[];
  /** Human readable values. For text fields this holds the text itself. */
  labels: string[];
}

export interface CatalogSources {
  projectId: number;
  caseFields: TrCaseField[];
  priorities: TrPriority[];
  caseTypes: TrCaseType[];
  caseStatuses: TrCaseStatus[];
  users: TrUser[];
  milestones: TrMilestone[];
  templates: TrTemplate[];
}

/** Parses TestRail dropdown items: "1, Low\n2, Medium". */
export function parseItems(items: string | undefined): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of (items ?? "").split(/\r?\n/)) {
    const match = /^\s*([^,]+?)\s*,\s*(.*?)\s*$/.exec(line);
    if (match) {
      result.set(match[1]!, match[2]!);
    }
  }
  return result;
}

function configFor(field: TrCaseField, projectId: number) {
  const configs = field.configs ?? [];
  return (
    configs.find((config) => config.context?.project_ids?.includes(projectId)) ??
    configs.find((config) => config.context?.is_global)
  );
}

function toMap<T>(items: T[], id: (item: T) => number, label: (item: T) => string): Map<string, string> {
  return new Map(items.map((item) => [String(id(item)), label(item)]));
}

/**
 * Everything the tool knows about the fields of cases in one TestRail project:
 * which fields exist, their kind and how raw values translate to labels.
 */
export class FieldCatalog {
  readonly fields: FieldDefinition[];
  private readonly bySystemName: Map<string, FieldDefinition>;
  readonly users: TrUser[];

  constructor(sources: CatalogSources) {
    const userOptions = toMap(sources.users, (u) => u.id, (u) => u.name);
    const system: FieldDefinition[] = [
      { systemName: "type_id", label: "Type", kind: "dropdown", system: true, options: toMap(sources.caseTypes, (t) => t.id, (t) => t.name) },
      { systemName: "priority_id", label: "Priority", kind: "dropdown", system: true, options: toMap(sources.priorities, (p) => p.id, (p) => p.name) },
      { systemName: "milestone_id", label: "Milestone", kind: "milestone", system: true, options: toMap(sources.milestones, (m) => m.id, (m) => m.name) },
      { systemName: "refs", label: "References", kind: "string", system: true, options: null },
      { systemName: "estimate", label: "Estimate", kind: "string", system: true, options: null },
      { systemName: "created_by", label: "Created by", kind: "user", system: true, options: userOptions },
      { systemName: "updated_by", label: "Updated by", kind: "user", system: true, options: userOptions },
      { systemName: "template_id", label: "Template", kind: "dropdown", system: true, options: toMap(sources.templates, (t) => t.id, (t) => t.name) },
    ];
    if (sources.caseStatuses.length > 0) {
      system.push({
        systemName: "status_id",
        label: "Case status",
        kind: "dropdown",
        system: true,
        options: toMap(sources.caseStatuses, (s) => s.case_status_id, (s) => s.name),
      });
    }

    const custom: FieldDefinition[] = [];
    for (const field of sources.caseFields) {
      if (field.is_active === false) {
        continue;
      }
      const config = configFor(field, sources.projectId);
      if (!config) {
        continue; // Field is not used in this project.
      }
      const kind = KIND_BY_TYPE_ID[field.type_id] ?? "unknown";
      let options: Map<string, string> | null = null;
      if (kind === "dropdown" || kind === "multiselect") {
        options = parseItems(config.options?.items);
      } else if (kind === "checkbox") {
        options = new Map([
          ["1", "Yes"],
          ["0", "No"],
        ]);
      } else if (kind === "user") {
        options = userOptions;
      } else if (kind === "milestone") {
        options = toMap(sources.milestones, (m) => m.id, (m) => m.name);
      }
      custom.push({
        systemName: field.system_name.startsWith("custom_") ? field.system_name : `custom_${field.system_name}`,
        label: field.label,
        kind,
        system: false,
        options,
      });
    }
    this.fields = [...system, ...custom];
    this.bySystemName = new Map(this.fields.map((f) => [f.systemName, f]));
    this.users = sources.users;
  }

  get(systemName: string): FieldDefinition | undefined {
    return this.bySystemName.get(systemName);
  }

  /** Values of a field on a case, translated to labels where possible. */
  value(testCase: TrCase, systemName: string): FieldValue {
    const field = this.get(systemName);
    const raw = testCase[systemName];
    if (raw === null || raw === undefined || raw === "") {
      return { ids: [], labels: [] };
    }
    if (field?.kind === "steps") {
      return { ids: [], labels: Array.isArray(raw) && raw.length > 0 ? [`${raw.length} step(s)`] : [] };
    }
    if (field?.kind === "checkbox") {
      const id = raw === true || raw === 1 || raw === "1" ? "1" : "0";
      return { ids: [id], labels: [field.options?.get(id) ?? id] };
    }
    if (field?.options) {
      const ids = (Array.isArray(raw) ? raw : [raw]).map((v) => String(v)).filter((v) => v !== "");
      return { ids, labels: ids.map((id) => field.options?.get(id) ?? id) };
    }
    if (field?.kind === "date" && typeof raw === "string") {
      return { ids: [], labels: [raw] };
    }
    const text = typeof raw === "string" ? raw : String(raw);
    return { ids: [], labels: text.trim() === "" ? [] : [text] };
  }

  toInfo(stats: Map<string, { filled: number; counts: Map<string, number>; examples: string[] }>): TestRailFieldInfo[] {
    return this.fields.map((field) => {
      const stat = stats.get(field.systemName);
      const options: TestRailFieldOption[] | null = field.options
        ? [...field.options.entries()].map(([id, label]) => {
            const email = field.kind === "user" ? this.users.find((u) => String(u.id) === id)?.email : undefined;
            return { id, label, count: stat?.counts.get(id) ?? 0, ...(email ? { email } : {}) };
          })
        : null;
      return {
        systemName: field.systemName,
        label: field.label,
        kind: field.kind,
        system: field.system,
        options,
        filledCount: stat?.filled ?? 0,
        examples: stat?.examples ?? [],
      };
    });
  }
}

const EXAMPLE_LIMIT = 3;
const EXAMPLE_LENGTH = 160;

/** Collects per-field usage from sampled cases. */
export function collectStats(catalog: FieldCatalog, cases: TrCase[]) {
  const stats = new Map<string, { filled: number; counts: Map<string, number>; examples: string[] }>();
  for (const field of catalog.fields) {
    stats.set(field.systemName, { filled: 0, counts: new Map(), examples: [] });
  }
  for (const testCase of cases) {
    for (const field of catalog.fields) {
      const value = catalog.value(testCase, field.systemName);
      if (value.labels.length === 0) {
        continue;
      }
      const stat = stats.get(field.systemName)!;
      stat.filled += 1;
      for (const id of value.ids) {
        stat.counts.set(id, (stat.counts.get(id) ?? 0) + 1);
      }
      if (field.options === null && stat.examples.length < EXAMPLE_LIMIT) {
        const example = value.labels
          .join(", ")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, EXAMPLE_LENGTH);
        if (example && !stat.examples.includes(example)) {
          stat.examples.push(example);
        }
      }
    }
  }
  return stats;
}
