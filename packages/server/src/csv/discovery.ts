import {
  mergeSuggestedMappings,
  type FieldTarget,
  type Profile,
  type SectionLevelInfo,
  type SourceDiscovery,
  type SourceFieldInfo,
} from "@atm/shared";
import type { FileStore } from "../storage/fileStore.js";
import { columnFor, groupCases, values, type CsvCase } from "./cases.js";
import { readTable, type CsvTable } from "./parse.js";
import { detectStepFormat } from "./steps.js";

const PATH_SEPARATORS = [" > ", ">", " / ", "/", " \\ ", "\\", " » ", "»", "::", " | "];
const OPTION_LIMIT = 200;
const PATH_HEADER = /path|folder|section|suite|hierarch|module|tree/i;
const EXAMPLES = 3;

export interface LoadedCsv {
  table: CsvTable;
  fileName: string;
}

export async function loadCsv(profile: Profile, files: FileStore): Promise<LoadedCsv> {
  if (!profile.csv.fileId) {
    throw new Error("Choose a CSV file first.");
  }
  const { info, data } = await files.read(profile.csv.fileId);
  return {
    fileName: info.name,
    table: readTable(data, { delimiter: profile.csv.delimiter, quote: profile.csv.quote, encoding: profile.csv.encoding }),
  };
}

/** The separator used by most values of a column, if it looks like a path. */
export function detectPathSeparator(samples: string[]): string | null {
  // URLs, dates and long text also contain slashes; a path is short and has no line breaks.
  const filled = samples.filter((v) => v && v.length <= 300 && !v.includes("\n") && !/^[a-z]+:\/\//i.test(v) && !/^\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}/.test(v));
  if (filled.length < samples.filter(Boolean).length * 0.8) {
    return null;
  }
  if (filled.length === 0) {
    return null;
  }
  let best: string | null = null;
  let bestShare = 0;
  for (const separator of PATH_SEPARATORS) {
    const share = filled.filter((v) => v.includes(separator)).length / filled.length;
    if (share > bestShare + 0.001) {
      best = separator;
      bestShare = share;
    }
  }
  // Spaced variants first: " > " beats ">" when both match the same values.
  return bestShare >= 0.3 ? best : null;
}

export function splitPath(value: string, separator: string): string[] {
  return value
    .split(separator)
    .map((part) => part.trim())
    .filter(Boolean);
}

const HINTS: { test: RegExp; target: FieldTarget; separator?: string }[] = [
  { test: /^allure[ _-]?id$/i, target: { kind: "ignore" } },
  { test: /^(id|key|case ?id|test ?case ?id|test ?id|test ?key|external ?id|issue ?key)$/i, target: { kind: "sourceId" } },
  { test: /^(name|title|summary|test ?case( ?name| ?title)?|case ?(name|title)|test ?(name|title))$/i, target: { kind: "name" } },
  { test: /pre-?cond|prerequisite/i, target: { kind: "precondition", heading: "" } },
  { test: /descr|objective|purpose/i, target: { kind: "description", heading: "" } },
  { test: /^(tags?|labels?|keywords?)$/i, target: { kind: "tag" }, separator: "," },
  { test: /^(links?|urls?)$/i, target: { kind: "link" }, separator: "," },
  { test: /jira|^issues?$|requirement|^refs?$|^references?$|stor(y|ies)/i, target: { kind: "issue", integrationId: null }, separator: "," },
  { test: /layer/i, target: { kind: "layer" } },
  { test: /^(status|state)$/i, target: { kind: "status" } },
  { test: /^(owner|author|created ?by|creator)$/i, target: { kind: "owner" } },
];

const STEPS_HEADER = /^(steps?|scenario|test ?steps?|actions?|step ?actions?|procedure|test ?script|step ?description)$/i;
const EXPECTED_HEADER = /expected/i;
const ROLE_HEADER = /^(reviewers?|testers?|assignees?|leads?|team ?leads?|qa|developers?)$/i;

function roleName(header: string): string {
  const singular = header.trim().replace(/s$/i, "");
  return singular.charAt(0).toUpperCase() + singular.slice(1).toLowerCase();
}

function suggest(header: string, samples: string[], context: { multiRow: boolean; hasSteps: boolean; distinct: number; cases: number }): {
  target: FieldTarget;
  separator?: string;
} {
  // "created_by", "Created-By" and "Created By" are the same header.
  const column = header.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (STEPS_HEADER.test(column)) {
    return { target: { kind: "scenario" } };
  }
  if (EXPECTED_HEADER.test(column)) {
    return { target: context.hasSteps && (context.multiRow || /step/i.test(column) || context.hasSteps) ? { kind: "scenarioExpected" } : { kind: "expectedResult", heading: "" } };
  }
  if (ROLE_HEADER.test(column)) {
    return { target: { kind: "role", role: roleName(column) }, separator: "," };
  }
  for (const hint of HINTS) {
    if (hint.test.test(column)) {
      return { target: hint.target, separator: hint.separator };
    }
  }
  const long = samples.some((v) => v.includes("\n") || v.length > 120);
  if (long) {
    return { target: { kind: "description", heading: header } };
  }
  if (samples.every((v) => /^https?:\/\//i.test(v)) && samples.length > 0) {
    return { target: { kind: "link" } };
  }
  const commaLists = samples.filter((v) => v.includes(",")).length > samples.length / 2;
  return { target: { kind: "customField", name: header }, separator: commaLists ? "," : undefined };
}

function levelsOf(paths: string[][]): SectionLevelInfo[] {
  const levels: SectionLevelInfo[] = [];
  const names: Set<string>[] = [];
  for (const path of paths) {
    path.forEach((name, index) => {
      names[index] ??= new Set();
      levels[index] ??= { level: index + 1, sectionCount: 0, caseCount: 0, examples: [] };
      const level = levels[index]!;
      // Section names are only unique within their parent.
      const qualified = path.slice(0, index + 1).join("\u0000");
      if (!names[index]!.has(qualified)) {
        names[index]!.add(qualified);
        level.sectionCount += 1;
        if (level.examples.length < 5 && !level.examples.includes(name)) {
          level.examples.push(name);
        }
      }
    });
    if (path.length > 0) {
      levels[path.length - 1]!.caseCount += 1;
    }
  }
  return levels;
}

export function casePath(testCase: CsvCase, column: string | null, separator: string | null): string[] {
  if (!column || !separator) {
    return [];
  }
  return splitPath(values(testCase, column)[0] ?? "", separator);
}

/**
 * Column information and the profile with suggestions for columns the user has not mapped yet,
 * so grouping can use the name and id columns before the user reviews the mapping.
 */
export function analyseColumns(profile: Profile, table: CsvTable): { fieldsInfo: SourceFieldInfo[]; effective: Profile } {
  const hasSteps = table.columns.some((c) => STEPS_HEADER.test(c.replace(/[_-]+/g, " ").trim()));
  const firstPass = groupCases(table, { ...profile, fields: mergeSuggestedMappings(profile.fields, table.columns.map((c) => columnInfo(c, [], false, hasSteps, table.rows.length, 0)), null) });
  const fieldsInfo = table.columns.map((column) => {
    const samples = table.rows.map((row) => (row[column] ?? "").trim()).filter(Boolean);
    const info = columnInfo(column, samples, firstPass.multiRow, hasSteps, firstPass.cases.length, new Set(samples).size);
    // The section path column feeds the levels, not a field of its own.
    return column === profile.csv.pathColumn ? { ...info, suggestedTarget: { kind: "ignore" as const }, suggestedSeparator: undefined } : info;
  });
  return { fieldsInfo, effective: { ...profile, fields: mergeSuggestedMappings(profile.fields, fieldsInfo, null) } };
}

export async function discoverCsv(profile: Profile, files: FileStore): Promise<SourceDiscovery> {
  const { table, fileName } = await loadCsv(profile, files);
  const warnings = [...table.warnings];
  const { fieldsInfo, effective } = analyseColumns(profile, table);
  const grouped = groupCases(table, effective);
  warnings.push(...grouped.warnings);

  // Section path: the configured column, or a detected one.
  const pathCandidates = table.columns
    .map((column) => ({ column, separator: detectPathSeparator(table.rows.map((row) => (row[column] ?? "").trim())) }))
    .filter((c): c is { column: string; separator: string } => c.separator !== null && !effective.fields.some((m) => m.source === c.column && ["name", "sourceId", "scenario", "scenarioExpected"].includes(m.target.kind)))
    .sort((a, b) => Number(PATH_HEADER.test(b.column)) - Number(PATH_HEADER.test(a.column)));
  const pathColumn = profile.csv.pathColumn;
  const pathSeparator = pathColumn
    ? profile.csv.pathSeparator === "auto"
      ? detectPathSeparator(table.rows.map((row) => (row[pathColumn] ?? "").trim())) ?? " > "
      : profile.csv.pathSeparator
    : null;
  if (pathColumn && !table.columns.includes(pathColumn)) {
    warnings.push(`The section path column "${pathColumn}" is not in this file.`);
  }
  const paths = grouped.cases.map((c) => casePath(c, pathColumn, pathSeparator));
  const levels = levelsOf(paths);
  const distinctPaths = [...new Map(paths.map((p) => [p.join("\u0000"), p])).values()].sort((a, b) => b.length - a.length);

  const scenarioColumn = columnFor(effective, "scenario");
  const scenarioSample = scenarioColumn ? table.rows.map((row) => row[scenarioColumn] ?? "").find((v) => v.includes("\n")) ?? "" : "";

  return {
    source: "csv",
    project: { id: 0, name: fileName, suiteMode: 1 },
    suites: [{ id: 0, name: fileName }],
    structure: [
      {
        suite: { id: 0, name: fileName },
        sectionCount: levels.reduce((sum, l) => sum + l.sectionCount, 0),
        maxDepth: levels.length,
        levels,
        examplePaths: distinctPaths.slice(0, 5),
      },
    ],
    maxDepth: levels.length,
    levels,
    fields: fieldsInfo,
    sampledCases: grouped.cases.length,
    sampleCaseIds: grouped.cases.slice(0, 100).map((c) => ({ id: c.key, name: c.name || `Line ${c.line}` })),
    warnings,
    csv: {
      fileName,
      delimiter: table.delimiter,
      encoding: table.encoding,
      rowCount: table.rows.length,
      caseCount: grouped.cases.length,
      multiRow: grouped.multiRow,
      pathColumn,
      pathSeparator,
      pathCandidates,
      stepFormat: profile.csv.steps.format === "auto" ? (scenarioSample ? detectStepFormat(scenarioSample) : null) : profile.csv.steps.format,
    },
  };
}

function columnInfo(column: string, samples: string[], multiRow: boolean, hasSteps: boolean, cases: number, distinct: number): SourceFieldInfo {
  const suggestion = suggest(column, samples, { multiRow, hasSteps, distinct, cases });
  const separator = suggestion.separator;
  const counts = new Map<string, number>();
  for (const sample of samples) {
    const parts = separator ? sample.split(separator).map((p) => p.trim()).filter(Boolean) : [sample];
    for (const part of parts) {
      counts.set(part, (counts.get(part) ?? 0) + 1);
    }
  }
  const lowCardinality = counts.size > 0 && counts.size <= OPTION_LIMIT && counts.size <= Math.max(10, samples.length * 0.6) && samples.every((s) => s.length <= 200);
  return {
    systemName: column,
    label: column,
    kind: "column",
    system: false,
    options: lowCardinality
      ? [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ id: value, label: value, count }))
      : null,
    filledCount: samples.length,
    examples: lowCardinality ? [] : [...new Set(samples)].slice(0, EXAMPLES).map((v) => v.replace(/\s+/g, " ").slice(0, 160)),
    suggestedTarget: suggestion.target,
    suggestedSeparator: separator,
  };
}
