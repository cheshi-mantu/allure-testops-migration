import {
  mergeSuggestedMappings,
  type Profile,
  type SectionLevelInfo,
  type SourceDiscovery,
  type SourceFieldInfo,
} from "@atm/shared";
import type { FileStore } from "../storage/fileStore.js";
import { columnFor, groupCases, values, type CsvCase } from "./cases.js";
import { readTable, type CsvTable } from "./parse.js";
import { detectStepFormat } from "./steps.js";
import { suggestColumns, type Suggestion } from "./suggest.js";

const PATH_SEPARATORS = [" > ", ">", " / ", "/", " \\ ", "\\", " » ", "»", "::", " | "];
const OPTION_LIMIT = 200;
const PATH_HEADER = /path|folder|section|suite|hierarch|module|tree|путь|папка|раздел/i;
const PATH_ONLY_HEADER = /hierarch|path|folder|tree|путь|папка|иерархи/i;
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
    // A lone unspaced "/" is often part of a name ("Install/Uninstall"): require a real path shape.
    const unspaced = separator.trim() === separator && ["/", "\\", ">"].includes(separator);
    const matches = (v: string) =>
      unspaced ? v.startsWith(separator) || v.split(separator).length > 2 : v.includes(separator);
    const share = filled.filter(matches).length / filled.length;
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
  const suggestions = suggestColumns(table);
  const fieldsInfo = table.columns.map((column) => {
    const samples = table.rows.map((row) => (row[column] ?? "").trim()).filter(Boolean);
    // The section path column feeds the levels, not a field of its own.
    const suggestion = column === profile.csv.pathColumn ? { target: { kind: "ignore" as const } } : suggestions.get(column)!;
    return columnInfo(column, samples, suggestion);
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
  // Columns whose values look like paths, and columns whose header says so (e.g. TestRail's "Section Hierarchy").
  const pathCandidates = table.columns
    .map((column) => {
      const detected = detectPathSeparator(table.rows.map((row) => (row[column] ?? "").trim()));
      return { column, separator: detected ?? (PATH_ONLY_HEADER.test(column) ? " > " : null) };
    })
    .filter((c): c is { column: string; separator: string } => c.separator !== null && !effective.fields.some((m) => m.source === c.column && ["name", "sourceId", "scenario", "scenarioExpected"].includes(m.target.kind)))
    .sort((a, b) => Number(PATH_ONLY_HEADER.test(b.column)) - Number(PATH_ONLY_HEADER.test(a.column)) || Number(PATH_HEADER.test(b.column)) - Number(PATH_HEADER.test(a.column)));
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
  const scenarioValues = scenarioColumn ? table.rows.map((row) => row[scenarioColumn] ?? "").filter((v) => v.trim()) : [];
  const scenarioSample = scenarioValues.find((v) => v.includes("\n")) ?? scenarioValues[0] ?? "";

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

function columnInfo(column: string, samples: string[], suggestion: Suggestion): SourceFieldInfo {
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
