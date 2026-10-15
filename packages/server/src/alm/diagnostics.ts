import type { PlannedCase, PlannedStep } from "@atm/shared";
import { isUrlAttachment } from "./transform.js";
import { idOf, one, type AlmRecord, type AlmTest } from "./types.js";

const IMG_SOURCE = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']*)["']/gi;
const PLACEHOLDER = "file://[IMAGE_BASE_PATH_PLACEHOLDER]";

/** Picture addresses in the HTML values of a record. */
function pictures(record: AlmRecord): string[] {
  return Object.values(record.fields).flatMap((values) => values.flatMap((value) => [...value.matchAll(IMG_SOURCE)].map((match) => match[1]!)));
}

/** A picture address as the log shows it: the name for ALM pictures, else the scheme and host only. */
function pictureAddress(source: string): string {
  if (source.startsWith(PLACEHOLDER)) {
    return source.slice(PLACEHOLDER.length);
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(source)?.[1];
  if (scheme === "data") {
    return "data: (embedded)";
  }
  try {
    const url = new URL(source);
    return `${url.protocol}//${url.host}/…`;
  } catch {
    return `${source.slice(0, 30)}…`;
  }
}

function stepCount(steps: PlannedStep[]): number {
  return steps.reduce((sum, step) => sum + 1 + (step.type === "step" ? stepCount(step.steps ?? []) : 0), 0);
}

/**
 * What was read for one test and what it becomes, for the detailed log: counts, the field names and
 * kinds of values, the names of files and pictures, never the text of the test.
 */
export function testSummary(test: AlmTest, planned: PlannedCase): string {
  const parts: string[] = [];
  const calls = test.steps.map((step) => Number(one(step, "link-test") ?? 0)).filter((id) => id > 0);
  const orders = test.steps.map((step) => one(step, "step-order") ?? "?");
  parts.push(`${test.steps.length} design step(s)${test.steps.length > 0 ? ` (step-order ${orders.join(",")}${calls.length > 0 ? `; calls test ${calls.join(", ")}` : ""})` : ""}`);
  parts.push(`${test.parameters.length} parameter(s)`);
  const files = test.attachments.filter((file) => !isUrlAttachment(file)).map((file) => one(file, "name"));
  const links = test.attachments.filter(isUrlAttachment).length;
  parts.push(`attachment flag ${JSON.stringify(one(test.test, "attachment") ?? "")}, ${files.length} file(s)${files.length > 0 ? ` [${files.join(", ")}]` : ""}${links > 0 ? `, ${links} URL attachment(s)` : ""}`);
  const stepFiles = [...test.stepAttachments.entries()].map(([stepId, list]) => `step ${stepId}: ${list.map((file) => one(file, "name")).join(", ")}`);
  if (stepFiles.length > 0) {
    parts.push(`step files ${stepFiles.join("; ")}`);
  }
  // Pictures in text: ALM keeps them as attachments of the test or step, named in the address.
  const listed = new Set([...test.attachments, ...[...test.stepAttachments.values()].flat()].map((file) => one(file, "name")));
  const found = [...pictures(test.test).map((source) => ({ source, where: "test" })), ...test.steps.flatMap((step) => pictures(step).map((source) => ({ source, where: `step ${idOf(step)}` })))];
  if (found.length > 0) {
    parts.push(
      `pictures in text: ${found
        .map(({ source, where }) => {
          const known = source.startsWith(PLACEHOLDER);
          return `${where} ${pictureAddress(source)}${known ? (listed.has(pictureAddress(source)) ? " (listed)" : " (not listed, read by name)") : " (other address, left as it is)"}`;
        })
        .join("; ")}`,
    );
  }
  parts.push(
    `becomes: ${stepCount(planned.scenario)} scenario step(s), ${planned.attachments.length} file(s), custom fields ${Object.keys(planned.customFields).join(", ") || "none"}, ` +
      `status ${planned.status ?? "none"}, owner ${planned.owner ? "set" : "none"}, ${planned.members.length} member(s), ${planned.links.length} link(s), ${planned.comments.length} comment(s), ${planned.examples?.length ?? 0} example(s)` +
      `${planned.notes.length > 0 ? `, notes ${[...new Set(planned.notes.map((note) => note.code))].join(", ")}` : ""}`,
  );
  return parts.join("; ");
}
