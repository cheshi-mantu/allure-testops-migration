import type { FieldMapping, PlannedCase, PlannedNote, PlannedStep, Profile, TextTarget } from "@atm/shared";
import { mapSectionPath, splitValue } from "@atm/shared";
import { ATTACHMENT_SCHEME, convertText, type TextOptions } from "../convert/markup.js";
import { examplesSink } from "../convert/examples.js";
import { note } from "../convert/notes.js";
import { buildStep, inlineAttachment, textSteps } from "../convert/steps.js";
import { migrationTag } from "../convert/transform.js";
import type { QaseAssets } from "./assets.js";
import { MAX_EXAMPLES, parameterExampleCount, parameterExamples, parametersText, type QaseCatalog } from "./catalog.js";
import type { QaseCase, QaseStep, QaseSuite } from "./types.js";

export interface QaseContext {
  profile: Profile;
  catalog: QaseCatalog;
  assets: QaseAssets;
  /** Project code, e.g. DEMO. */
  code: string;
  suites: Map<number, QaseSuite>;
}

/** "DEMO-12": how Qase shows a case, and what identifies it in the migration tag. */
export function qaseCaseKey(code: string, id: number): string {
  return `${code}-${id}`;
}

/** Titles of the suites around a case, outermost first. */
export function suitePath(suiteId: number | null | undefined, suites: Map<number, QaseSuite>): string[] {
  const path: string[] = [];
  const seen = new Set<number>();
  for (let id = suiteId ?? null; id !== null && suites.has(id) && !seen.has(id); ) {
    const suite = suites.get(id)!;
    seen.add(id);
    path.unshift(suite.title);
    id = suite.parent_id ?? null;
  }
  return path;
}

function isUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}

const IMAGE = /!\[([^\]]*)\]\(\s*([^)\s]+)[^)]*\)|<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;

/** Images kept by Qase become references to planned attachments; other images stay as they are. */
function withQaseImages(text: string, assets: QaseAssets): string {
  return text.replace(IMAGE, (match, alt: string | undefined, markdownSource: string | undefined, htmlSource: string | undefined) => {
    const key = assets.imageKey((markdownSource ?? htmlSource)!);
    if (!key) {
      return match;
    }
    return htmlSource ? `<img src="${ATTACHMENT_SCHEME}${key}" alt="">` : `![${alt ?? ""}](${ATTACHMENT_SCHEME}${key})`;
  });
}

/** Values of a field after applying the value mapping. */
export function mappedQaseValues(testCase: QaseCase, mapping: FieldMapping, catalog: QaseCatalog, ownerDefault = false): string[] {
  const field = catalog.get(mapping.source);
  const value = catalog.value(testCase, mapping.source);
  const result: string[] = [];
  const push = (item: string | null | undefined) => {
    const trimmed = item?.trim();
    if (trimmed && !result.includes(trimmed)) {
      result.push(trimmed);
    }
  };
  if (field?.closed) {
    value.ids.forEach((id, index) => {
      if (Object.hasOwn(mapping.values, id)) {
        push(mapping.values[id]);
      } else if (ownerDefault && field.kind === "user") {
        push(value.emails?.get(id) ?? value.labels[index]);
      } else {
        push(value.labels[index]);
      }
    });
    return result;
  }
  for (const label of value.labels) {
    for (const part of splitValue(label, mapping.separator)) {
      const key = part.trim();
      push(Object.hasOwn(mapping.values, key) ? mapping.values[key] : key);
    }
  }
  return result;
}

/**
 * Qase steps to planned steps. A shared step arrives as its steps, each marked with the hash of
 * the shared step: they collapse into one reference, or stay as steps when shared steps are off.
 */
export function qaseSteps(steps: QaseStep[], context: QaseContext, useSharedSteps: boolean, options: TextOptions): PlannedStep[] {
  const { assets } = context;
  const result: PlannedStep[] = [];
  let group: { hash: string; first: string | null } | null = null;
  steps.forEach((step, index) => {
    const hash = step.shared_step_hash ?? null;
    if (hash && useSharedSteps && assets.hasShared(hash)) {
      const nested = step.shared_step_nested_hash ?? null;
      // The same shared step twice in a row starts again from its first step.
      if (!group || group.hash !== hash || (nested !== null && nested === group.first)) {
        result.push({ type: "shared", sourceId: assets.sharedNumber(hash), name: assets.sharedTitle(hash) });
        group = { hash, first: nested };
      }
      return;
    }
    group = null;
    const image = (text: string | null | undefined) => (text ? withQaseImages(text, assets) : text);
    const planned = buildStep(image(step.action), image(step.expected_result), image(step.data), index + 1, options);
    if (planned.type !== "step") {
      return;
    }
    planned.attachments.push(...(step.attachments ?? []).map((file) => assets.planned(file)));
    const nested = qaseSteps(step.steps ?? [], context, false, options);
    if (nested.length > 0) {
      planned.steps = nested;
    }
    if (!planned.body && (planned.attachments.length > 0 || nested.length > 0)) {
      planned.body = planned.attachments.length > 0 ? "See attachment" : "Steps";
    }
    if (planned.body || planned.expected || planned.data) {
      result.push(planned);
    }
  });
  return result;
}

/**
 * Turns a Qase case into the Allure TestOps case the migration will write. Pure: the same function
 * backs the preview, the dry run and the migration.
 */
export function transformQaseCase(testCase: QaseCase, context: QaseContext): { planned: PlannedCase; linkedCaseIds: string[] } {
  const { profile, catalog, assets } = context;
  const options = profile.options;
  const textOptions: TextOptions = { format: options.textFormat };
  const notes: PlannedNote[] = [];
  const key = qaseCaseKey(context.code, testCase.id);
  const appUrl = (profile.qase.connection.appUrl.trim() || "https://app.qase.io").replace(/\/+$/, "");
  const url = `${appUrl}/case/${key}`;

  const planned: PlannedCase = {
    sourceId: key,
    sourceUrl: url,
    name: (testCase.title ?? "").trim() || key,
    description: "",
    precondition: "",
    expectedResult: "",
    tags: [migrationTag(options.migrationTagPrefix, key)],
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
    planned.links.push({ name: `Qase ${key}`, url });
  }
  const addCustomField = (name: string, values: string[]) => {
    if (values.length === 0) {
      return;
    }
    const existing = planned.customFields[name] ?? [];
    planned.customFields[name] = [...existing, ...values.filter((v) => !existing.includes(v))];
  };
  const inlineIds = new Set<string>();
  const examples = examplesSink(options.gherkinExamples);
  /** Qase text to Markdown; images kept by Qase are planned as attachments. */
  const text = (raw: string): string => {
    const converted = convertText(withQaseImages(raw, assets), textOptions);
    converted.attachmentIds.forEach((id) => inlineIds.add(id));
    return converted.text;
  };

  // The suites around the case become custom fields, one per level.
  for (const [field, values] of mapSectionPath(suitePath(testCase.suite_id, context.suites), profile.structure)) {
    addCustomField(field, values);
  }

  const texts: Record<TextTarget, string[]> = { description: [], precondition: [], expectedResult: [] };
  let scenarioSet = false;

  for (const mapping of profile.fields) {
    const target = mapping.target;
    const field = catalog.get(mapping.source);
    const label = field?.label ?? mapping.source;
    const values = () => mappedQaseValues(testCase, mapping, catalog);
    switch (target.kind) {
      case "ignore":
      case "name":
      case "sourceId":
      case "allureId":
      case "scenarioExpected":
      case "attachment":
        break;
      case "examples": {
        const count = parameterExampleCount(testCase.parameters);
        if (count > MAX_EXAMPLES) {
          // Too many combinations to run one by one: they stay readable as text.
          texts.description.push(`### ${label}\n\n${parametersText(testCase.parameters)}`);
          notes.push({
            code: "qase-too-many-examples",
            text: `The parameters of this case give ${count} combinations; they are in the description instead of the examples.`,
            summary: `Cases whose parameters give more than ${MAX_EXAMPLES} combinations keep them in the description.`,
            hint: "Allure TestOps runs a case once per example. Split the parameters in Qase, or map Parameters to the description on the Fields step.",
            fix: { step: "fields", field: mapping.source },
          });
        } else {
          examples.examples.push(...parameterExamples(testCase.parameters));
        }
        break;
      }
      case "customField":
        addCustomField(target.name, values());
        break;
      case "tag":
        values().forEach((tag) => !planned.tags.includes(tag) && planned.tags.push(tag));
        break;
      case "layer":
        planned.layer ??= values()[0] ?? null;
        break;
      case "status":
        planned.status ??= values()[0] ?? null;
        break;
      case "owner":
        planned.owner ??= mappedQaseValues(testCase, mapping, catalog, true)[0] ?? null;
        break;
      case "role":
        if (!target.role) {
          if (values().length > 0) {
            notes.push({
              code: "role-not-chosen",
              text: `Members from ${label} are skipped: no Allure TestOps role is chosen.`,
              summary: `Members from ${label} are skipped: no Allure TestOps role is chosen.`,
              hint: "Choose the role, e.g. Reviewer, for this field. Roles are defined in Allure TestOps (Administration, Roles).",
              fix: { step: "fields", field: mapping.source },
            });
          }
          break;
        }
        for (const name of mappedQaseValues(testCase, mapping, catalog, true)) {
          if (!planned.members.some((m) => m.name === name && m.role === target.role)) {
            planned.members.push({ name, role: target.role });
          }
        }
        break;
      case "link":
        if (mapping.source === "qase:external_issues") {
          for (const issue of (testCase.external_issues ?? []).flatMap((group) => group.issues)) {
            if (issue.link && isUrl(issue.link)) {
              planned.links.push({ name: issue.id, url: issue.link });
            }
          }
          break;
        }
        for (const value of values()) {
          if (isUrl(value)) {
            planned.links.push({ name: `${label}: ${value}`, url: value });
          } else {
            notes.push(note.linkNotUrl(value, mapping.source, label));
          }
        }
        break;
      case "issue": {
        const keys = values();
        keys.forEach((issue) => planned.issues.push({ key: issue, integrationId: target.integrationId }));
        if (target.integrationId === null && keys.length > 0) {
          notes.push(note.issueWithoutIntegration(mapping.source, label));
        }
        break;
      }
      case "description":
      case "precondition":
      case "expectedResult": {
        const value = field?.kind === "text" ? text(catalog.text(testCase, mapping.source)) : values().join(", ");
        if (value) {
          texts[target.kind].push(target.heading ? `### ${target.heading}\n\n${value}` : value);
        }
        break;
      }
      case "comment": {
        const value = field?.kind === "text" ? text(catalog.text(testCase, mapping.source)) : values().join(", ");
        if (value) {
          planned.comments.push(value);
        }
        break;
      }
      case "scenario": {
        let steps: PlannedStep[] = [];
        if (mapping.source === "qase:steps") {
          steps =
            testCase.steps_type === "gherkin"
              ? // A Gherkin case keeps its whole scenario as text: a step per line, tables stay with their line.
                textSteps((testCase.steps ?? []).map((step) => step.action ?? "").join("\n"), "lines", { format: "markdown" }, examples)
              : qaseSteps(testCase.steps ?? [], context, options.migrateSharedSteps, textOptions);
        } else {
          const raw = catalog.text(testCase, mapping.source);
          steps = raw ? textSteps(withQaseImages(raw, assets), options.textSteps, textOptions, examples) : [];
        }
        if (steps.length === 0) {
          break;
        }
        if (scenarioSet) {
          notes.push(note.scenarioTwice(mapping.source, label));
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
  // Files of the case itself, then images that only appear in its text.
  planned.attachments = (testCase.attachments ?? []).map((file) => assets.planned(file));
  for (const id of inlineIds) {
    if (!planned.attachments.some((attachment) => attachment.sourceId === id)) {
      planned.attachments.push(inlineAttachment(id));
    }
  }

  if (examples.examples.length > 0) {
    planned.examples = examples.examples;
  }
  if ((testCase.steps?.length ?? 0) > 0 && !profile.fields.some((m) => m.source === "qase:steps" && m.target.kind !== "ignore")) {
    notes.push({
      code: "qase-steps-not-mapped",
      text: `This case has ${testCase.steps!.length} step(s), but "Steps" is not migrated.`,
      summary: 'Some cases have steps, but "Steps" is not migrated.',
      hint: "Map Steps to the scenario on the Fields step.",
      fix: { step: "fields", field: "qase:steps" },
    });
  }
  return { planned, linkedCaseIds: [] };
}
