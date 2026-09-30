import type { CsvStepFormat, PlannedStep } from "@atm/shared";

/**
 * Scenario text from a CSV cell to steps. Supported layouts:
 * - `lines`: every line is a step;
 * - `numbered`: "1. ...", "2) ..." start steps, other lines continue the step;
 * - `indented`: tabs or spaces nest sub-steps (the "classic" layout of the previous migration tool);
 * - `testops`: the Allure TestOps CSV export syntax, `[step 1] ...` and `\t[expected.step 1.1] ...`;
 * - `regex`: every match of a pattern starts a new step;
 * - `single`: the whole cell is one step.
 * An optional expected-result pattern turns matching lines or sub-steps into the expected result of their step.
 */

type Step = Extract<PlannedStep, { type: "step" }>;

export interface StepParseOptions {
  format: CsvStepFormat;
  stepPattern: string;
  expectedPattern: string;
}

export function step(body: string): Step {
  return { type: "step", body, attachments: [], data: null, dataAttachments: [], expected: null, expectedAttachments: [] };
}

/** Java style `(?i)` prefixes become JavaScript flags. */
export function compilePattern(pattern: string, extraFlags = ""): RegExp {
  let source = pattern;
  let flags = extraFlags;
  const inline = /^\(\?([imsu]+)\)/.exec(source);
  if (inline) {
    source = source.slice(inline[0].length);
    for (const flag of inline[1]!) {
      if (!flags.includes(flag)) {
        flags += flag;
      }
    }
  }
  return new RegExp(source, flags);
}

/** "Step 1:", "Substep 1.2 -", "Шаг 3." at the start of a step: the numbering Allure TestOps adds itself. */
const STEP_PREFIX = /^(?:sub ?step|step|подшаг|шаг)\s*[\d.]*\s*[:.)\-–]\s*(?=\S)/i;
/** Several "Step:" markers inside one line: "Step: open Step: click". */
const INLINE_MARKER = /(?:^|\s)(?:step|шаг)\s*\d*\s*[:.)]\s*/gi;

const TESTOPS_LINE = /^(\t*)\[(step|attachment|shared|expected|expected\.step|expected\.attachment)(?:\s[\d.]*)?\]\s?(.*)$/;
/** "1. text", "2) text" and "3.text", but not "1.5 kg". */
const NUMBERED_LINE = /^\s*(\d+)[.)](?!\d)\s*(\S.*)$/;

/** `inline` means step markers inside a line, e.g. "Step: open Step: click". */
export type DetectedStepFormat = Exclude<CsvStepFormat, "auto" | "regex"> | "inline";

export function detectStepFormat(text: string): DetectedStepFormat {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) {
    return "lines";
  }
  if (lines.some((l) => TESTOPS_LINE.test(l))) {
    return "testops";
  }
  if (lines.some((l) => (l.match(INLINE_MARKER)?.length ?? 0) >= 2)) {
    return "inline";
  }
  if (lines.filter((l) => NUMBERED_LINE.test(l)).length >= 2) {
    return "numbered";
  }
  if (lines.slice(1).some((l) => /^(\t| {2,})\S/.test(l))) {
    return "indented";
  }
  return "lines";
}

export function parseSteps(text: string, options: StepParseOptions): PlannedStep[] {
  const source = text.replace(/\r\n?/g, "\n");
  if (source.trim() === "") {
    return [];
  }
  const format = options.format === "auto" ? detectStepFormat(source) : options.format;
  let steps: Step[];
  switch (format) {
    case "single":
      steps = [step(source.trim())];
      break;
    case "numbered":
      steps = numbered(source);
      break;
    case "indented":
      steps = indented(source);
      break;
    case "testops":
      steps = testops(source);
      break;
    case "regex":
      steps = options.stepPattern ? byPattern(source, compilePattern(options.stepPattern, "g")) : lines(source);
      break;
    case "inline":
      steps = byPattern(source, new RegExp(INLINE_MARKER.source, "gi"));
      break;
    default:
      steps = lines(source);
  }
  if (options.expectedPattern) {
    const marker = compilePattern(options.expectedPattern);
    steps.forEach((s) => extractExpected(s, marker));
  }
  steps.forEach(stripStepPrefix);
  return steps;
}

function stripStepPrefix(target: Step) {
  target.body = target.body.replace(STEP_PREFIX, "");
  target.steps?.forEach((child) => child.type === "step" && stripStepPrefix(child));
}

function lines(text: string): Step[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => step(l.replace(/^(?:\d+[.)](?!\d)\s*|[-*•]\s+)/, "")));
}

function numbered(text: string): Step[] {
  const result: Step[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const match = NUMBERED_LINE.exec(line);
    if (match) {
      result.push(step(match[2]!.trim()));
    } else if (result.length > 0) {
      const last = result[result.length - 1]!;
      last.body = `${last.body}\n${line.trim()}`;
    } else {
      result.push(step(line.trim()));
    }
  }
  return result;
}

function indentOf(line: string, unit: number): number {
  const leading = /^[\t ]*/.exec(line)![0];
  let width = 0;
  for (const char of leading) {
    width += char === "\t" ? unit : 1;
  }
  return Math.floor(width / unit);
}

function indented(text: string): Step[] {
  const all = text.split("\n").filter((l) => l.trim() !== "");
  // Spaces: the smallest indentation used is one level. Tabs are always one level.
  const spaceIndents = all.map((l) => /^ +/.exec(l)?.[0].length ?? 0).filter((n) => n > 0);
  const unit = spaceIndents.length > 0 ? Math.min(...spaceIndents) : 1;
  const roots: Step[] = [];
  const stack: { level: number; step: Step }[] = [];
  for (const line of all) {
    const level = /^\t/.test(line) ? /^\t*/.exec(line)![0].length : indentOf(line, unit);
    const current = step(line.trim());
    while (stack.length > 0 && stack[stack.length - 1]!.level >= level) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (parent) {
      (parent.step.steps ??= []).push(current);
    } else {
      roots.push(current);
    }
    stack.push({ level, step: current });
  }
  return roots;
}

function testops(text: string): Step[] {
  const roots: Step[] = [];
  const stack: { level: number; step: Step }[] = [];
  let lastTarget: { step: Step; expected: boolean } | null = null;
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const match = TESTOPS_LINE.exec(line);
    if (!match) {
      // Continuation of the previous step or expected result.
      if (lastTarget) {
        if (lastTarget.expected) {
          lastTarget.step.expected = `${lastTarget.step.expected ?? ""}\n${line.trim()}`.trim();
        } else {
          lastTarget.step.body = `${lastTarget.step.body}\n${line.trim()}`;
        }
      } else {
        const created = step(line.trim());
        roots.push(created);
        stack.push({ level: 0, step: created });
        lastTarget = { step: created, expected: false };
      }
      continue;
    }
    const level = match[1]!.length;
    const keyword = match[2]!;
    const body = match[3]!.trim();
    if (keyword.startsWith("expected")) {
      const owner = [...stack].reverse().find((entry) => entry.level < level)?.step ?? stack[stack.length - 1]?.step;
      const text = keyword === "expected.attachment" ? `Attachment: ${body}` : body;
      if (owner) {
        owner.expected = owner.expected ? `${owner.expected}\n${text}` : text;
        lastTarget = { step: owner, expected: true };
      }
      continue;
    }
    const current = step(keyword === "attachment" ? `Attachment: ${body}` : keyword === "shared" ? `Shared step: ${body}` : body);
    while (stack.length > 0 && stack[stack.length - 1]!.level >= level) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (parent) {
      (parent.step.steps ??= []).push(current);
    } else {
      roots.push(current);
    }
    stack.push({ level, step: current });
    lastTarget = { step: current, expected: false };
  }
  return roots;
}

function byPattern(text: string, pattern: RegExp): Step[] {
  const starts = [...text.matchAll(pattern)].filter((m) => m[0] !== "").map((m) => ({ index: m.index!, length: m[0].length }));
  if (starts.length === 0) {
    return [step(text.trim())];
  }
  const result: Step[] = [];
  const before = text.slice(0, starts[0]!.index).trim();
  if (before) {
    result.push(step(before));
  }
  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1]!.index : text.length;
    const body = text.slice(start.index + start.length, end).trim();
    if (body) {
      result.push(step(body));
    }
  });
  return result;
}

/**
 * Moves expected results out of a step: a body line starting with the marker (inline style),
 * or a sub-step starting with it; a marker sub-step with a single child uses the child as the text.
 */
function extractExpected(target: Step, marker: RegExp) {
  const addExpected = (text: string) => {
    if (text) {
      target.expected = target.expected ? `${target.expected}\n${text}` : text;
    }
  };
  const bodyLines = target.body.split("\n");
  const at = bodyLines.findIndex((line) => startsWith(line, marker));
  if (at >= 0) {
    addExpected([stripMarker(bodyLines[at]!, marker), ...bodyLines.slice(at + 1)].join("\n").trim());
    target.body = bodyLines.slice(0, at).join("\n").trim() || target.body;
    if (at === 0) {
      target.body = "Untitled step";
    }
  } else {
    // "Do something Expected: it works" on one line.
    const inline = findInline(target.body, marker);
    if (inline > 0) {
      addExpected(stripMarker(target.body.slice(inline), marker));
      target.body = target.body.slice(0, inline).trim();
    }
  }
  if (target.steps) {
    const kept: PlannedStep[] = [];
    for (const child of target.steps) {
      if (child.type === "step" && startsWith(child.body, marker)) {
        const rest = stripMarker(child.body, marker);
        const only = child.steps?.length === 1 && child.steps[0]!.type === "step" ? child.steps[0]!.body : null;
        addExpected(rest || only || "");
        continue;
      }
      if (child.type === "step") {
        extractExpected(child, marker);
      }
      kept.push(child);
    }
    target.steps = kept.length > 0 ? kept : undefined;
  }
}

function startsWith(text: string, marker: RegExp): boolean {
  const match = new RegExp(marker.source, marker.flags.replace("g", "")).exec(text.trimStart());
  return match !== null && match.index === 0;
}

function stripMarker(text: string, marker: RegExp): string {
  const trimmed = text.trimStart();
  const match = new RegExp(marker.source, marker.flags.replace("g", "")).exec(trimmed);
  return match && match.index === 0 ? trimmed.slice(match[0].length).replace(/^[\s:\-–]+/, "").trim() : trimmed.trim();
}

function findInline(text: string, marker: RegExp): number {
  const match = new RegExp(marker.source, marker.flags.replace("g", "")).exec(text);
  return match ? match.index : -1;
}

export interface ExpectedItem {
  text: string;
  /** Step number the item names ("3. ..."), when the text is numbered. */
  number?: number;
}

/**
 * Lines up expected results from a separate column with the steps. Numbered items go to the step with
 * that number ("3. Saved" belongs to step 3 even when step 2 has no expected result); others go in order.
 * A single unnumbered expected result for several steps belongs to the last step.
 */
export function attachExpected(steps: PlannedStep[], expected: (ExpectedItem | string)[]): void {
  const targets = steps.filter((s): s is Step => s.type === "step");
  const items = expected.map((e) => (typeof e === "string" ? { text: e } : e)).filter((e) => e.text);
  if (targets.length === 0 || items.length === 0) {
    return;
  }
  const add = (target: Step, text: string) => {
    target.expected = target.expected ? `${target.expected}\n${text}` : text;
  };
  if (items.length === 1 && items[0]!.number === undefined && targets.length > 1) {
    const lines = items[0]!.text.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === targets.length) {
      // As many lines as steps: one expected result per step.
      lines.forEach((line, index) => add(targets[index]!, line));
    } else {
      add(targets[targets.length - 1]!, items[0]!.text);
    }
    return;
  }
  items.forEach((item, index) => {
    const position = item.number !== undefined && item.number >= 1 ? item.number - 1 : index;
    add(targets[Math.min(position, targets.length - 1)]!, item.text);
  });
}

/** Expected results from a separate column: numbered items keep their number, others are split like steps. */
export function parseExpectedTexts(text: string, options: StepParseOptions): ExpectedItem[] {
  const source = text.replace(/\r\n?/g, "\n");
  const numbered = source.split("\n").filter((l) => l.trim()).filter((l) => NUMBERED_LINE.test(l));
  const firstLine = source.trimStart().split("\n")[0] ?? "";
  if (numbered.length > 0 && NUMBERED_LINE.test(firstLine)) {
    const items: ExpectedItem[] = [];
    for (const line of source.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      const match = NUMBERED_LINE.exec(line);
      if (match) {
        items.push({ number: Number(match[1]), text: match[2]!.trim() });
      } else if (items.length > 0) {
        items[items.length - 1]!.text += `\n${line.trim()}`;
      }
    }
    return items;
  }
  const parsed = parseSteps(source, { ...options, expectedPattern: "" });
  const flatten = (s: PlannedStep): string => (s.type === "step" ? [s.body, ...(s.steps ?? []).map(flatten)].join("\n") : s.name);
  // An unstructured cell is one expected result, not one per line.
  const format = options.format === "auto" ? detectStepFormat(source) : options.format;
  return format === "lines" ? [{ text: source.trim() }] : parsed.map((s) => ({ text: flatten(s) })).filter((e) => e.text);
}
