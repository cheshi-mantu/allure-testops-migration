import type { PlannedCase, PlannedStep } from "@atm/shared";
import type { ZephyrCase } from "./types.js";

/** Values of these keys are short codes that tell how Zephyr is set up; other values are never logged. */
const LOGGED_VALUES = new Set(["id", "type", "statusType", "folderType", "testCaseKey", "key", "parentId", "isLast", "enabled", "default", "archived"]);

/** How a value looks, without the value: `text 23`, `html 512`, `number`, `date`, `account id`. */
export function kindOfValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return typeof value;
  }
  if (typeof value !== "string") {
    return typeof value;
  }
  if (/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(value)) {
    return "date";
  }
  if (isAccountId(value)) {
    return "account id";
  }
  return /<\/?(p|br|div|span|ul|ol|li|strong|em|b|i|img|table|a)\b/i.test(value) ? `html ${value.length}` : `text ${value.length}`;
}

/** Atlassian account ids: 24 hex digits, or `557058:` followed by a UUID. */
export function isAccountId(value: string): boolean {
  return /^[0-9a-f]{24}$/i.test(value) || /^\d{1,10}:[0-9a-f-]{36}$/i.test(value);
}

/**
 * Keys of a JSON value with the kinds of their values, a few levels deep. Short codes (ids, types)
 * are shown, text is described by its kind and length only.
 */
export function shapeOf(value: unknown, depth = 0, key = ""): string {
  if (Array.isArray(value)) {
    return `[${value.length}]${value.length > 0 && depth < 3 ? shapeOf(value[0], depth + 1, key) : ""}`;
  }
  if (value !== null && typeof value === "object") {
    if (depth >= 3) {
      return `{${Object.keys(value).join(", ")}}`;
    }
    // Custom fields are named by the users of Zephyr: their names say how it is set up, their values are data.
    return `{${Object.entries(value)
      .map(([name, inner]) => `${name}${inner !== null && typeof inner === "object" ? shapeOf(inner, depth + 1, name) : `:${LOGGED_VALUES.has(name) && key !== "customFields" ? JSON.stringify(inner) : kindOfValue(inner)}`}`)
      .join(", ")}}`;
  }
  return kindOfValue(value);
}

const IMG_SOURCE = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']*)["']/gi;

/** A picture address as the log shows it: host and path with numbers kept and names hidden. */
export function pictureAddress(source: string): string {
  if (/^data:/i.test(source)) {
    return "data: (embedded)";
  }
  try {
    const url = new URL(source, "relative://zephyr/");
    const path = url.pathname
      .split("/")
      .map((part) => (/^\d+$/.test(part) || /^(rest|api|v\d+|attachments?|images?|testcases?|teststeps?|files?|content|thumbnail|download|tests|\d\.\d)$/i.test(part) || part === "" ? part : "…"))
      .join("/");
    return url.protocol === "relative:" ? `(relative) ${path}` : `${url.protocol}//${url.host}${path}`;
  } catch {
    return "(unreadable address)";
  }
}

/** Picture addresses in the rich text of a test case and its steps. */
export function pictures(item: ZephyrCase): { where: string; source: string }[] {
  const found: { where: string; source: string }[] = [];
  const scan = (where: string, text: string | null | undefined) => {
    for (const match of (text ?? "").matchAll(IMG_SOURCE)) {
      found.push({ where, source: match[1]! });
    }
  };
  scan("objective", item.testCase.objective);
  scan("precondition", item.testCase.precondition);
  for (const [name, value] of Object.entries(item.testCase.customFields ?? {})) {
    scan(`custom field "${name}"`, typeof value === "string" ? value : null);
  }
  item.steps.forEach((step, index) => {
    scan(`step ${index + 1}`, step.inline?.description);
    scan(`step ${index + 1} data`, step.inline?.testData);
    scan(`step ${index + 1} expected`, step.inline?.expectedResult);
  });
  scan("script", item.script?.text);
  return found;
}

function stepCount(steps: PlannedStep[]): number {
  return steps.reduce((sum, step) => sum + 1 + (step.type === "step" ? stepCount(step.steps ?? []) : 0), 0);
}

/**
 * What was read for one test case and what it becomes, for the detailed log: counts, field names,
 * kinds of values, names of files and the shape of picture addresses, never the text.
 */
export function caseSummary(item: ZephyrCase, planned: PlannedCase, matched: (source: string) => boolean): string {
  const { testCase } = item;
  const parts: string[] = [];
  const calls = item.steps.filter((step) => step.testCase).map((step) => `${step.testCase!.testCaseKey}${step.testCase!.parameters?.length ? ` with ${step.testCase!.parameters.length} parameter(s)` : ""}`);
  parts.push(`script ${JSON.stringify(testCase.testScript?.self?.split("/").pop() ?? null)}`);
  parts.push(`${item.steps.length} step(s)${calls.length > 0 ? ` (calls ${calls.join(", ")})` : ""}${item.steps.some((step) => step.id === undefined || step.id === null) ? ", steps without ids" : ""}`);
  if (item.script) {
    parts.push(`${item.script.type} script of ${item.script.text.split("\n").length} line(s)`);
  }
  parts.push(`custom fields ${Object.entries(testCase.customFields ?? {}).map(([name, value]) => `"${name}"=${Array.isArray(value) ? `list ${value.length}` : kindOfValue(value)}`).join(", ") || "none"}`);
  parts.push(`${testCase.links?.issues?.length ?? 0} issue link(s) (${[...new Set((testCase.links?.issues ?? []).map((link) => link.type ?? "?"))].join(", ") || "none"}), ${testCase.links?.webLinks?.length ?? 0} web link(s)`);
  parts.push(`${item.attachments.length} file(s)${item.attachments.length > 0 ? ` [${item.attachments.map((file) => file.name).join(", ")}]` : ""}`);
  const stepFiles = [...item.stepAttachments.entries()].filter(([, files]) => files.length > 0).map(([stepId, files]) => `step ${stepId}: ${files.map((file) => file.name).join(", ")}`);
  if (stepFiles.length > 0) {
    parts.push(`step files ${stepFiles.join("; ")}`);
  }
  const found = pictures(item);
  if (found.length > 0) {
    parts.push(`pictures in text: ${found.map(({ where, source }) => `${where} ${pictureAddress(source)}${matched(source) ? " (a file of the test case)" : " (not a known file, left as a link)"}`).join("; ")}`);
  }
  parts.push(
    `becomes: ${stepCount(planned.scenario)} scenario step(s), ${planned.attachments.length} file(s), custom fields ${Object.keys(planned.customFields).join(", ") || "none"}, ` +
      `status ${planned.status ? "set" : "none"}, owner ${planned.owner ? "set" : "none"}, ${planned.members.length} member(s), ${planned.links.length} link(s), ${planned.issues.length} issue(s), ${planned.tags.length} tag(s)` +
      `${planned.notes.length > 0 ? `, notes ${[...new Set(planned.notes.map((note) => note.code))].join(", ")}` : ""}`,
  );
  return parts.join("; ");
}
