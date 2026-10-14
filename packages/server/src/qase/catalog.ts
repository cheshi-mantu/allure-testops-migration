import type { FieldTarget, SourceFieldInfo, SourceFieldKind, TestRailFieldOption } from "@atm/shared";
import type { QaseAuthor, QaseCase, QaseCustomField, QaseMilestone, QaseParameter, QaseSystemField, QaseUser } from "./types.js";

/** Values of a field on one case. */
export interface QaseValue {
  /** Value ids for fields with a closed set of values (option id, user id). */
  ids: string[];
  /** Human readable values, in the order of `ids` when there are ids. */
  labels: string[];
  /** Users seen in the value: id -> email, for owner matching. */
  emails?: Map<string, string>;
}

export interface QaseFieldDefinition {
  systemName: string;
  label: string;
  kind: SourceFieldKind;
  /** A Qase system field rather than a custom field. */
  system: boolean;
  /** Values are a closed set worth a value table. */
  closed: boolean;
  suggested: FieldTarget;
  /** First translation of values, by value id; null skips the value. */
  suggestedValues?: Record<string, string | null>;
  /** Shown even when empty in every sampled case. */
  always?: boolean;
}

export interface QaseCatalogData {
  systemFields: QaseSystemField[];
  /** Custom fields of test cases enabled for the project. */
  customFields: QaseCustomField[];
  milestones: QaseMilestone[];
  authors: QaseAuthor[];
  users: QaseUser[];
}

/** System fields with a list of values: slug, field name and where it goes by default. */
const ENUMS: { slug: string; label: string; suggested: FieldTarget; kind?: SourceFieldKind }[] = [
  { slug: "severity", label: "Severity", suggested: { kind: "customField", name: "Severity" } },
  { slug: "priority", label: "Priority", suggested: { kind: "customField", name: "Priority" } },
  { slug: "type", label: "Type", suggested: { kind: "customField", name: "Type" } },
  { slug: "behavior", label: "Behavior", suggested: { kind: "customField", name: "Behavior" } },
  { slug: "layer", label: "Layer", suggested: { kind: "layer" } },
  { slug: "status", label: "Status", suggested: { kind: "status" } },
  { slug: "automation", label: "Automation status", suggested: { kind: "customField", name: "Automation" } },
  { slug: "is_flaky", label: "Is flaky", suggested: { kind: "customField", name: "Flaky" }, kind: "checkbox" },
];

/** Qase statuses by the names of the default Allure TestOps workflow. */
const STATUS_NAMES: Record<string, string> = { actual: "Active", draft: "Draft", deprecated: "Outdated" };

const CUSTOM_PREFIX = "qase:cf:";

function customKind(type: string): SourceFieldKind {
  switch (type.toLowerCase()) {
    case "number":
      return "integer";
    case "string":
      return "string";
    case "text":
      return "text";
    case "selectbox":
    case "radio":
      return "dropdown";
    case "multiselect":
      return "multiselect";
    case "checkbox":
      return "checkbox";
    case "url":
      return "url";
    case "user":
      return "user";
    case "datetime":
      return "date";
    default:
      return "unknown";
  }
}

function customSuggestion(field: QaseCustomField, kind: SourceFieldKind): FieldTarget {
  switch (kind) {
    case "text":
      return { kind: "description", heading: field.title };
    case "url":
      return { kind: "link" };
    case "date":
    case "unknown":
      return { kind: "ignore" };
    default:
      return { kind: "customField", name: field.title };
  }
}

function parseOptions(field: QaseCustomField): Map<string, string> {
  try {
    const options = JSON.parse(field.value ?? "[]") as { id: number | string; title: string }[];
    return new Map(Array.isArray(options) ? options.map((option) => [String(option.id), String(option.title)]) : []);
  } catch {
    return new Map();
  }
}

/** Parameters of a case as Markdown: a line per parameter, a table per group of parameters. */
export function parametersText(parameters: QaseParameter[] | undefined): string {
  const blocks: string[] = [];
  for (const parameter of parameters ?? []) {
    if (parameter.type === "single" && parameter.item) {
      blocks.push(`- **${parameter.item.title}**: ${parameter.item.values.join(", ")}`);
    } else if (parameter.type === "group" && parameter.items?.length) {
      const rows = Math.max(...parameter.items.map((item) => item.values.length));
      const line = (cells: string[]) => `| ${cells.map((cell) => cell.replace(/\|/g, "\\|")).join(" | ")} |`;
      blocks.push(
        [
          line(parameter.items.map((item) => item.title)),
          line(parameter.items.map(() => "---")),
          ...Array.from({ length: rows }, (_unused, row) => line(parameter.items.map((item) => item.values[row] ?? ""))),
        ].join("\n"),
      );
    } else if (parameter.type === "shared") {
      blocks.push("- A shared parameter of the Qase project");
    }
  }
  // Lines of single parameters stay one list; tables need an empty line around them.
  return blocks.reduce((text, block, index) => text + (index === 0 ? "" : block.startsWith("-") && blocks[index - 1]!.startsWith("-") ? "\n" : "\n\n") + block, "");
}

/** Every attribute of a Qase case as a mappable field. */
export class QaseCatalog {
  readonly fields: QaseFieldDefinition[];
  private readonly byName = new Map<string, QaseFieldDefinition>();
  private readonly enumOptions = new Map<string, Map<string, string>>();
  private readonly customOptions = new Map<number, Map<string, string>>();
  private readonly custom = new Map<number, QaseCustomField>();
  private readonly users: Map<string, QaseUser>;
  private readonly authors: Map<string, QaseAuthor>;
  private readonly milestones: Map<string, string>;

  constructor(data: QaseCatalogData) {
    this.users = new Map(data.users.map((user) => [String(user.id), user]));
    this.authors = new Map(data.authors.map((author) => [String(author.author_id), author]));
    this.milestones = new Map(data.milestones.map((milestone) => [String(milestone.id), milestone.title]));
    const fields: QaseFieldDefinition[] = [
      { systemName: "qase:description", label: "Description", kind: "text", system: true, closed: false, suggested: { kind: "description", heading: "" } },
      { systemName: "qase:preconditions", label: "Pre-conditions", kind: "text", system: true, closed: false, suggested: { kind: "precondition", heading: "" } },
      { systemName: "qase:postconditions", label: "Post-conditions", kind: "text", system: true, closed: false, suggested: { kind: "description", heading: "Post-conditions" } },
      { systemName: "qase:steps", label: "Steps", kind: "steps", system: true, closed: false, suggested: { kind: "scenario" }, always: true },
      { systemName: "qase:parameters", label: "Parameters", kind: "text", system: true, closed: false, suggested: { kind: "description", heading: "Parameters" } },
    ];
    for (const known of ENUMS) {
      const options = new Map((data.systemFields.find((field) => field.slug === known.slug)?.options ?? []).map((option) => [String(option.id), option]));
      this.enumOptions.set(known.slug, new Map([...options].map(([id, option]) => [id, option.title])));
      const suggestedValues: Record<string, string | null> = {};
      for (const [id, option] of options) {
        if (known.slug === "status" && STATUS_NAMES[option.slug]) {
          suggestedValues[id] = STATUS_NAMES[option.slug]!;
        } else if (option.slug === "undefined" || option.slug === "unknown") {
          // "Not set" is the absence of a value.
          suggestedValues[id] = null;
        }
      }
      fields.push({
        systemName: `qase:${known.slug}`,
        label: known.label,
        kind: known.kind ?? "dropdown",
        system: true,
        closed: true,
        suggested: known.suggested,
        ...(Object.keys(suggestedValues).length > 0 ? { suggestedValues } : {}),
      });
    }
    fields.push(
      { systemName: "qase:tags", label: "Tags", kind: "multiselect", system: true, closed: false, suggested: { kind: "tag" } },
      { systemName: "qase:milestone", label: "Milestone", kind: "milestone", system: true, closed: true, suggested: { kind: "customField", name: "Milestone" } },
      { systemName: "qase:author", label: "Author", kind: "user", system: true, closed: true, suggested: { kind: "owner" } },
      { systemName: "qase:external_issues", label: "Linked issues", kind: "multiselect", system: true, closed: false, suggested: { kind: "issue", integrationId: null } },
    );
    for (const field of data.customFields) {
      const kind = customKind(field.type);
      this.custom.set(field.id, field);
      this.customOptions.set(field.id, parseOptions(field));
      fields.push({
        systemName: `${CUSTOM_PREFIX}${field.id}`,
        label: field.title,
        kind,
        system: false,
        closed: ["dropdown", "multiselect", "checkbox", "user"].includes(kind),
        suggested: customSuggestion(field, kind),
      });
    }
    this.fields = fields;
    fields.forEach((field) => this.byName.set(field.systemName, field));
  }

  get(systemName: string): QaseFieldDefinition | undefined {
    return this.byName.get(systemName);
  }

  private user(id: string): QaseValue {
    const user = this.users.get(id);
    return { ids: [id], labels: [user?.name ?? `User ${id}`], emails: new Map(user?.email ? [[id, user.email]] : []) };
  }

  /** Raw text of a text field, in the markup Qase stores. */
  text(testCase: QaseCase, systemName: string): string {
    switch (systemName) {
      case "qase:description":
        return testCase.description ?? "";
      case "qase:preconditions":
        return testCase.preconditions ?? "";
      case "qase:postconditions":
        return testCase.postconditions ?? "";
      case "qase:parameters":
        return parametersText(testCase.parameters);
      default:
        return this.value(testCase, systemName).labels.join("\n\n");
    }
  }

  value(testCase: QaseCase, systemName: string): QaseValue {
    const none: QaseValue = { ids: [], labels: [] };
    const one = (text: string | null | undefined): QaseValue => (text && text.trim() ? { ids: [], labels: [text] } : none);
    if (systemName.startsWith(CUSTOM_PREFIX)) {
      const id = Number(systemName.slice(CUSTOM_PREFIX.length));
      const field = this.custom.get(id);
      const values = (testCase.custom_fields ?? []).filter((entry) => entry.id === id && entry.value !== null && String(entry.value).trim() !== "").map((entry) => String(entry.value));
      if (!field || values.length === 0) {
        return none;
      }
      switch (customKind(field.type)) {
        case "dropdown":
        case "multiselect": {
          const options = this.customOptions.get(id)!;
          // Several values arrive as separate entries, or as one comma separated list of option ids.
          const ids = values.flatMap((value) => (options.has(value) ? [value] : value.split(",").map((part) => part.trim()).filter(Boolean)));
          return { ids, labels: ids.map((value) => options.get(value) ?? value) };
        }
        case "checkbox": {
          const checked = !["", "0", "false"].includes(values[0]!.toLowerCase());
          return { ids: [checked ? "1" : "0"], labels: [checked ? "Yes" : "No"] };
        }
        case "user": {
          const users = values.map((value) => this.user(value));
          return { ids: users.flatMap((u) => u.ids), labels: users.flatMap((u) => u.labels), emails: new Map(users.flatMap((u) => [...(u.emails ?? [])])) };
        }
        default:
          return { ids: [], labels: values };
      }
    }
    switch (systemName) {
      case "qase:description":
      case "qase:preconditions":
      case "qase:postconditions":
      case "qase:parameters":
        return one(this.text(testCase, systemName));
      case "qase:steps": {
        const count = testCase.steps?.length ?? 0;
        return count > 0 ? { ids: [], labels: [testCase.steps_type === "gherkin" ? (testCase.steps![0]!.action ?? "Gherkin scenario") : `${count} step(s): ${testCase.steps![0]!.action ?? ""}`] } : none;
      }
      case "qase:tags":
        return { ids: [], labels: (testCase.tags ?? []).map((tag) => tag.title).filter(Boolean) };
      case "qase:milestone": {
        const id = testCase.milestone_id ? String(testCase.milestone_id) : null;
        return id ? { ids: [id], labels: [this.milestones.get(id) ?? `Milestone ${id}`] } : none;
      }
      case "qase:author": {
        // `member_id` is the user; older answers only carry the author record.
        const author = testCase.author_id ? this.authors.get(String(testCase.author_id)) : undefined;
        const userId = testCase.member_id ?? (author?.entity_type === "user" ? author.entity_id : undefined);
        if (userId && this.users.has(String(userId))) {
          return this.user(String(userId));
        }
        if (author) {
          const id = `author-${author.author_id}`;
          return { ids: [id], labels: [author.name ?? author.email ?? id], emails: new Map(author.email ? [[id, author.email]] : []) };
        }
        return none;
      }
      case "qase:external_issues":
        return { ids: [], labels: (testCase.external_issues ?? []).flatMap((group) => group.issues.map((issue) => issue.id)).filter(Boolean) };
      case "qase:automation": {
        // The two switches are the current model; the number is kept for older answers.
        const id = testCase.isManual === undefined ? testCase.automation : testCase.isManual ? (testCase.isToBeAutomated ? 1 : 0) : 2;
        return id === undefined ? none : { ids: [String(id)], labels: [this.enumOptions.get("automation")?.get(String(id)) ?? ["Manual", "To be automated", "Automated"][id] ?? String(id)] };
      }
      default: {
        const slug = systemName.replace(/^qase:/, "");
        const options = this.enumOptions.get(slug);
        const raw = (testCase as unknown as Record<string, unknown>)[slug];
        if (!options || raw === undefined || raw === null) {
          return none;
        }
        const id = String(raw);
        return { ids: [id], labels: [options.get(id) ?? id] };
      }
    }
  }

  /** Field information for the mapping screens, with statistics from sampled cases. */
  toInfo(cases: QaseCase[]): SourceFieldInfo[] {
    const result: SourceFieldInfo[] = [];
    for (const field of this.fields) {
      let filled = 0;
      const counts = new Map<string, { label: string; count: number; email?: string }>();
      const examples: string[] = [];
      for (const testCase of cases) {
        const value = this.value(testCase, field.systemName);
        if (value.labels.length === 0) {
          continue;
        }
        filled += 1;
        if (field.closed) {
          value.ids.forEach((id, index) => {
            const entry = counts.get(id) ?? { label: value.labels[index] ?? id, count: 0, email: value.emails?.get(id) };
            entry.count += 1;
            counts.set(id, entry);
          });
        } else if (examples.length < 3) {
          const example = value.labels
            .join(", ")
            .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, name: string) => `[image${name ? `: ${name}` : ""}]`)
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 160);
          if (example && !examples.includes(example)) {
            examples.push(example);
          }
        }
      }
      if (filled === 0 && !field.always) {
        continue;
      }
      // A system field that says "Not set" or "No" on every case holds nothing to migrate.
      const meaningful = field.suggestedValues || field.kind === "checkbox" ? [...counts.keys()].some((id) => (field.kind === "checkbox" ? id !== "0" : field.suggestedValues![id] !== null)) : true;
      const options: TestRailFieldOption[] | null = field.closed
        ? [...counts.entries()].sort((a, b) => b[1].count - a[1].count).map(([id, entry]) => ({ id, label: entry.label, count: entry.count, ...(entry.email ? { email: entry.email } : {}) }))
        : null;
      result.push({
        systemName: field.systemName,
        label: field.label,
        kind: field.kind,
        system: field.system,
        options,
        filledCount: meaningful ? filled : 0,
        examples,
        suggestedTarget: field.suggested,
        ...(field.suggestedValues ? { suggestedValues: field.suggestedValues } : {}),
      });
    }
    return result;
  }
}
