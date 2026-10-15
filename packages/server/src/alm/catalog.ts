import { exampleText, type FieldTarget, type SourceFieldInfo, type SourceFieldKind, type TestRailFieldOption } from "@atm/shared";
import { htmlToMarkdown, looksLikeHtml } from "../convert/markup.js";
import { one, type AlmFieldDefinition, type AlmRecord, type AlmTest, type AlmUser } from "./types.js";

/** Values of a field on one test. */
export interface AlmValue {
  /** Values of fields with a closed set of values; ALM stores the value itself, so ids are the values. */
  ids: string[];
  labels: string[];
  /** Users seen in the value: user name -> email, for owner matching. */
  emails?: Map<string, string>;
}

export interface AlmCatalogField {
  systemName: string;
  /** Name of the ALM field, e.g. `owner` or `user-01`. */
  name: string;
  label: string;
  kind: SourceFieldKind;
  system: boolean;
  closed: boolean;
  multiValue: boolean;
  suggested: FieldTarget;
  suggestedValues?: Record<string, string | null>;
  always?: boolean;
}

const PREFIX = "alm:";

/** Fields that identify or place the test, describe ALM internals, or are migrated otherwise. */
const SKIPPED = new Set([
  "id",
  "name",
  "parent-id",
  "ver-stamp",
  "attachment",
  "steps",
  "has-criteria",
  "has-linkage",
  "protocol-type",
  "storage-path",
  "working-mode",
  "template",
  "base-test-id",
  "check-out-user-name",
  "test-version",
  "request-id",
  "service-test-mode",
  "steps-param",
  "runtime-data",
  "bpta-change-detected",
  "bpta-change-awareness",
  "bpta-change-timestamp",
  "bpta-long-description",
  "bpta-locked",
  "bpta-condition",
  "has-dependencies",
  "last-modified",
  "creation-time",
  "exec-status",
  "estimate-devtime",
]);

/** Labels of system fields, for ALM versions that do not give the customization of the project. */
const LABELS: Record<string, string> = {
  description: "Description",
  "dev-comments": "Comments",
  owner: "Designer",
  status: "Status",
  "subtype-id": "Type",
};

/** ALM test statuses by the names of the default Allure TestOps workflow. */
const STATUS_NAMES: Record<string, string> = { Design: "Draft", Imported: "Draft", Repair: "Draft", Ready: "Active" };

/** ALM test types by readable names. */
const TYPE_NAMES: Record<string, string> = {
  MANUAL: "Manual",
  "QUICKTEST_TEST": "UFT",
  "LEANFT-TEST": "UFT Developer",
  "BUSINESS-PROCESS": "Business process",
  FLOW: "Flow",
  "SERVICE-TEST": "Service test",
  "SYSTEM-TEST": "System test",
  "VAPI-XP-TEST": "VAPI-XP",
  "LR-SCENARIO": "LoadRunner scenario",
  "PC-SCENARIO": "Performance test",
  "EXTERNAL-TEST": "External test",
};

function kindOf(field: AlmFieldDefinition): SourceFieldKind {
  if (field.name === "subtype-id" || field.name === "status") {
    return "dropdown";
  }
  if (field.name === "description" || field.name === "dev-comments") {
    return "text";
  }
  switch (field.type.toLowerCase()) {
    case "memo":
      return "text";
    case "number":
      return "integer";
    case "date":
    case "datetime":
      return "date";
    case "lookuplist":
    case "list":
      return field.multiValue ? "multiselect" : "dropdown";
    case "userslist":
      return "user";
    case "string":
    case "":
      return "string";
    default:
      return "unknown";
  }
}

function suggestion(field: AlmFieldDefinition, kind: SourceFieldKind): FieldTarget {
  switch (field.name) {
    case "description":
      return { kind: "description", heading: "" };
    case "dev-comments":
      return { kind: "comment" };
    case "owner":
      return { kind: "owner" };
    case "status":
      return { kind: "status" };
    case "subtype-id":
      return { kind: "customField", name: "Test type" };
    default:
      break;
  }
  switch (kind) {
    case "text":
      return { kind: "description", heading: field.label };
    case "user":
      return { kind: "role", role: "" };
    case "date":
    case "unknown":
      return { kind: "ignore" };
    default:
      return { kind: "customField", name: field.label };
  }
}

/** Parameters of a test as Markdown: a line per parameter with its default value. */
export function parametersText(parameters: AlmRecord[]): string {
  return parameters
    .map((parameter) => {
      const value = plain(one(parameter, "default-value"));
      const description = plain(one(parameter, "desc") ?? one(parameter, "description"));
      return `- **${one(parameter, "name") ?? "?"}**${value ? `: ${value}` : ""}${description ? ` (${description})` : ""}`;
    })
    .join("\n");
}

/** ALM rich text is a whole HTML page, possibly without any other tag. */
export function isHtml(value: string): boolean {
  return looksLikeHtml(value) || /<\/?(html|body)\b/i.test(value);
}

/** Plain text of a value that may be HTML. */
export function plain(value: string | null | undefined): string {
  if (!value) {
    return "";
  }
  return (isHtml(value) ? htmlToMarkdown(value) : value).replace(/\u00a0/g, " ").trim();
}

/** Every field of an ALM test as a mappable field. */
export class AlmCatalog {
  readonly fields: AlmCatalogField[];
  private readonly byName = new Map<string, AlmCatalogField>();
  private readonly users: Map<string, AlmUser>;

  /** `definitions`: the customization of the project; when ALM does not give it, the fields seen on `sample`. */
  constructor(definitions: AlmFieldDefinition[], users: AlmUser[], sample: AlmRecord[] = []) {
    this.users = new Map(users.map((user) => [user.name, user]));
    const known = definitions.length > 0 ? definitions : this.seen(sample);
    const fields: AlmCatalogField[] = [
      { systemName: `${PREFIX}steps`, name: "steps", label: "Design steps", kind: "steps", system: true, closed: false, multiValue: false, suggested: { kind: "scenario" }, always: true },
    ];
    for (const definition of known) {
      if (SKIPPED.has(definition.name) || definition.name.startsWith("vc-") || !definition.active) {
        continue;
      }
      const kind = kindOf(definition);
      const suggestedValues = definition.name === "status" ? STATUS_NAMES : definition.name === "subtype-id" ? TYPE_NAMES : undefined;
      fields.push({
        systemName: `${PREFIX}${definition.name}`,
        name: definition.name,
        label: definition.label,
        kind,
        system: definition.system || !/^user-/.test(definition.name),
        closed: ["dropdown", "multiselect", "user"].includes(kind),
        multiValue: definition.multiValue,
        suggested: suggestion(definition, kind),
        ...(suggestedValues ? { suggestedValues } : {}),
      });
    }
    // After the description, so the parameters follow it when both go there.
    fields.splice(fields.findIndex((field) => field.name === "description") + 1, 0, {
      systemName: `${PREFIX}parameters`,
      name: "parameters",
      label: "Parameters",
      kind: "text",
      system: true,
      closed: false,
      multiValue: false,
      suggested: { kind: "description", heading: "Parameters" },
    });
    this.fields = fields;
    fields.forEach((field) => this.byName.set(field.systemName, field));
  }

  private seen(sample: AlmRecord[]): AlmFieldDefinition[] {
    const names = [...new Set(sample.flatMap((record) => Object.keys(record.fields)))];
    return names.map((name) => ({ name, label: LABELS[name] ?? name, type: name === "owner" ? "UsersList" : "", system: !/^user-/.test(name), active: true, multiValue: false }));
  }

  get(systemName: string): AlmCatalogField | undefined {
    return this.byName.get(systemName);
  }

  /** Raw text of a field: HTML for rich text fields. */
  text(test: AlmTest, systemName: string): string {
    if (systemName === `${PREFIX}parameters`) {
      return parametersText(test.parameters);
    }
    const field = this.get(systemName);
    return (test.test.fields[field?.name ?? systemName.slice(PREFIX.length)] ?? []).join("\n");
  }

  private user(name: string): string {
    const user = this.users.get(name);
    return user?.fullName ? `${user.fullName} (${name})` : name;
  }

  value(test: AlmTest, systemName: string): AlmValue {
    const none: AlmValue = { ids: [], labels: [] };
    if (systemName === `${PREFIX}steps`) {
      const first = test.steps[0];
      const summary = first ? (one(first, "link-test") ? `calls test ${one(first, "link-test")}` : plain(one(first, "description")).split("\n")[0]) : "";
      return test.steps.length > 0 ? { ids: [], labels: [`${test.steps.length} step(s): ${summary}`] } : none;
    }
    if (systemName === `${PREFIX}parameters`) {
      return test.parameters.length > 0 ? { ids: [], labels: [parametersText(test.parameters)] } : none;
    }
    const field = this.get(systemName);
    const raw = test.test.fields[field?.name ?? systemName.slice(PREFIX.length)] ?? [];
    // Several values arrive as separate values, or as one value separated by semicolons.
    const values = (field?.closed && (field.multiValue || field.kind === "user") ? raw.flatMap((value) => value.split(";")) : raw).map((value) => value.trim()).filter(Boolean);
    if (values.length === 0) {
      return none;
    }
    if (field?.kind === "user") {
      return {
        ids: values,
        labels: values.map((name) => this.user(name)),
        emails: new Map(values.flatMap((name) => (this.users.get(name)?.email ? [[name, this.users.get(name)!.email!] as [string, string]] : []))),
      };
    }
    if (field?.closed) {
      return { ids: values, labels: values.map((value) => (field.name === "subtype-id" ? (TYPE_NAMES[value] ? `${TYPE_NAMES[value]} (${value})` : value) : value)) };
    }
    return { ids: [], labels: field?.kind === "text" ? values.map(plain).filter(Boolean) : values };
  }

  /** Field information for the mapping screens, with statistics from sampled tests. */
  toInfo(tests: AlmTest[]): SourceFieldInfo[] {
    const result: SourceFieldInfo[] = [];
    for (const field of this.fields) {
      let filled = 0;
      const counts = new Map<string, { label: string; count: number; email?: string }>();
      const examples: string[] = [];
      for (const test of tests) {
        const value = this.value(test, field.systemName);
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
          const example = exampleText(value.labels.join(", "));
          if (example && !examples.includes(example)) {
            examples.push(example);
          }
        }
      }
      if (filled === 0 && !field.always) {
        continue;
      }
      const options: TestRailFieldOption[] | null = field.closed
        ? [...counts.entries()].sort((a, b) => b[1].count - a[1].count).map(([id, entry]) => ({ id, label: entry.label, count: entry.count, ...(entry.email ? { email: entry.email } : {}) }))
        : null;
      // Only the values seen in the sample: a translation of others would only be noise.
      const suggestedValues = field.suggestedValues ? Object.fromEntries(Object.entries(field.suggestedValues).filter(([id]) => counts.has(id))) : undefined;
      result.push({
        systemName: field.systemName,
        label: field.label,
        kind: field.kind,
        system: field.system,
        options,
        filledCount: filled,
        examples,
        suggestedTarget: field.suggested,
        ...(suggestedValues && Object.keys(suggestedValues).length > 0 ? { suggestedValues } : {}),
      });
    }
    return result;
  }
}
