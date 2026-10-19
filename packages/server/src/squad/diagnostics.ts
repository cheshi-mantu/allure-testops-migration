import type { PlannedCase } from "@atm/shared";
import type { SquadCase } from "./types.js";

/**
 * What was read for one test and what it becomes, for the detailed log: counts, file names and the
 * kinds of step text, never the text.
 */
export function testSummary(testCase: SquadCase, planned: PlannedCase): string {
  const parts: string[] = [];
  const steps = testCase.steps;
  const filled = (name: "step" | "data" | "result") => steps.filter((step) => (step[name] ?? "").trim()).length;
  parts.push(`${steps.length} step(s)${steps.length > 0 ? ` (order ${steps.map((step) => step.orderId ?? "?").join(",")}; with step ${filled("step")}, data ${filled("data")}, result ${filled("result")})` : ""}`);
  const markup = steps.filter((step) => /[*_{}[\]|!]|^\s*[#*-]\s/m.test(`${step.step ?? ""}\n${step.data ?? ""}\n${step.result ?? ""}`)).length;
  if (markup > 0) {
    parts.push(`${markup} step(s) with wiki markup`);
  }
  parts.push(`step files ${steps.some((step) => Array.isArray(step.attachments)) ? "named in the step list" : "looked up step by step or not read"}`);
  const stepFiles = [...testCase.stepAttachments.entries()].filter(([, files]) => files.length > 0).map(([stepId, files]) => `step ${stepId}: ${files.map((file) => file.name).join(", ")}`);
  if (stepFiles.length > 0) {
    parts.push(stepFiles.join("; "));
  }
  const issueFiles = ((testCase.issue.fields.attachment as { filename?: string }[] | undefined) ?? []).map((file) => file.filename ?? "?");
  parts.push(`${issueFiles.length} issue file(s)${issueFiles.length > 0 ? ` [${issueFiles.join(", ")}]` : ""}`);
  parts.push(
    `becomes: ${planned.scenario.length} scenario step(s), ${planned.attachments.length} file(s) from text, custom fields ${Object.keys(planned.customFields).join(", ") || "none"}, ` +
      `status ${planned.status ? "set" : "none"}, owner ${planned.owner ? "set" : "none"}, ${planned.links.length} link(s), ${planned.issues.length} issue(s), ${planned.comments.length} comment(s)` +
      `${planned.notes.length > 0 ? `, notes ${[...new Set(planned.notes.map((note) => note.code))].join(", ")}` : ""}`,
  );
  return parts.join("; ");
}
