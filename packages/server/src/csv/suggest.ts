import type { FieldTarget } from "@atm/shared";
import type { CsvTable } from "./parse.js";

/**
 * Suggested targets for CSV columns. Headers give the first hint (English and Russian), the values
 * confirm it, and a pass over the whole file resolves conflicts: which of several step columns is
 * the scenario, which expected result column belongs to the steps, which column names the case.
 */

export interface Suggestion {
  target: FieldTarget;
  separator?: string;
}

interface ColumnFacts {
  column: string;
  header: string;
  samples: string[];
  distinct: number;
  multiline: number;
  numbered: number;
  averageLength: number;
}

/** "created_by", "Created-By:" and "Created By" read the same. */
export function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .replace(/[_\-:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const H = {
  allureId: /^allure ?id$/,
  id: /^(id|key|№|#|no|number|case ?id|test ?case ?id|test ?id|test ?key|external ?id|issue ?key|ид|идентификатор|номер|код|№ п\/п)$/,
  name: /^(name|title|summary|test ?case( ?name| ?title)?|case ?(name|title)|test ?(name|title)|название|наименование|заголовок|имя|название (теста|тест ?кейса|кейса)|тест ?кейс)$/,
  /** Any header that mentions a name or title, when none is exactly one. */
  nameLoose: /name|title|назв|наимен|заголов|имя/,
  /** Names of other things than the case. */
  notName: /user|file|author|owner|creator|project|section|suite|folder|module|component|host|domain|пользовател|файл|автор|проект|раздел|модул|компонент/,
  precondition: /pre ?cond|prerequisit|предуслови|условия/,
  description: /descr|objective|purpose|описание|цель/,
  steps: /^(steps?|scenario|test ?steps?|actions?|step ?actions?|procedure|test ?script|step ?description|шаги|шаг|сценарий|действия|шаги воспроизведения|шаги теста)$/,
  stepsLoose: /step|шаг/,
  expected: /expected|ожидаем|^ор$|^ер$|^результат$/,
  tags: /^(tags?|labels?|keywords?|теги|тэги|метки|ключевые слова)$/,
  links: /links?|urls?|ссылк/,
  issue: /jira|issue|requirement|^refs?$|reference|ticket|^bugs?$|задач|требован|тикет/,
  layer: /layer|слой/,
  status: /^(status|state|статус|состояние)$/,
  owner: /^(owner|author|created ?by|creator|автор|создал|создатель|владелец|ответственный)$/,
  role: /^(reviewers?|testers?|assignees?|leads?|team ?leads?|qa|developers?|ревьюеры?|тестировщики?|исполнители?)$/,
  /** Allure's behaviour hierarchy and similar: a custom field with the same name. */
  hierarchy: /^(epic|feature|story|suite|sub ?suite|parent ?suite|component|module|эпик|фича|история|модуль|компонент)$/,
  meta: /^(created ?on|updated ?on|updated ?by|modified( ?on| ?by)?|last ?modified|forecast|estimate|section ?depth|suite ?id|template|sequence.*|display ?order|version|vc .*)$/,
};

const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
const URL = /^https?:\/\/\S+$/i;
const DATE = /^\d{1,4}[./-]\d{1,2}[./-]\d{1,4}(,? \d{1,2}:\d{2}(:\d{2})?( ?[ap]m)?)?$/i;
const NUMBERED = /^\s*\d+[.)]\s*\S/;

function tokens(values: string[]): string[] {
  return values.flatMap((v) => v.split(/[\s,;]+/)).filter(Boolean);
}

function share(values: string[], test: (v: string) => boolean): number {
  return values.length === 0 ? 0 : values.filter(test).length / values.length;
}

function listSeparator(values: string[]): string | undefined {
  if (share(values, (v) => v.includes(",")) > 0.2) {
    return ",";
  }
  if (share(values, (v) => v.includes(";")) > 0.2) {
    return ";";
  }
  return undefined;
}

function roleName(header: string): string {
  const singular = header.trim().replace(/s$/i, "");
  return singular.charAt(0).toUpperCase() + singular.slice(1);
}

function facts(table: CsvTable): ColumnFacts[] {
  return table.columns.map((column) => {
    const samples = table.rows.map((row) => (row[column] ?? "").trim()).filter(Boolean);
    return {
      column,
      header: normalizeHeader(column),
      samples,
      distinct: new Set(samples).size,
      multiline: share(samples, (v) => v.includes("\n")),
      numbered: share(samples, (v) => NUMBERED.test(v)),
      averageLength: samples.length ? samples.reduce((sum, v) => sum + v.length, 0) / samples.length : 0,
    };
  });
}

/** The part of a header without step/expected words, to pair "X (Step)" with "X (Expected Result)". */
function stem(header: string): string {
  return header
    .replace(/\((step|expected result|expected)\)/g, "")
    .replace(/\b(steps?|expected( results?)?|шаги|шаг|ожидаемы[йе]( результаты?)?)\b/g, "")
    .replace(/[()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function byHeader(f: ColumnFacts): Suggestion | null {
  const h = f.header;
  if (f.samples.length === 0) {
    return { target: { kind: "ignore" } };
  }
  if (H.meta.test(h) || share(f.samples, (v) => DATE.test(v)) === 1) {
    return { target: { kind: "ignore" } };
  }
  if (H.allureId.test(h)) {
    return { target: { kind: "allureId" } };
  }
  if (H.id.test(h)) {
    return { target: { kind: "sourceId" } };
  }
  if (H.name.test(h)) {
    return { target: { kind: "name" } };
  }
  if (H.expected.test(h)) {
    return { target: { kind: "expectedResult", heading: "" } };
  }
  if (H.steps.test(h) || H.stepsLoose.test(h)) {
    return { target: { kind: "scenario" } };
  }
  if (H.precondition.test(h)) {
    return { target: { kind: "precondition", heading: "" } };
  }
  if (H.description.test(h)) {
    return { target: { kind: "description", heading: "" } };
  }
  if (H.tags.test(h)) {
    return { target: { kind: "tag" }, separator: listSeparator(f.samples) ?? "," };
  }
  if (H.hierarchy.test(h)) {
    return { target: { kind: "customField", name: f.column.trim() }, separator: listSeparator(f.samples) };
  }
  if (H.role.test(h)) {
    return { target: { kind: "role", role: roleName(f.column) }, separator: listSeparator(f.samples) ?? "," };
  }
  if (H.owner.test(h)) {
    return { target: { kind: "owner" } };
  }
  if (H.layer.test(h)) {
    return { target: { kind: "layer" } };
  }
  if (H.status.test(h)) {
    return { target: { kind: "status" } };
  }
  return null;
}

function byValues(f: ColumnFacts): Suggestion {
  const parts = tokens(f.samples);
  // Issue keys like ABC-123, whatever the header says.
  if (share(parts, (t) => ISSUE_KEY.test(t)) >= 0.7) {
    return { target: { kind: "issue", integrationId: null }, separator: listSeparator(f.samples) ?? "," };
  }
  if (share(parts, (t) => URL.test(t)) >= 0.9) {
    return { target: { kind: "link" }, separator: listSeparator(f.samples) };
  }
  if (f.multiline > 0 || f.averageLength > 120) {
    return { target: { kind: "description", heading: f.column.trim() } };
  }
  if (H.links.test(f.header) || H.issue.test(f.header)) {
    // Header says links or issues, values say otherwise: keep the data as a field.
    return { target: { kind: "customField", name: f.column.trim() }, separator: listSeparator(f.samples) };
  }
  return { target: { kind: "customField", name: f.column.trim() }, separator: listSeparator(f.samples) };
}

/** Suggestions for all columns of a file. */
export function suggestColumns(table: CsvTable): Map<string, Suggestion> {
  const all = facts(table);
  const result = new Map<string, Suggestion>();
  for (const f of all) {
    result.set(f.column, byHeader(f) ?? byValues(f));
  }
  const kind = (column: string) => result.get(column)!.target.kind;

  // Id: prefer a plain id column; an Allure id is also a stable id when nothing else is.
  const ids = all.filter((f) => kind(f.column) === "sourceId");
  const allureIds = all.filter((f) => kind(f.column) === "allureId");
  for (const extra of ids.slice(1)) {
    result.set(extra.column, { target: { kind: "customField", name: extra.column.trim() } });
  }
  for (const f of allureIds) {
    // Updating cases by Allure id only makes sense for files exported from the target project.
    const unique = f.distinct === f.samples.length;
    result.set(f.column, ids.length === 0 && unique ? { target: { kind: "sourceId" } } : { target: { kind: "ignore" } });
  }

  // Scenario: among step columns pick the one paired with an expected column, else the fullest.
  const expectedColumns = all.filter((f) => kind(f.column) === "expectedResult" && H.expected.test(f.header));
  const stepColumns = all.filter((f) => kind(f.column) === "scenario");
  const pairOf = (f: ColumnFacts) => expectedColumns.find((e) => stem(e.header) === stem(f.header) && e.samples.length > 0);
  // "X (Step)" beats "X", which holds steps and expected results combined.
  const explicitStep = (f: ColumnFacts) => /\((step|шаг)\)/.test(f.header);
  const scenario = [...stepColumns].sort(
    (a, b) =>
      Number(Boolean(pairOf(b))) - Number(Boolean(pairOf(a))) ||
      Number(explicitStep(b)) - Number(explicitStep(a)) ||
      Number(H.steps.test(b.header)) - Number(H.steps.test(a.header)) ||
      b.samples.length - a.samples.length,
  )[0];
  for (const other of stepColumns.filter((f) => f !== scenario)) {
    // "X" next to "X (Step)" and "X (Expected Result)" holds both combined: skip it.
    const combined = scenario && stem(other.header) === stem(scenario.header);
    result.set(other.column, combined ? { target: { kind: "ignore" } } : { target: { kind: "description", heading: other.column.trim() } });
  }
  if (scenario) {
    const paired = pairOf(scenario);
    for (const e of expectedColumns) {
      if (e === paired) {
        result.set(e.column, { target: { kind: "scenarioExpected" } });
      } else if (!paired && (e.numbered >= 0.5 || /step|шаг/.test(e.header))) {
        // Numbered expected results ("1. ... 2. ...") belong to the numbered steps.
        result.set(e.column, { target: { kind: "scenarioExpected" } });
      }
    }
  }
  const expectedToSteps = all.filter((f) => kind(f.column) === "scenarioExpected");
  for (const extra of expectedToSteps.slice(1)) {
    result.set(extra.column, { target: { kind: "expectedResult", heading: extra.column.trim() } });
  }

  // Name: without a name header, a header mentioning a name or title ("Case Title EN", "Название проверки").
  // Nothing is guessed from the values: the user picks the column, the Columns step asks for it.
  if (!all.some((f) => kind(f.column) === "name")) {
    const testWords = /case|test|тест|кейс/;
    const best = all
      .filter((f) => {
        const k = kind(f.column);
        return (
          H.nameLoose.test(f.header) &&
          !H.notName.test(f.header) &&
          (k === "customField" || k === "description" || k === "ignore") &&
          f.samples.length > 0 &&
          f.multiline === 0 &&
          f.averageLength <= 150 &&
          !H.meta.test(f.header)
        );
      })
      .sort((a, b) => Number(testWords.test(b.header)) - Number(testWords.test(a.header)) || b.distinct - a.distinct)[0];
    if (best) {
      result.set(best.column, { target: { kind: "name" } });
    }
  }
  return result;
}
