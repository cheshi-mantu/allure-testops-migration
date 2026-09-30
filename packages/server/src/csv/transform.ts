import { mapSectionPath, type FieldMapping, type PlannedCase, type PlannedNote, type PlannedStep, type Profile, type TextTarget } from "@atm/shared";
import { note } from "../convert/notes.js";
import { convertText } from "../convert/markup.js";
import { migrationTag } from "../convert/transform.js";
import { CaseSkipped } from "../engine/errors.js";
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
  const notes: PlannedNote[] = [];
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
            notes.push({
              code: "allure-id-invalid",
              text: `"${raw}" in ${mapping.source} is not an Allure TestOps id, so a new case is created instead of updating one.`,
              summary: `Values of ${mapping.source} that are not Allure TestOps ids are ignored.`,
              hint: "Allure ids are numbers. If the column holds ids of another system, map it to \"Case id (for reruns)\" instead.",
              fix: { step: "fields", field: mapping.source },
            });
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
            notes.push({
              code: "role-not-chosen",
              text: `Members from ${mapping.source} are skipped: no Allure TestOps role is chosen.`,
              summary: `Members from ${mapping.source} are skipped: no Allure TestOps role is chosen.`,
              hint: "Choose the role, e.g. Reviewer, for this column. Roles are defined in Allure TestOps (Administration, Roles).",
              fix: { step: "fields", field: mapping.source },
            });
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
            notes.push(note.linkNotUrl(value, mapping.source));
          }
        }
        break;
      case "issue":
        for (const key of mappedValues(testCase, mapping)) {
          planned.issues.push({ key, integrationId: target.integrationId });
        }
        if (target.integrationId === null && planned.issues.length > 0) {
          notes.push(note.issueWithoutIntegration(mapping.source));
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
    notes.push({
      code: "expected-without-scenario",
      text: `Expected results from ${expectedMapping!.source} are lost: no column is mapped to the scenario.`,
      summary: `Expected results from ${expectedMapping!.source} are lost: no column is mapped to the scenario.`,
      hint: "Map the column with the steps to \"Scenario (steps)\", or map the expected results to the case's expected result.",
      fix: { step: "fields", field: expectedMapping!.source },
    });
  }
  planned.description = texts.description.join("\n\n");
  planned.precondition = texts.precondition.join("\n\n");
  planned.expectedResult = texts.expectedResult.join("\n\n");
  if (!planned.name) {
    // The name is the only required value: a record without one is not imported.
    const nameColumn = profile.fields.find((m) => m.target.kind === "name")?.source;
    throw new CaseSkipped(`Line ${testCase.line}: Cannot be imported: the test case has no name.`, {
      code: "no-name",
      text: `Line ${testCase.line} has no name in ${nameColumn ?? "the name column"}.`,
      summary: `Records with an empty ${nameColumn ?? "name"} cannot be imported.`,
      hint: `The name is the only required value. Fill it in for these records in the file and upload the file again, or map a column that is always filled to the test case name.`,
      fix: { step: "fields", field: nameColumn },
    });
  }
  if ([planned.description, planned.precondition, planned.expectedResult].some((t) => t.includes("testrail-attachment:"))) {
    notes.push({
      code: "csv-testrail-images",
      text: "The text refers to TestRail images, which a CSV file does not contain; a note is left in their place.",
      hint: "To keep the images, migrate this project directly from TestRail instead of from its CSV export.",
    });
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
