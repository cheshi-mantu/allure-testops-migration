import type { PlannedAttachment, PlannedExample, PlannedStep } from "@atm/shared";
import { markdownTable } from "./markup.js";

/**
 * Tables of Gherkin Examples (Scenario Outline). They are read as a whole, so they never become
 * steps of their own: either a Markdown file of the "Examples" step, or examples of the test case,
 * a set of parameter values each, as the migration options say.
 */

export type ExamplesMode = "attachment" | "examples";

/** Where a transform collects examples of the case, and how tables of Examples are migrated. */
export interface ExamplesSink {
  mode: ExamplesMode;
  examples: PlannedExample[];
}

export function examplesSink(mode: ExamplesMode | undefined): ExamplesSink {
  return { mode: mode ?? "attachment", examples: [] };
}

export interface ExamplesTable {
  header: string[];
  rows: string[][];
}

/** `Examples:` or `Scenarios:`, with an optional name after the colon. */
const EXAMPLES = /^\s*(?:Examples|Scenarios)\s*:/i;
const TABLE_LINE = /^\s*\|/;
const SEPARATOR = /^\|?\s*:?-{3,}/;

export function isExamplesLine(text: string): boolean {
  return EXAMPLES.test(text);
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));

/** Removes the tables that follow `Examples:` lines; the `Examples:` lines stay. */
export function takeExamples(text: string): { text: string; tables: ExamplesTable[] } {
  const lines = text.split("\n");
  const kept: string[] = [];
  const tables: ExamplesTable[] = [];
  for (let i = 0; i < lines.length; i++) {
    kept.push(lines[i]!);
    if (!EXAMPLES.test(lines[i]!)) {
      continue;
    }
    const table: string[] = [];
    while (i + 1 < lines.length && (TABLE_LINE.test(lines[i + 1]!) || (lines[i + 1]!.trim() === "" && table.length === 0))) {
      i += 1;
      if (lines[i]!.trim()) {
        table.push(lines[i]!);
      }
    }
    const rows = table.filter((line) => !SEPARATOR.test(line.trim())).map(cells);
    if (rows.length > 0) {
      tables.push({ header: rows[0]!, rows: rows.slice(1) });
    }
  }
  return { text: kept.join("\n"), tables };
}

function file(table: ExamplesTable, index: number): PlannedAttachment {
  return { sourceId: null, fileName: index === 0 ? "examples.md" : `examples-${index + 1}.md`, content: `${markdownTable(table.header, table.rows)}\n` };
}

/** One example per row: the column titles are the parameter names. */
export function tableExamples(table: ExamplesTable): PlannedExample[] {
  return table.rows.map((row) => table.header.map((name, column) => ({ name, value: row[column] ?? "" })));
}

/**
 * Puts the tables taken out of a scenario where the option says: as a file of the k-th
 * "Examples" step (the last step when the scenario has none), or as examples of the case, without
 * the "Examples" steps.
 */
export function placeExamples(steps: PlannedStep[], tables: ExamplesTable[], sink: ExamplesSink): PlannedStep[] {
  if (tables.length === 0) {
    return steps;
  }
  if (sink.mode === "examples") {
    tables.forEach((table) => sink.examples.push(...tableExamples(table)));
    return steps.filter((step) => !(step.type === "step" && isExamplesLine(step.body) && !step.expected && !step.data && (step.steps ?? []).length === 0));
  }
  const holders = steps.filter((step): step is Extract<PlannedStep, { type: "step" }> => step.type === "step" && isExamplesLine(step.body));
  tables.forEach((table, index) => {
    const holder = holders[index] ?? holders[holders.length - 1] ?? steps.filter((step): step is Extract<PlannedStep, { type: "step" }> => step.type === "step").pop();
    holder?.attachments.push(file(table, index));
  });
  return steps;
}

/** Steps of a text with Examples tables: `parse` reads the text without them, the sink places them. */
export function stepsWithExamples(text: string, parse: (text: string) => PlannedStep[], sink: ExamplesSink): PlannedStep[] {
  const { text: rest, tables } = takeExamples(text);
  return placeExamples(parse(rest), tables, sink);
}
