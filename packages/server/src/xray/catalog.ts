import type { FieldTarget, SourceFieldInfo, SourceFieldKind, TestRailFieldOption } from "@atm/shared";
import { ATTACHMENT_SCHEME, htmlToMarkdown } from "../convert/markup.js";
import type { JiraField, JiraIssueLink, XrayCase } from "./types.js";
import { wikiToMarkdown } from "./wiki.js";

/** Values of a field on one test. */
export interface XrayValue {
  /** Value ids for fields with a closed set of values (option label, user account id, issue key). */
  ids: string[];
  /** Human readable values, in the order of `ids` when there are ids. */
  labels: string[];
  /** Users seen in the value: account id -> email, for owner matching. */
  emails?: Map<string, string>;
}

export interface XrayFieldDefinition {
  systemName: string;
  label: string;
  kind: SourceFieldKind;
  /** A Jira system field or an Xray attribute rather than a Jira custom field. */
  system: boolean;
  /** Values are a closed set worth a value table. */
  closed: boolean;
  suggested: FieldTarget;
  /** Shown even when empty in every sampled test. */
  always?: boolean;
}

/** Jira fields with no meaning in Allure TestOps, or handled elsewhere (summary, attachments, comments, links). */
const SKIPPED = new Set([
  "summary",
  "issuetype",
  "project",
  "attachment",
  "comment",
  "issuelinks",
  "subtasks",
  "parent",
  "watches",
  "votes",
  "worklog",
  "timetracking",
  "timeoriginalestimate",
  "timeestimate",
  "timespent",
  "aggregatetimeoriginalestimate",
  "aggregatetimeestimate",
  "aggregatetimespent",
  "aggregateprogress",
  "progress",
  "workratio",
  "lastViewed",
  "thumbnail",
  "issuerestriction",
  "statusCategory",
  "statuscategorychangedate",
  "security",
  "issuekey",
]);

const SKIPPED_CUSTOM_TYPES = [
  "com.pyxis.greenhopper.jira:gh-lexo-rank",
  "com.atlassian.jira.plugins.jira-development-integration-plugin:devsummarycf",
  "com.atlassian.jpo:jpo-custom-field-parent",
];

/** Rich text fields: read from the rendered HTML. */
function isRichText(field: JiraField): boolean {
  return field.id === "description" || field.id === "environment" || Boolean(field.schema?.custom?.endsWith(":textarea"));
}

function kindOf(field: JiraField): SourceFieldKind {
  if (isRichText(field)) {
    return "text";
  }
  const schema = field.schema;
  if (schema?.custom?.endsWith(":url")) {
    return "url";
  }
  switch (schema?.type) {
    case "string":
      return "string";
    case "number":
      return "integer";
    case "date":
    case "datetime":
      return "date";
    case "user":
      return "user";
    case "array":
      return schema.items === "user" ? "user" : "multiselect";
    case "option":
    case "option-with-child":
    case "priority":
    case "status":
    case "resolution":
    case "version":
    case "component":
    case "securitylevel":
      return "dropdown";
    default:
      return "unknown";
  }
}

const JIRA_DEFAULTS: Record<string, FieldTarget> = {
  description: { kind: "description", heading: "" },
  environment: { kind: "description", heading: "Environment" },
  labels: { kind: "tag" },
  assignee: { kind: "owner" },
  reporter: { kind: "ignore" },
  creator: { kind: "ignore" },
  status: { kind: "ignore" },
  resolution: { kind: "ignore" },
  created: { kind: "ignore" },
  updated: { kind: "ignore" },
  resolutiondate: { kind: "ignore" },
  duedate: { kind: "ignore" },
};

function suggestedFor(field: JiraField, kind: SourceFieldKind): FieldTarget {
  const preset = JIRA_DEFAULTS[field.id];
  if (preset) {
    return preset;
  }
  if (field.schema?.custom?.startsWith("com.xpandit.")) {
    // Xray's own Jira fields repeat what the Xray attributes below carry.
    return { kind: "ignore" };
  }
  switch (kind) {
    case "text":
      return { kind: "description", heading: field.name };
    case "url":
      return { kind: "link" };
    case "date":
    case "unknown":
      return { kind: "ignore" };
    default:
      return { kind: "customField", name: field.name };
  }
}

/** Plain text of an Atlassian Document Format value, when no rendered HTML is available. */
function adfText(node: unknown): string {
  if (!node || typeof node !== "object") {
    return "";
  }
  const value = node as { type?: string; text?: string; content?: unknown[] };
  if (value.type === "text") {
    return value.text ?? "";
  }
  const inner = (value.content ?? []).map(adfText).join(value.type === "doc" || value.type === "bulletList" || value.type === "orderedList" ? "\n" : "");
  return value.type === "paragraph" || value.type === "listItem" || value.type === "heading" ? `${inner}\n` : inner;
}

/** Jira attachment id from an image source in rendered HTML. */
const JIRA_IMAGE = /\/(?:rest\/api\/[23]\/attachment\/(?:content|thumbnail)|secure\/(?:attachment|thumbnail))\/(\d+)/;

/** Rendered Jira HTML to Markdown; images of the issue become planned attachment references. */
export function jiraHtmlToMarkdown(html: string): string {
  const withMarkers = html.replace(/(<img\b[^>]*\bsrc=")([^"]+)(")/gi, (match, before: string, src: string, after: string) => {
    const id = JIRA_IMAGE.exec(src)?.[1];
    return id ? `${before}${ATTACHMENT_SCHEME}${id}${after}` : match;
  });
  return htmlToMarkdown(withMarkers);
}

function single(value: unknown, emails: Map<string, string>): { id: string; label: string } | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value === "string" || typeof value === "number") {
    return { id: String(value), label: String(value) };
  }
  if (typeof value === "boolean") {
    return { id: value ? "Yes" : "No", label: value ? "Yes" : "No" };
  }
  if (typeof value !== "object") {
    return null;
  }
  const object = value as Record<string, unknown>;
  if (typeof object.accountId === "string") {
    if (typeof object.emailAddress === "string" && object.emailAddress) {
      emails.set(object.accountId, object.emailAddress);
    }
    return { id: object.accountId, label: String(object.displayName ?? object.emailAddress ?? object.accountId) };
  }
  if (typeof object.value === "string") {
    const child = object.child as { value?: string } | undefined;
    const label = child?.value ? `${object.value} > ${child.value}` : object.value;
    return { id: label, label };
  }
  for (const key of ["name", "key", "displayName", "title"]) {
    if (typeof object[key] === "string" && object[key]) {
      return { id: object[key] as string, label: object[key] as string };
    }
  }
  if (object.type === "doc") {
    const text = adfText(object).trim();
    return text ? { id: text, label: text } : null;
  }
  const json = JSON.stringify(value);
  return json && json !== "{}" ? { id: json, label: json } : null;
}

/** "tests" for the outward side of a link, "is tested by" for the inward side. */
function linkDirections(links: JiraIssueLink[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const link of links) {
    const direction = link.outwardIssue ? link.type.outward : link.type.inward;
    const key = link.outwardIssue?.key ?? link.inwardIssue?.key;
    if (direction && key) {
      result.set(direction, [...(result.get(direction) ?? []), key]);
    }
  }
  return result;
}

function issueLabel(issue: { issueId: string; jira?: { key?: string; summary?: string } | null }): { id: string; label: string } {
  const key = issue.jira?.key ?? issue.issueId;
  return { id: key, label: issue.jira?.summary ? `${key} ${issue.jira.summary}` : key };
}

/** Folder path as levels: "/Mobile/Login" -> ["Mobile", "Login"]. */
export function folderLevels(path: string | null | undefined): string[] {
  return (path ?? "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
}

const XRAY_FIELDS: XrayFieldDefinition[] = [
  { systemName: "xray:testType", label: "Test type", kind: "dropdown", system: true, closed: true, suggested: { kind: "customField", name: "Test type" }, always: true },
  { systemName: "xray:steps", label: "Steps (Manual tests)", kind: "steps", system: true, closed: false, suggested: { kind: "scenario" }, always: true },
  {
    systemName: "xray:definition",
    label: "Definition (Cucumber and Generic tests)",
    kind: "text",
    system: true,
    closed: false,
    suggested: { kind: "description", heading: "" },
    always: true,
  },
  { systemName: "xray:preconditions", label: "Preconditions", kind: "text", system: true, closed: false, suggested: { kind: "precondition", heading: "" }, always: true },
  { systemName: "xray:testSets", label: "Test sets", kind: "multiselect", system: true, closed: true, suggested: { kind: "customField", name: "Test set" } },
  { systemName: "xray:testPlans", label: "Test plans", kind: "multiselect", system: true, closed: true, suggested: { kind: "customField", name: "Test plan" } },
  { systemName: "xray:folder", label: "Folder (full path)", kind: "string", system: true, closed: false, suggested: { kind: "ignore" } },
  { systemName: "jira:comment", label: "Comments", kind: "text", system: true, closed: false, suggested: { kind: "comment" } },
];

/**
 * Everything the tool knows about the attributes of Xray tests: the Jira fields of the issue
 * (system and custom), issue links by direction, comments, and the Xray attributes. Values are
 * read from one test at a time, so the same catalog backs discovery, preview and migration.
 */
export class XrayCatalog {
  readonly fields: XrayFieldDefinition[];
  private readonly byName: Map<string, XrayFieldDefinition>;
  private readonly jiraFields: Map<string, JiraField>;

  constructor(jiraFields: JiraField[], linkDirectionsSeen: string[] = []) {
    this.jiraFields = new Map(jiraFields.map((f) => [f.id, f]));
    const jira: XrayFieldDefinition[] = jiraFields
      .filter((field) => !SKIPPED.has(field.id) && !SKIPPED_CUSTOM_TYPES.includes(field.schema?.custom ?? ""))
      .map((field) => {
        const kind = kindOf(field);
        return {
          systemName: `jira:${field.id}`,
          label: field.name,
          kind,
          system: !field.custom,
          closed: kind === "dropdown" || kind === "multiselect" || kind === "user",
          suggested: suggestedFor(field, kind),
          always: ["description", "labels", "priority", "components", "fixVersions", "assignee", "reporter", "status"].includes(field.id),
        };
      });
    const links: XrayFieldDefinition[] = linkDirectionsSeen.map((direction) => ({
      systemName: `jira:link:${direction}`,
      label: `Issue links: ${direction}`,
      kind: "string",
      system: true,
      closed: false,
      // Requirements covered by the test; Allure TestOps links them as issues of the tracker integration.
      suggested: direction === "tests" ? { kind: "issue", integrationId: null } : { kind: "ignore" },
    }));
    this.fields = [...XRAY_FIELDS, ...jira, ...links];
    this.byName = new Map(this.fields.map((f) => [f.systemName, f]));
  }

  get(systemName: string): XrayFieldDefinition | undefined {
    if (!this.byName.has(systemName) && systemName.startsWith("jira:link:")) {
      // A link direction not seen in the sample still works.
      const direction = systemName.slice("jira:link:".length);
      return { systemName, label: `Issue links: ${direction}`, kind: "string", system: true, closed: false, suggested: { kind: "ignore" } };
    }
    return this.byName.get(systemName);
  }

  /** Link directions present on these tests, for the fields list. */
  static linkDirections(cases: XrayCase[]): string[] {
    const directions = new Set<string>();
    for (const testCase of cases) {
      for (const direction of linkDirections((testCase.issue.fields.issuelinks as JiraIssueLink[] | undefined) ?? []).keys()) {
        directions.add(direction);
      }
    }
    return [...directions].sort();
  }

  value(testCase: XrayCase, systemName: string): XrayValue {
    const { issue, test } = testCase;
    const emails = new Map<string, string>();
    const list = (items: ({ id: string; label: string } | null)[]): XrayValue => {
      const present = items.filter((item): item is { id: string; label: string } => item !== null);
      return { ids: present.map((i) => i.id), labels: present.map((i) => i.label), emails };
    };
    switch (systemName) {
      case "xray:testType":
        return list([test.testType?.name ? { id: test.testType.name, label: test.testType.name } : null]);
      case "xray:steps": {
        const count = test.steps?.length ?? 0;
        return { ids: [], labels: count > 0 ? [`${count} step(s)`] : [] };
      }
      case "xray:definition": {
        const text = this.text(testCase, systemName);
        return { ids: [], labels: text ? [text] : [] };
      }
      case "xray:preconditions":
        return list((test.preconditions?.results ?? []).map(issueLabel));
      case "xray:testSets":
        return list((test.testSets?.results ?? []).map(issueLabel));
      case "xray:testPlans":
        return list((test.testPlans?.results ?? []).map(issueLabel));
      case "xray:folder": {
        const path = folderLevels(test.folder?.path);
        return { ids: [], labels: path.length > 0 ? [path.join(" / ")] : [] };
      }
      case "jira:comment":
        return { ids: [], labels: this.comments(testCase) };
      default:
        break;
    }
    if (systemName.startsWith("jira:link:")) {
      const keys = linkDirections((issue.fields.issuelinks as JiraIssueLink[] | undefined) ?? []).get(systemName.slice("jira:link:".length)) ?? [];
      return { ids: keys, labels: keys };
    }
    const id = systemName.replace(/^jira:/, "");
    const field = this.jiraFields.get(id);
    if (field && isRichText(field)) {
      const text = this.text(testCase, systemName);
      return { ids: [], labels: text ? [text] : [] };
    }
    const raw = issue.fields[id];
    return list((Array.isArray(raw) ? raw : [raw]).map((item) => single(item, emails)));
  }

  /** Rich text of a field as Markdown, with Jira images as planned attachment references. */
  text(testCase: XrayCase, systemName: string): string {
    const { issue, test } = testCase;
    if (systemName === "xray:definition") {
      if (test.gherkin?.trim()) {
        return `\`\`\`gherkin\n${test.gherkin.trim()}\n\`\`\``;
      }
      return test.unstructured?.trim() ? wikiToMarkdown(test.unstructured) : "";
    }
    if (systemName === "xray:preconditions") {
      const items = (test.preconditions?.results ?? []).filter((p) => p.definition?.trim());
      if (items.length === 1 && (test.preconditions?.results.length ?? 0) === 1) {
        return wikiToMarkdown(items[0]!.definition!);
      }
      return items.map((p) => `### ${issueLabel(p).label}\n\n${wikiToMarkdown(p.definition!)}`).join("\n\n");
    }
    const id = systemName.replace(/^jira:/, "");
    const rendered = issue.renderedFields?.[id];
    if (typeof rendered === "string" && rendered.trim()) {
      return jiraHtmlToMarkdown(rendered);
    }
    const raw = issue.fields[id];
    if (typeof raw === "string") {
      return raw.trim();
    }
    return adfText(raw).trim();
  }

  /** Comments as Markdown, oldest first. */
  comments(testCase: XrayCase): string[] {
    const rendered = (testCase.issue.renderedFields?.comment as { comments?: { body?: string }[] } | undefined)?.comments;
    const raw = (testCase.issue.fields.comment as { comments?: { body?: unknown }[] } | undefined)?.comments ?? [];
    return raw
      .map((comment, index) => {
        const html = rendered?.[index]?.body;
        return typeof html === "string" && html.trim() ? jiraHtmlToMarkdown(html) : adfText(comment.body).trim();
      })
      .filter(Boolean);
  }

  /** Planned attachment ids referenced as images in a text. */
  static imageIds(markdown: string): string[] {
    return [...markdown.matchAll(new RegExp(`\\]\\(${ATTACHMENT_SCHEME}(\\d+)\\)`, "g"))].map((m) => m[1]!);
  }

  toInfo(cases: XrayCase[]): SourceFieldInfo[] {
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
      const options: TestRailFieldOption[] | null = field.closed
        ? [...counts.entries()]
            .sort((a, b) => b[1].count - a[1].count)
            .map(([id, entry]) => ({ id, label: entry.label, count: entry.count, ...(entry.email ? { email: entry.email } : {}) }))
        : null;
      result.push({
        systemName: field.systemName,
        label: field.label,
        kind: field.kind,
        system: field.system,
        options,
        filledCount: filled,
        examples,
        suggestedTarget: field.suggested,
      });
    }
    return result;
  }
}
