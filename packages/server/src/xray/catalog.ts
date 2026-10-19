import { JiraCatalog, type JiraCatalogField, type JiraValue } from "../jira/catalog.js";
import type { JiraField } from "../jira/types.js";
import { wikiToMarkdown } from "../jira/wiki.js";
import type { XrayCase } from "./types.js";

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

const XRAY_FIELDS: JiraCatalogField[] = [
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
];

/**
 * Everything the tool knows about the attributes of Xray tests: the Xray attributes, and the Jira
 * fields, issue links and comments of the issue (see {@link JiraCatalog}).
 */
export class XrayCatalog extends JiraCatalog<XrayCase> {
  constructor(jiraFields: JiraField[], linkDirectionsSeen: string[] = []) {
    super(jiraFields, linkDirectionsSeen, XRAY_FIELDS);
  }

  protected appValue(testCase: XrayCase, systemName: string): JiraValue | null {
    const { test } = testCase;
    switch (systemName) {
      case "xray:testType":
        return this.list([test.testType?.name ? { id: test.testType.name, label: test.testType.name } : null]);
      case "xray:steps": {
        const count = test.steps?.length ?? 0;
        return { ids: [], labels: count > 0 ? [`${count} step(s)`] : [] };
      }
      case "xray:definition": {
        const text = this.text(testCase, systemName);
        return { ids: [], labels: text ? [text] : [] };
      }
      case "xray:preconditions":
        return this.list((test.preconditions?.results ?? []).map(issueLabel));
      case "xray:testSets":
        return this.list((test.testSets?.results ?? []).map(issueLabel));
      case "xray:testPlans":
        return this.list((test.testPlans?.results ?? []).map(issueLabel));
      case "xray:folder": {
        const path = folderLevels(test.folder?.path);
        return { ids: [], labels: path.length > 0 ? [path.join(" / ")] : [] };
      }
      default:
        return null;
    }
  }

  protected appText(testCase: XrayCase, systemName: string): string | null {
    const { test } = testCase;
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
    return null;
  }
}
