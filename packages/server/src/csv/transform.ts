import { mapSectionPath, type FieldMapping, type PlannedCase, type PlannedStep, type Profile, type TextTarget } from "@atm/shared";
import { convertText } from "../convert/markup.js";
import { migrationTag } from "../convert/transform.js";
import { values, type CsvCase } from "./cases.js";
import { casePath } from "./discovery.js";
import { attachExpected, parseExpectedTexts, parseSteps, type StepParseOptions } from "./steps.js";

export interface CsvContext {
  profile: Profile;
  pathSeparator: string | null;
  multiRow: boolean;
}

function isUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}

/** Values of a column over the case rows, split and translated by the mapping. */
function mappedValues(testCase: CsvCase, mapping: FieldMapping): string[] {
  const result: string[] = [];
  for (const raw of values(testCase, mapping.source)) {
    const parts = mapping.separator ? raw.split(mapping.separator) : [raw];
    for (const part of parts) {
      const key = part.trim();
      if (!key) {
        continue;
      }
      const mapped = Object.hasOwn(mapping.values, key) ? mapping.values[key] : key;
      const value = mapped?.trim();
      if (value && !result.includes(value)) {
        result.push(value);
      }
    }
  }
  return result;
}

/** Text of a case level column; several rows with different texts are joined. */
function caseText(testCase: CsvCase, column: string): string {
  return [...new Set(values(testCase, column))].join("\n\n");
}

export function transformCsvCase(testCase: CsvCase, context: CsvContext): { planned: PlannedCase; linkedCaseIds: string[] } {
  const { profile } = context;
  const options = profile.options;
  const notes: string[] = [];
  const planned: PlannedCase = {
    sourceId: testCase.key,
    sourceUrl: null,
    allureId: null,
    name: testCase.name,
    description: "",
    precondition: "",
    expectedResult: "",
    tags: [migrationTag(options.migrationTagPrefix, testCase.key)],
    customFields: {},
    layer: null,
    status: null,
    owner: null,
    members: [],
    links: [],
    issues: [],
    comments: [],
    attachments: [],
    scenario: [],
    notes,
  };
  if (options.additionalTag.trim()) {
    planned.tags.push(options.additionalTag.trim());
  }
  const addCustomField = (name: string, list: string[]) => {
    if (list.length === 0) {
      return;
    }
    const existing = planned.customFields[name] ?? [];
    planned.customFields[name] = [...existing, ...list.filter((v) => !existing.includes(v))];
  };
  const convert = (raw: string) => convertText(raw, { format: options.textFormat }).text;

  for (const [field, list] of mapSectionPath(casePath(testCase, profile.csv.pathColumn, context.pathSeparator), profile.structure)) {
    addCustomField(field, list);
  }

  const texts: Record<TextTarget, string[]> = { description: [], precondition: [], expectedResult: [] };
  const stepOptions: StepParseOptions = profile.csv.steps;
  const scenarioMapping = profile.fields.find((m) => m.target.kind === "scenario");
  const expectedMapping = profile.fields.find((m) => m.target.kind === "scenarioExpected");

  for (const mapping of profile.fields) {
    const target = mapping.target;
    switch (target.kind) {
      case "ignore":
      case "sourceId":
      case "scenario":
      case "scenarioExpected":
        break;
      case "name":
        planned.name ||= values(testCase, mapping.source)[0] ?? "";
        break;
      case "allureId": {
        const raw = values(testCase, mapping.source)[0];
        if (raw) {
          const id = Number(raw.replace(/^#/, ""));
          if (Number.isInteger(id) && id > 0) {
            planned.allureId = id;
          } else {
            notes.push(`"${raw}" is not an Allure TestOps id.`);
          }
        }
        break;
      }
      case "customField":
        addCustomField(target.name, mappedValues(testCase, mapping));
        break;
      case "tag":
        for (const tag of mappedValues(testCase, mapping)) {
          if (!planned.tags.includes(tag)) {
            planned.tags.push(tag);
          }
        }
        break;
      case "layer":
        planned.layer ??= mappedValues(testCase, mapping)[0] ?? null;
        break;
      case "status":
        planned.status ??= mappedValues(testCase, mapping)[0] ?? null;
        break;
      case "owner":
        planned.owner ??= mappedValues(testCase, mapping)[0] ?? null;
        break;
      case "role":
        if (!target.role) {
          if (values(testCase, mapping.source).length > 0) {
            notes.push(`Choose an Allure TestOps role for the column "${mapping.source}".`);
          }
          break;
        }
        for (const name of mappedValues(testCase, mapping)) {
          if (!planned.members.some((m) => m.name === name && m.role === target.role)) {
            planned.members.push({ name, role: target.role });
          }
        }
        break;
      case "link":
        for (const value of mappedValues(testCase, mapping)) {
          if (isUrl(value)) {
            planned.links.push({ name: value, url: value });
          } else {
            notes.push(`"${value}" from ${mapping.source} is not a URL and cannot become a link.`);
          }
        }
        break;
      case "issue":
        for (const key of mappedValues(testCase, mapping)) {
          planned.issues.push({ key, integrationId: target.integrationId });
        }
        if (target.integrationId === null && planned.issues.length > 0) {
          notes.push("Issues need an issue tracker integration; choose one in the field mapping.");
        }
        break;
      case "description":
      case "precondition":
      case "expectedResult": {
        const text = mapping.values && Object.keys(mapping.values).length > 0 ? mappedValues(testCase, mapping).join(", ") : convert(caseText(testCase, mapping.source));
        if (text) {
          texts[target.kind].push(target.heading ? `### ${target.heading}\n\n${text}` : text);
        }
        break;
      }
      case "comment": {
        const text = caseText(testCase, mapping.source);
        if (text) {
          planned.comments.push(convert(text));
        }
        break;
      }
    }
  }

  planned.scenario = scenario(testCase, scenarioMapping?.source ?? null, expectedMapping?.source ?? null, stepOptions, context.multiRow);
  if (!scenarioMapping && expectedMapping && planned.scenario.length === 0) {
    notes.push("Expected results are mapped to steps, but no column is mapped to the scenario.");
  }
  planned.description = texts.description.join("\n\n");
  planned.precondition = texts.precondition.join("\n\n");
  planned.expectedResult = texts.expectedResult.join("\n\n");
  if (!planned.name) {
    throw new Error(`The case on line ${testCase.line} has no name.`);
  }
  return { planned, linkedCaseIds: [] };
}

function scenario(testCase: CsvCase, stepsColumn: string | null, expectedColumn: string | null, options: StepParseOptions, multiRow: boolean): PlannedStep[] {
  if (!stepsColumn) {
    return [];
  }
  if (multiRow && testCase.rows.length > 1) {
    // One step (or a few) per row; the row's expected result belongs to the row's last step.
    const steps: PlannedStep[] = [];
    for (const row of testCase.rows) {
      const rowSteps = parseSteps(row[stepsColumn] ?? "", options);
      const expected = expectedColumn ? (row[expectedColumn] ?? "").trim() : "";
      if (expected) {
        if (rowSteps.length === 0) {
          rowSteps.push({ type: "step", body: "Untitled step", attachments: [], data: null, dataAttachments: [], expected: null, expectedAttachments: [] });
        }
        attachExpected(rowSteps, [expected]);
      }
      steps.push(...rowSteps);
    }
    return steps;
  }
  const row = testCase.rows[0]!;
  const steps = parseSteps(row[stepsColumn] ?? "", options);
  const expected = expectedColumn ? (row[expectedColumn] ?? "") : "";
  if (expected.trim()) {
    attachExpected(steps, parseExpectedTexts(expected, options));
  }
  return steps;
}
