import type { PlannedAttachment, PlannedStep } from "@atm/shared";
import type { TrStep } from "../testrail/types.js";
import { ATTACHMENT_SCHEME, convertStepText, convertText, tableToCsv, type Table, type TextOptions } from "./markup.js";

export function inlineAttachment(sourceId: string): PlannedAttachment {
  return { sourceId, fileName: `attachment-${sourceId}` };
}

function tableAttachments(tables: Table[], prefix: string): PlannedAttachment[] {
  return tables.map((table, index) => ({
    sourceId: null,
    fileName: `${prefix}-table-${index + 1}.csv`,
    content: tableToCsv(table),
  }));
}

function part(raw: string | null | undefined, prefix: string, options: TextOptions): { text: string | null; attachments: PlannedAttachment[] } {
  if (!raw || raw.trim() === "") {
    return { text: null, attachments: [] };
  }
  const converted = convertStepText(raw, options);
  return {
    text: converted.body || null,
    attachments: [...converted.attachmentIds.map(inlineAttachment), ...tableAttachments(converted.tables, prefix)],
  };
}

export function buildStep(
  content: string | null | undefined,
  expected: string | null | undefined,
  data: string | null | undefined,
  index: number,
  options: TextOptions,
): PlannedStep {
  const body = part(content, `step-${index}`, options);
  const extra = part(data, `step-${index}-data`, options);
  const result = part(expected, `step-${index}-expected`, options);
  return {
    type: "step",
    body: body.text ?? (body.attachments.length > 0 ? "See attachment" : ""),
    attachments: body.attachments,
    data: extra.text,
    dataAttachments: extra.attachments,
    expected: result.text,
    expectedAttachments: result.attachments,
  };
}

/**
 * Steps from a "separated steps" field. TestRail expands shared steps into their individual steps,
 * each carrying `shared_step_id`; consecutive ones collapse into a single shared step reference.
 */
export function separatedSteps(steps: TrStep[], options: TextOptions, useSharedSteps: boolean): PlannedStep[] {
  const result: PlannedStep[] = [];
  let lastShared: number | null = null;
  steps.forEach((step, index) => {
    const sharedId = step.shared_step_id ?? null;
    if (sharedId !== null && useSharedSteps) {
      if (sharedId !== lastShared) {
        result.push({ type: "shared", sourceId: sharedId, name: "" });
      }
      lastShared = sharedId;
      return;
    }
    lastShared = null;
    const planned = buildStep(step.content, step.expected, step.additional_info, index + 1, options);
    if (planned.type === "step" && (planned.body || planned.expected || planned.data)) {
      result.push(planned);
    }
  });
  return result;
}

const TABLE_LINE = /^\s*\|/;
const IMAGE_ONLY_LINE = new RegExp(`^\\s*(!\\[[^\\]]*\\]\\(${ATTACHMENT_SCHEME}[A-Za-z0-9-]+\\)\\s*)+$`);

/**
 * Steps from a plain text field. In `lines` mode every line becomes a step; table blocks and
 * lines holding only images are attached to the step before them.
 */
export function textSteps(raw: string, mode: "lines" | "single", options: TextOptions): PlannedStep[] {
  if (raw.trim() === "") {
    return [];
  }
  if (mode === "single") {
    return [buildStep(raw, null, null, 1, options)];
  }
  // Convert once so HTML and TestRail tables become Markdown before splitting into lines.
  const markdown = convertText(raw, options).text;
  const chunks: string[] = [];
  for (const line of markdown.split("\n")) {
    const previous = chunks.length - 1;
    if (line.trim() === "") {
      continue;
    }
    if ((TABLE_LINE.test(line) || IMAGE_ONLY_LINE.test(line)) && previous >= 0) {
      chunks[previous] += `\n${line}`;
      continue;
    }
    chunks.push(line.replace(/^\s*(?:\d+[.)]|[-*•])\s+/, ""));
  }
  // Chunks are Markdown already; convert again only to split tables and images out of the body.
  return chunks.map((chunk, index) => buildStep(chunk, null, null, index + 1, { format: "markdown" }));
}
