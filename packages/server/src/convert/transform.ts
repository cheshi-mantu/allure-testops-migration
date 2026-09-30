import type { FieldMapping, PlannedCase, PlannedNote, PlannedStep, Profile, TextTarget } from "@atm/shared";
import { note } from "./notes.js";
import type { FieldCatalog } from "../testrail/fields.js";
import { mapSectionPath, type SectionTree } from "../testrail/sections.js";
import type { TrCase, TrProject, TrStep, TrSuite } from "../testrail/types.js";
import { convertText, referencedCaseIds, type TextOptions } from "./markup.js";
import { inlineAttachment, separatedSteps, textSteps } from "./steps.js";

export interface SourceContext {
  catalog: FieldCatalog;
  profile: Profile;
  /** TestRail base URL with a trailing slash. */
  endpoint: string;
  project: TrProject;
  suites: Map<number, TrSuite>;
  /** Section tree per suite id. */
  sections: Map<number, SectionTree>;
}

export interface TransformResult {
  planned: PlannedCase;
  /** Other source cases this case links to. */
  linkedCaseIds: string[];
}

export function migrationTag(prefix: string, caseId: string | number): string {
  return `${prefix}:${caseId}`;
}

function isUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}

/** Values of a field after applying the value mapping. */
export function mappedValues(testCase: TrCase, mapping: FieldMapping, catalog: FieldCatalog, ownerDefault = false): string[] {
  const field = catalog.get(mapping.source);
  const value = catalog.value(testCase, mapping.source);
  const result: string[] = [];
  const push = (item: string | null | undefined) => {
    const trimmed = item?.trim();
    if (trimmed && !result.includes(trimmed)) {
      result.push(trimmed);
    }
  };
  if (field?.options) {
    value.ids.forEach((id, index) => {
      if (Object.hasOwn(mapping.values, id)) {
        push(mapping.values[id]);
        return;
      }
      if (ownerDefault && (field.kind === "user")) {
        const user = catalog.users.find((u) => String(u.id) === id);
        push(user?.email || user?.name || value.labels[index]);
        return;
      }
      push(value.labels[index]);
    });
    return result;
  }
  for (const label of value.labels) {
    const parts = mapping.separator ? label.split(mapping.separator) : [label];
    for (const part of parts) {
      const key = part.trim();
      push(Object.hasOwn(mapping.values, key) ? mapping.values[key] : key);
    }
  }
  return result;
}

function rawText(testCase: TrCase, systemName: string): string | null {
  const raw = testCase[systemName];
  if (typeof raw === "string") {
    return raw.trim() === "" ? null : raw;
  }
  return null;
}

/**
 * Turns a TestRail case into the Allure TestOps case the migration will write.
 * Pure: no network access, so it backs both the preview and the migration run.
 */
export function transformCase(testCase: TrCase, context: SourceContext): TransformResult {
  const { profile, catalog } = context;
  const options = profile.options;
  const textOptions: TextOptions = { format: options.textFormat };
  const notes: PlannedNote[] = [];
  const linked = new Set<number>();
  const inlineIds = new Set<string>();

  const planned: PlannedCase = {
    sourceId: String(testCase.id),
    sourceUrl: `${context.endpoint}index.php?/cases/view/${testCase.id}`,
    name: testCase.title,
    description: "",
    precondition: "",
    expectedResult: "",
    tags: [migrationTag(options.migrationTagPrefix, testCase.id)],
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
  if (options.selfLink) {
    planned.links.push({ name: `TestRail C${testCase.id}`, url: `${context.endpoint}index.php?/cases/view/${testCase.id}` });
  }

  const texts: Record<TextTarget, string[]> = { description: [], precondition: [], expectedResult: [] };
  const convert = (raw: string) => {
    const converted = convertText(raw, textOptions);
    converted.attachmentIds.forEach((id) => inlineIds.add(id));
    referencedCaseIds(converted.text).forEach((id) => linked.add(id));
    return converted.text;
  };
  const addCustomField = (name: string, values: string[]) => {
    if (values.length === 0) {
      return;
    }
    const existing = planned.customFields[name] ?? [];
    planned.customFields[name] = [...existing, ...values.filter((v) => !existing.includes(v))];
  };

  // Suite and sections become custom fields, one per nesting level.
  const suite = context.suites.get(testCase.suite_id);
  if (profile.structure.suiteField && suite) {
    addCustomField(profile.structure.suiteField, [suite.name]);
  }
  const tree = context.sections.get(testCase.suite_id);
  const path = tree ? tree.path(testCase.section_id) : [];
  for (const [field, values] of mapSectionPath(path.map((s) => s.name), profile.structure)) {
    addCustomField(field, values);
  }

  if (options.parentDescriptions) {
    const parents = [
      ...(suite?.description ? [{ name: suite.name, description: suite.description }] : []),
      ...path.filter((s) => s.description).map((s) => ({ name: s.name, description: s.description! })),
    ];
    for (const parent of parents) {
      texts.description.push(`### ${parent.name}\n\n${convert(parent.description)}`);
    }
  }

  let scenarioSet = false;
  for (const mapping of profile.fields) {
    const target = mapping.target;
    const field = catalog.get(mapping.source);
    switch (target.kind) {
      case "ignore":
        break;
      case "customField":
        addCustomField(target.name, mappedValues(testCase, mapping, catalog));
        break;
      case "tag":
        mappedValues(testCase, mapping, catalog).forEach((tag) => {
          if (!planned.tags.includes(tag)) {
            planned.tags.push(tag);
          }
        });
        break;
      case "layer":
        planned.layer ??= mappedValues(testCase, mapping, catalog)[0] ?? null;
        break;
      case "status":
        planned.status ??= mappedValues(testCase, mapping, catalog)[0] ?? null;
        break;
      case "owner":
        planned.owner ??= mappedValues(testCase, mapping, catalog, true)[0] ?? null;
        break;
      case "link":
        for (const value of mappedValues(testCase, mapping, catalog)) {
          if (isUrl(value)) {
            planned.links.push({ name: field?.label ? `${field.label}: ${value}` : value, url: value });
          } else {
            notes.push(note.linkNotUrl(value, mapping.source, field?.label));
          }
        }
        break;
      case "issue":
        for (const key of mappedValues(testCase, mapping, catalog)) {
          planned.issues.push({ key, integrationId: target.integrationId });
        }
        if (target.integrationId === null && planned.issues.length > 0) {
          notes.push(note.issueWithoutIntegration(mapping.source, field?.label));
        }
        break;
      case "description":
      case "precondition":
      case "expectedResult": {
        const text = rawText(testCase, mapping.source);
        const values = text !== null && !field?.options ? [convert(text)] : mappedValues(testCase, mapping, catalog);
        const joined = values.filter(Boolean).join(", ");
        if (joined) {
          texts[target.kind].push(target.heading ? `### ${target.heading}\n\n${joined}` : joined);
        }
        break;
      }
      case "comment": {
        const text = rawText(testCase, mapping.source);
        if (text !== null) {
          planned.comments.push(convert(text));
        }
        break;
      }
      case "scenario": {
        const steps = scenarioFrom(testCase, mapping.source, field?.kind === "steps", context);
        if (steps.length === 0) {
          break;
        }
        if (scenarioSet) {
          notes.push(note.scenarioTwice(mapping.source, field?.label));
          break;
        }
        planned.scenario = steps;
        scenarioSet = true;
        break;
      }
    }
  }

  planned.description = texts.description.join("\n\n");
  planned.precondition = texts.precondition.join("\n\n");
  planned.expectedResult = texts.expectedResult.join("\n\n");

  for (const step of planned.scenario) {
    if (step.type === "step") {
      for (const text of [step.body, step.data ?? "", step.expected ?? ""]) {
        referencedCaseIds(text).forEach((id) => linked.add(id));
      }
    }
  }
  planned.attachments = [...inlineIds].map(inlineAttachment);
  linked.delete(testCase.id);
  return { planned, linkedCaseIds: [...linked].map(String) };
}

function scenarioFrom(testCase: TrCase, systemName: string, separated: boolean, context: SourceContext): PlannedStep[] {
  const raw = testCase[systemName];
  const textOptions: TextOptions = { format: context.profile.options.textFormat };
  if (separated || Array.isArray(raw)) {
    return Array.isArray(raw) ? separatedSteps(raw as TrStep[], textOptions, context.profile.options.migrateSharedSteps) : [];
  }
  return typeof raw === "string" ? textSteps(raw, context.profile.options.textSteps, textOptions) : [];
}
