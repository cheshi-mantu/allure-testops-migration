import { createHash } from "node:crypto";
import type { FieldMapping, Profile } from "@atm/shared";
import type { CsvTable } from "./parse.js";

/** One test case made from one or more CSV rows. */
export interface CsvCase {
  /** Stable key: the source id column, or a hash of the name. Becomes the migration tag. */
  key: string;
  name: string;
  /** 1-based line of the first row. */
  line: number;
  rows: Record<string, string>[];
}

export function columnFor(profile: Profile, kind: FieldMapping["target"]["kind"]): string | null {
  return profile.fields.find((m) => m.target.kind === kind)?.source ?? null;
}

const STEP_KINDS = new Set(["scenario", "scenarioExpected"]);

/**
 * A row continues the previous case when it has no name and no id but has content, the typical
 * "one step per row" export. Rows sharing the id of the previous row are merged too.
 */
export function detectMultiRow(table: CsvTable, nameColumn: string | null, idColumn: string | null): boolean {
  if (!nameColumn && !idColumn) {
    return false;
  }
  let previousId: string | null = null;
  for (const row of table.rows) {
    const name = nameColumn ? (row[nameColumn] ?? "").trim() : "";
    const id = idColumn ? (row[idColumn] ?? "").trim() : "";
    const hasContent = Object.values(row).some((v) => v.trim() !== "");
    if (!name && !id && hasContent) {
      return true;
    }
    if (id && id === previousId) {
      return true;
    }
    previousId = id || previousId;
  }
  return false;
}

function hashKey(name: string): string {
  return `n${createHash("sha1").update(name.trim().toLowerCase()).digest("hex").slice(0, 10)}`;
}

export interface GroupResult {
  cases: CsvCase[];
  multiRow: boolean;
  warnings: string[];
}

export function groupCases(table: CsvTable, profile: Profile): GroupResult {
  const nameColumn = columnFor(profile, "name");
  const idColumn = columnFor(profile, "sourceId");
  const warnings: string[] = [];
  const multiRow = profile.csv.rows === "multi" || (profile.csv.rows === "auto" && detectMultiRow(table, nameColumn, idColumn));
  const cases: CsvCase[] = [];
  let current: CsvCase | null = null;
  let unnamed = 0;

  table.rows.forEach((row, index) => {
    const line = table.lines[index] ?? index + 2;
    const name = nameColumn ? (row[nameColumn] ?? "").trim() : "";
    const id = idColumn ? (row[idColumn] ?? "").trim() : "";
    if (multiRow && current && ((!name && !id) || (id && id === current.key && !isNameChange(current, name)))) {
      current.rows.push(row);
      return;
    }
    if (!name && !id && !Object.values(row).some((v) => v.trim() !== "")) {
      return;
    }
    current = { key: id || (name ? hashKey(name) : `line${line}`), name, line, rows: [row] };
    if (!name) {
      unnamed += 1;
    }
    cases.push(current);
  });

  // Keys must be unique, otherwise reruns would mix cases up.
  const seen = new Map<string, number>();
  let duplicates = 0;
  for (const testCase of cases) {
    const count = (seen.get(testCase.key) ?? 0) + 1;
    seen.set(testCase.key, count);
    if (count > 1) {
      duplicates += 1;
      testCase.key = `${testCase.key}-${count}`;
    }
  }
  if (!nameColumn) {
    warnings.push("No column is mapped to the test case name.");
  } else if (unnamed > 0) {
    warnings.push(`${unnamed} case(s) have no name; they will fail to migrate.`);
  }
  if (!idColumn) {
    warnings.push("No column is mapped to the source id, so cases are recognised by name on reruns. Renaming a case in the file creates a new one.");
  }
  if (duplicates > 0) {
    warnings.push(
      idColumn
        ? `${duplicates} case(s) repeat an id already used earlier in the file; they get a numbered key.`
        : `${duplicates} case(s) repeat a name used earlier in the file; they get a numbered key, so keep their order stable between runs.`,
    );
  }
  return { cases, multiRow, warnings };
}

function isNameChange(current: CsvCase, name: string): boolean {
  return name !== "" && current.name !== "" && name !== current.name;
}

/** Non-empty values of a column over the rows of a case; case level columns usually use the first. */
export function values(testCase: CsvCase, column: string): string[] {
  return testCase.rows.map((row) => (row[column] ?? "").trim()).filter(Boolean);
}

export function isStepColumn(profile: Profile, column: string): boolean {
  return profile.fields.some((m) => m.source === column && STEP_KINDS.has(m.target.kind));
}
