import { exampleText, type FieldTarget, type SourceFieldInfo, type SourceFieldKind, type TestRailFieldOption } from "@atm/shared";
import { htmlToMarkdown, looksLikeHtml } from "../convert/markup.js";
import { isAccountId } from "./diagnostics.js";
import type { ZephyrCase, ZephyrOption, ZephyrUser } from "./types.js";

/** Values of a field on one test case. */
export interface ZephyrValue {
  /** Value ids for fields with a closed set of values: the name for statuses and options, the account id for users. */
  ids: string[];
  labels: string[];
  /** Users seen in the value: account id -> email, for owner matching. */
  emails?: Map<string, string>;
}

export interface ZephyrField {
  systemName: string;
  label: string;
  kind: SourceFieldKind;
  system: boolean;
  closed: boolean;
  suggested: FieldTarget;
  suggestedValues?: Record<string, string | null>;
  always?: boolean;
}

/** What Zephyr knows besides the test cases: names of statuses, priorities, components, folders and users. */
export interface ZephyrDictionaries {
  statuses: Map<number, ZephyrOption>;
  priorities: Map<number, ZephyrOption>;
  /** Jira components of the project by id. */
  components: Map<number, string>;
  /** Jira users by account id; filled as test cases are read. */
  users: Map<string, ZephyrUser>;
  /** Jira issue keys by issue id; filled as test cases are read. */
  issues: Map<number, { key: string; summary: string }>;
  /** Folder path of every folder, outermost first. */
  folderPaths: Map<number, string[]>;
}

export const CUSTOM_PREFIX = "zephyr:cf:";
export const ISSUES_PREFIX = "zephyr:issues:";

/** The default statuses of Zephyr by the names of the default Allure TestOps workflow. */
const STATUS_NAMES: Record<string, string> = { Draft: "Draft", Approved: "Active", Deprecated: "Outdated" };

const ISSUE_LINK_LABELS: Record<string, string> = { COVERAGE: "Covered issues", BLOCKS: "Issues: blocks", RELATED: "Issues: related" };

const FIELDS: ZephyrField[] = [
  { systemName: "zephyr:steps", label: "Test script: steps", kind: "steps", system: true, closed: false, suggested: { kind: "scenario" }, always: true },
  { systemName: "zephyr:script", label: "Test script: plain text or BDD", kind: "text", system: true, closed: false, suggested: { kind: "scenario" }, always: true },
  { systemName: "zephyr:objective", label: "Objective", kind: "text", system: true, closed: false, suggested: { kind: "description", heading: "" }, always: true },
  { systemName: "zephyr:precondition", label: "Precondition", kind: "text", system: true, closed: false, suggested: { kind: "precondition", heading: "" }, always: true },
  { systemName: "zephyr:status", label: "Status", kind: "dropdown", system: true, closed: true, suggested: { kind: "status" }, suggestedValues: STATUS_NAMES, always: true },
  { systemName: "zephyr:priority", label: "Priority", kind: "dropdown", system: true, closed: true, suggested: { kind: "customField", name: "Priority" }, always: true },
  { systemName: "zephyr:labels", label: "Labels", kind: "multiselect", system: true, closed: true, suggested: { kind: "tag" } },
  { systemName: "zephyr:component", label: "Component", kind: "dropdown", system: true, closed: true, suggested: { kind: "customField", name: "Component" } },
  { systemName: "zephyr:owner", label: "Owner", kind: "user", system: true, closed: true, suggested: { kind: "owner" } },
  { systemName: "zephyr:webLinks", label: "Web links", kind: "url", system: true, closed: false, suggested: { kind: "link" } },
  { systemName: "zephyr:estimatedTime", label: "Estimated time", kind: "string", system: true, closed: false, suggested: { kind: "ignore" } },
  { systemName: "zephyr:createdOn", label: "Created on", kind: "date", system: true, closed: false, suggested: { kind: "ignore" } },
  { systemName: "zephyr:folder", label: "Folder (full path)", kind: "string", system: true, closed: false, suggested: { kind: "ignore" } },
];

/** Plain text of a value that may be HTML. */
export function plain(value: string | null | undefined): string {
  if (!value) {
    return "";
  }
  // Markdown escapes list markers at the start of a converted line: "1\." is "1." in plain text.
  const text = looksLikeHtml(value) ? htmlToMarkdown(value).replace(/^(\s*\d+)\\\./gm, "$1.").replace(/^(\s*)\\-/gm, "$1-") : value;
  return text.replace(/ /g, " ").trim();
}

/** "1h 30m" for milliseconds. */
export function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const parts = [hours > 0 ? `${hours}h` : "", minutes % 60 > 0 || hours === 0 ? `${minutes % 60}m` : ""];
  return parts.filter(Boolean).join(" ");
}

const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(value);
const isLongText = (value: string) => looksLikeHtml(value) || value.includes("\n") || value.length > 120;

/**
 * Zephyr gives the values of custom fields, not their definitions: the kind of a field is told by
 * the values the sampled test cases have.
 */
function customKind(values: unknown[]): SourceFieldKind {
  const present = values.filter((value) => value !== null && value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0));
  if (present.length === 0) {
    return "string";
  }
  if (present.some(Array.isArray)) {
    return present.flat().every((value) => typeof value === "string" && isAccountId(value)) ? "user" : "multiselect";
  }
  if (present.every((value) => typeof value === "boolean")) {
    return "checkbox";
  }
  if (present.every((value) => typeof value === "number")) {
    return "integer";
  }
  const strings = present.map(String);
  if (strings.every(isDate)) {
    return "date";
  }
  if (strings.every(isAccountId)) {
    return "user";
  }
  if (strings.some(isLongText)) {
    return "text";
  }
  if (strings.every((value) => /^https?:\/\/\S+$/i.test(value))) {
    return "url";
  }
  // Repeated short values are a list to choose from; free text rarely repeats.
  const distinct = new Set(strings).size;
  return distinct < strings.length && distinct <= 30 ? "dropdown" : "string";
}

function customSuggestion(name: string, kind: SourceFieldKind): FieldTarget {
  switch (kind) {
    case "text":
      return { kind: "description", heading: name };
    case "url":
      return { kind: "link" };
    case "user":
      return { kind: "role", role: "" };
    case "date":
      return { kind: "ignore" };
    default:
      return { kind: "customField", name };
  }
}

/**
 * Every attribute of Zephyr test cases as a mappable field: the built-in ones, issue links by type,
 * and the custom fields of the project as the sampled test cases show them.
 */
export class ZephyrCatalog {
  readonly fields: ZephyrField[];
  private readonly byName: Map<string, ZephyrField>;

  constructor(
    readonly dictionaries: ZephyrDictionaries,
    sample: ZephyrCase[] = [],
  ) {
    const customNames = [...new Set(sample.flatMap((item) => Object.keys(item.testCase.customFields ?? {})))].sort((a, b) => a.localeCompare(b));
    const custom: ZephyrField[] = customNames.map((name) => {
      const kind = customKind(sample.map((item) => item.testCase.customFields?.[name]));
      return {
        systemName: `${CUSTOM_PREFIX}${name}`,
        label: name,
        kind,
        system: false,
        closed: ["dropdown", "multiselect", "user", "checkbox"].includes(kind),
        suggested: customSuggestion(name, kind),
        ...(kind === "checkbox" ? { suggestedValues: { Yes: "Yes", No: null } } : {}),
      };
    });
    const linkTypes = [...new Set(sample.flatMap((item) => (item.testCase.links?.issues ?? []).map((link) => link.type ?? "COVERAGE")))];
    const links = [...new Set(["COVERAGE", ...linkTypes])].map((type) => this.issueField(type));
    this.fields = [...FIELDS, ...links, ...custom];
    this.byName = new Map(this.fields.map((field) => [field.systemName, field]));
  }

  private issueField(type: string): ZephyrField {
    return {
      systemName: `${ISSUES_PREFIX}${type}`,
      label: ISSUE_LINK_LABELS[type] ?? `Issues: ${type.toLowerCase()}`,
      kind: "string",
      system: true,
      closed: false,
      // Requirements the test case covers; Allure TestOps links them as issues of the tracker integration.
      suggested: type === "COVERAGE" ? { kind: "issue", integrationId: null } : { kind: "link" },
      always: type === "COVERAGE",
    };
  }

  get(systemName: string): ZephyrField | undefined {
    const known = this.byName.get(systemName);
    if (known) {
      return known;
    }
    // Fields not seen in the sample still work.
    if (systemName.startsWith(ISSUES_PREFIX)) {
      return this.issueField(systemName.slice(ISSUES_PREFIX.length));
    }
    if (systemName.startsWith(CUSTOM_PREFIX)) {
      const name = systemName.slice(CUSTOM_PREFIX.length);
      return { systemName, label: name, kind: "string", system: false, closed: false, suggested: { kind: "ignore" } };
    }
    return undefined;
  }

  private user(accountId: string): { id: string; label: string; email: string | null } {
    const user = this.dictionaries.users.get(accountId);
    return { id: accountId, label: user?.displayName || accountId, email: user?.email ?? null };
  }

  /** Raw rich text of a field (HTML for Zephyr rich text); empty for fields that are not text. */
  text(item: ZephyrCase, systemName: string): string {
    const { testCase } = item;
    switch (systemName) {
      case "zephyr:objective":
        return testCase.objective ?? "";
      case "zephyr:precondition":
        return testCase.precondition ?? "";
      case "zephyr:script":
        return item.script?.text ?? "";
      default:
        break;
    }
    if (systemName.startsWith(CUSTOM_PREFIX)) {
      const raw = testCase.customFields?.[systemName.slice(CUSTOM_PREFIX.length)];
      return typeof raw === "string" ? raw : "";
    }
    return "";
  }

  value(item: ZephyrCase, systemName: string): ZephyrValue {
    const { testCase } = item;
    const none: ZephyrValue = { ids: [], labels: [] };
    const named = (name: string | null | undefined): ZephyrValue => (name ? { ids: [name], labels: [name] } : none);
    const users = (accountIds: string[]): ZephyrValue => {
      const found = accountIds.filter(Boolean).map((id) => this.user(id));
      return { ids: found.map((user) => user.id), labels: found.map((user) => user.label), emails: new Map(found.filter((user) => user.email).map((user) => [user.id, user.email!])) };
    };
    switch (systemName) {
      case "zephyr:steps": {
        if (item.steps.length === 0) {
          return none;
        }
        const first = item.steps[0]!;
        const summary = first.testCase ? `calls ${first.testCase.testCaseKey}` : plain(first.inline?.description).split("\n")[0];
        return { ids: [], labels: [`${item.steps.length} step(s): ${summary}`] };
      }
      case "zephyr:script":
        return item.script?.text.trim() ? { ids: [], labels: [`${item.script.type === "bdd" ? "BDD" : "Plain text"}: ${plain(item.script.text)}`] } : none;
      case "zephyr:objective":
      case "zephyr:precondition": {
        const text = plain(this.text(item, systemName));
        return text ? { ids: [], labels: [text] } : none;
      }
      case "zephyr:status":
        return named(testCase.status ? (this.dictionaries.statuses.get(testCase.status.id)?.name ?? `Status ${testCase.status.id}`) : null);
      case "zephyr:priority":
        return named(testCase.priority ? (this.dictionaries.priorities.get(testCase.priority.id)?.name ?? `Priority ${testCase.priority.id}`) : null);
      case "zephyr:component":
        return named(testCase.component ? (this.dictionaries.components.get(testCase.component.id) ?? `Component ${testCase.component.id}`) : null);
      case "zephyr:labels": {
        const labels = (testCase.labels ?? []).map((label) => label.trim()).filter(Boolean);
        return { ids: labels, labels };
      }
      case "zephyr:owner":
        return users(testCase.owner?.accountId ? [testCase.owner.accountId] : []);
      case "zephyr:webLinks":
        return { ids: [], labels: (testCase.links?.webLinks ?? []).map((link) => link.url).filter(Boolean) };
      case "zephyr:estimatedTime":
        return testCase.estimatedTime ? { ids: [], labels: [duration(testCase.estimatedTime)] } : none;
      case "zephyr:createdOn":
        return testCase.createdOn ? { ids: [], labels: [testCase.createdOn.slice(0, 10)] } : none;
      case "zephyr:folder": {
        const path = testCase.folder ? (this.dictionaries.folderPaths.get(testCase.folder.id) ?? []) : [];
        return path.length > 0 ? { ids: [], labels: [path.join(" / ")] } : none;
      }
      default:
        break;
    }
    if (systemName.startsWith(ISSUES_PREFIX)) {
      const type = systemName.slice(ISSUES_PREFIX.length);
      // Issues Jira did not give a key for are left out; the transform adds a note about them.
      const keys = (testCase.links?.issues ?? [])
        .filter((link) => (link.type ?? "COVERAGE") === type)
        .map((link) => this.dictionaries.issues.get(link.issueId)?.key)
        .filter((key): key is string => Boolean(key));
      return { ids: [], labels: keys };
    }
    if (systemName.startsWith(CUSTOM_PREFIX)) {
      const field = this.get(systemName)!;
      const raw = testCase.customFields?.[systemName.slice(CUSTOM_PREFIX.length)];
      if (raw === null || raw === undefined || raw === "" || (Array.isArray(raw) && raw.length === 0)) {
        return none;
      }
      if (field.kind === "user") {
        return users((Array.isArray(raw) ? raw : [raw]).map(String));
      }
      if (typeof raw === "boolean") {
        return { ids: [raw ? "Yes" : "No"], labels: [raw ? "Yes" : "No"] };
      }
      if (Array.isArray(raw)) {
        const values = raw.map((value) => (typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)).trim()).filter(Boolean);
        return { ids: values, labels: values };
      }
      const value = typeof raw === "object" ? JSON.stringify(raw) : String(raw);
      const text = field.kind === "text" ? plain(value) : value.trim();
      return text ? { ids: field.closed ? [text] : [], labels: [text] } : none;
    }
    return none;
  }

  /** Field information for the mapping screens, with statistics from sampled test cases. */
  toInfo(cases: ZephyrCase[]): SourceFieldInfo[] {
    const result: SourceFieldInfo[] = [];
    for (const field of this.fields) {
      let filled = 0;
      const counts = new Map<string, { label: string; count: number; email?: string }>();
      const examples: string[] = [];
      for (const item of cases) {
        const value = this.value(item, field.systemName);
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
