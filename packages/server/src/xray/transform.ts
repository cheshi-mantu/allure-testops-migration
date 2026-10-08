import type { FieldMapping, PlannedAttachment, PlannedCase, PlannedNote, PlannedStep, Profile, TextTarget } from "@atm/shared";
import { mapSectionPath } from "@atm/shared";
import { note } from "../convert/notes.js";
import { buildStep, inlineAttachment, textSteps } from "../convert/steps.js";
import { migrationTag } from "../convert/transform.js";
import { folderLevels, XrayCatalog } from "./catalog.js";
import { NESTED_LIMIT } from "./client.js";
import type { XrayCase, XrayStep } from "./types.js";
import { wikiToMarkdown, wikiToPlain, wikiToStepText } from "./wiki.js";

export interface XrayContext {
  profile: Profile;
  catalog: XrayCatalog;
  /** Jira site with a trailing slash. */
  jiraBase: string;
  /** Tests called by steps of other tests, by Xray issue id. */
  called: Map<string, XrayCase>;
}

export interface XrayTransformResult {
  planned: PlannedCase;
  linkedCaseIds: string[];
}

/** Step attachments are kept by Xray, issue attachments by Jira: the prefix tells the downloader which one. */
export const XRAY_ATTACHMENT_PREFIX = "xray-";

const MARKDOWN = { format: "markdown" } as const;

function isUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}

const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;

/** Values of a field after applying the value mapping. */
export function mappedXrayValues(testCase: XrayCase, mapping: FieldMapping, catalog: XrayCatalog, ownerDefault = false): string[] {
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
    for (const part of mapping.separator ? label.split(mapping.separator) : [label]) {
      const key = part.trim();
      push(Object.hasOwn(mapping.values, key) ? mapping.values[key] : key);
    }
  }
  return result;
}

function stepAttachments(step: XrayStep): PlannedAttachment[] {
  return (step.attachments ?? []).map((a) => ({ sourceId: `${XRAY_ATTACHMENT_PREFIX}${a.id}`, fileName: a.filename }));
}

/** Xray step custom fields, e.g. "Test data id: 42", kept with the step data. */
function stepCustomFields(step: XrayStep): string {
  return (step.customFields ?? [])
    .map((field) => {
      const value = Array.isArray(field.value) ? field.value.join(", ") : field.value;
      return value === null || value === undefined || value === "" ? "" : `${field.name ?? field.id}: ${typeof value === "string" ? value : JSON.stringify(value)}`;
    })
    .filter(Boolean)
    .join("\n");
}

/** Xray steps to planned steps. Called tests become shared steps, or their steps are copied in. */
export function xraySteps(steps: XrayStep[], context: XrayContext, useSharedSteps: boolean, depth = 0): PlannedStep[] {
  const result: PlannedStep[] = [];
  steps.forEach((step, index) => {
    if (step.callTestIssueId) {
      const called = context.called.get(step.callTestIssueId);
      const name = called ? `${called.issue.key} ${String(called.issue.fields.summary ?? "")}`.trim() : `Test ${step.callTestIssueId}`;
      if (useSharedSteps) {
        result.push({ type: "shared", sourceId: Number(step.callTestIssueId), name });
        return;
      }
      result.push({
        type: "step",
        body: `Call test ${name}`,
        steps: called && depth < 5 ? xraySteps(called.test.steps ?? [], context, false, depth + 1) : [],
        attachments: [],
        data: null,
        dataAttachments: [],
        expected: null,
        expectedAttachments: [],
      });
      return;
    }
    const data = [wikiToStepText(step.data ?? ""), stepCustomFields(step)].filter(Boolean).join("\n");
    const planned = buildStep(wikiToStepText(step.action ?? ""), wikiToStepText(step.result ?? ""), data, index + 1, MARKDOWN);
    if (planned.type === "step") {
      planned.attachments.push(...stepAttachments(step));
      if (!planned.body && planned.attachments.length > 0) {
        planned.body = "See attachment";
      }
      if (planned.body || planned.expected || planned.data) {
        result.push(planned);
      }
    }
  });
  return result;
}

/** A Cucumber scenario as steps, one per line; Examples tables stay with the line before them. */
function gherkinSteps(gherkin: string): PlannedStep[] {
  return textSteps(gherkin.replace(/^\s*#.*$/gm, ""), "lines", MARKDOWN);
}

/**
 * Turns an Xray test (Jira issue plus Xray details) into the Allure TestOps case the migration
 * will write. Pure: the same function backs the preview, the dry run and the migration.
 */
export function transformXrayCase(testCase: XrayCase, context: XrayContext): XrayTransformResult {
  const { profile, catalog } = context;
  const { issue, test } = testCase;
  const options = profile.options;
  const notes: PlannedNote[] = [];
  const inlineIds = new Set<string>();
  const url = `${context.jiraBase}browse/${issue.key}`;

  const planned: PlannedCase = {
    sourceId: issue.key,
    sourceUrl: url,
    name: String(issue.fields.summary ?? "").trim() || issue.key,
    description: "",
    precondition: "",
    expectedResult: "",
    tags: [migrationTag(options.migrationTagPrefix, issue.key)],
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
    planned.links.push({ name: `Jira ${issue.key}`, url });
  }
  const addCustomField = (name: string, values: string[]) => {
    if (values.length === 0) {
      return;
    }
    const existing = planned.customFields[name] ?? [];
    planned.customFields[name] = [...existing, ...values.filter((v) => !existing.includes(v))];
  };
  const withImages = (markdown: string) => {
    XrayCatalog.imageIds(markdown).forEach((id) => inlineIds.add(id));
    return markdown;
  };

  // The Xray folder becomes custom fields, one per level.
  for (const [field, values] of mapSectionPath(folderLevels(test.folder?.path), profile.structure)) {
    addCustomField(field, values);
  }

  const texts: Record<TextTarget, string[]> = { description: [], precondition: [], expectedResult: [] };
  let scenarioSet = false;
  const mapped = new Set(profile.fields.filter((m) => m.target.kind !== "ignore").map((m) => m.source));

  for (const mapping of profile.fields) {
    const target = mapping.target;
    const field = catalog.get(mapping.source);
    const label = field?.label ?? mapping.source;
    const values = () => mappedXrayValues(testCase, mapping, catalog);
    switch (target.kind) {
      case "ignore":
      case "name":
      case "sourceId":
      case "allureId":
      case "scenarioExpected":
        break;
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
        planned.owner ??= mappedXrayValues(testCase, mapping, catalog, true)[0] ?? null;
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
        for (const name of mappedXrayValues(testCase, mapping, catalog, true)) {
          if (!planned.members.some((m) => m.name === name && m.role === target.role)) {
            planned.members.push({ name, role: target.role });
          }
        }
        break;
      case "link":
        for (const value of values()) {
          if (isUrl(value)) {
            planned.links.push({ name: `${label}: ${value}`, url: value });
          } else if (ISSUE_KEY.test(value)) {
            planned.links.push({ name: `${label.replace(/^Issue links: /, "")} ${value}`, url: `${context.jiraBase}browse/${value}` });
          } else {
            notes.push(note.linkNotUrl(value, mapping.source, label));
          }
        }
        break;
      case "issue": {
        const keys = values();
        keys.forEach((key) => planned.issues.push({ key, integrationId: target.integrationId }));
        if (target.integrationId === null && keys.length > 0) {
          notes.push(note.issueWithoutIntegration(mapping.source, label));
        }
        break;
      }
      case "description":
      case "precondition":
      case "expectedResult": {
        const text = field?.kind === "text" && mapping.source !== "jira:comment" ? withImages(catalog.text(testCase, mapping.source)) : values().map(withImages).join(", ");
        if (text) {
          texts[target.kind].push(target.heading ? `### ${target.heading}\n\n${text}` : text);
        }
        break;
      }
      case "comment":
        if (mapping.source === "jira:comment") {
          planned.comments.push(...catalog.comments(testCase).map(withImages));
        } else {
          const text = field?.kind === "text" ? catalog.text(testCase, mapping.source) : values().join(", ");
          if (text) {
            planned.comments.push(withImages(text));
          }
        }
        break;
      case "scenario": {
        let steps: PlannedStep[] = [];
        if (mapping.source === "xray:steps") {
          steps = xraySteps(test.steps ?? [], context, options.migrateSharedSteps);
        } else if (mapping.source === "xray:definition") {
          steps = test.gherkin?.trim()
            ? gherkinSteps(test.gherkin)
            : test.unstructured?.trim()
              ? textSteps(wikiToStepText(test.unstructured), options.textSteps, MARKDOWN)
              : [];
        } else {
          const text = catalog.text(testCase, mapping.source);
          steps = text ? textSteps(text, options.textSteps, MARKDOWN) : [];
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
  planned.attachments = [...inlineIds].map(inlineAttachment);

  // Content of the test that no mapping takes: say so, with the place to fix it.
  const unmapped = (source: string, what: string) => {
    if (!mapped.has(source)) {
      notes.push({
        code: "xray-content-not-mapped",
        text: `This test has ${what}, but "${catalog.get(source)?.label ?? source}" is not migrated.`,
        summary: `Some tests have content in "${catalog.get(source)?.label ?? source}", which is not migrated.`,
        hint: "Map it to the scenario, the description or another target on the Fields step.",
        fix: { step: "fields", field: source },
      });
    }
  };
  if ((test.steps?.length ?? 0) > 0) {
    unmapped("xray:steps", `${test.steps!.length} step(s)`);
  }
  if (test.gherkin?.trim() || test.unstructured?.trim()) {
    unmapped("xray:definition", test.gherkin?.trim() ? "a Cucumber scenario" : "a generic definition");
  }
  if ((test.preconditions?.results.length ?? 0) > 0) {
    unmapped("xray:preconditions", "preconditions");
  }
  for (const [list, what] of [
    [test.preconditions, "preconditions"],
    [test.testSets, "test sets"],
    [test.testPlans, "test plans"],
  ] as const) {
    if (list && list.total > list.results.length) {
      notes.push({
        code: "xray-too-many-links",
        text: `This test has ${list.total} ${what}; the first ${NESTED_LIMIT} are migrated.`,
        summary: `Tests with more than ${NESTED_LIMIT} ${what} keep only the first ${NESTED_LIMIT}.`,
        hint: `Only the first ${NESTED_LIMIT} ${what} of a test are read from Xray.`,
      });
    }
  }
  for (const step of test.steps ?? []) {
    if (step.callTestIssueId && !context.called.has(step.callTestIssueId)) {
      notes.push({
        code: "xray-called-test-missing",
        text: `A step calls test ${step.callTestIssueId}, which could not be read.`,
        summary: "Some steps call tests that could not be read from Xray and Jira.",
        hint: "The called test may be in a project the Jira user cannot see. Give the user access to it and run again.",
        fix: { step: "connections" },
      });
    }
  }
  return { planned, linkedCaseIds: [] };
}

/** Steps of a called test as an Allure TestOps shared step. */
export function calledTestContent(called: XrayCase, context: XrayContext): { id: number; title: string; steps: PlannedStep[] } {
  return {
    id: Number(called.issue.id),
    title: `${called.issue.key} ${wikiToPlain(String(called.issue.fields.summary ?? ""))}`.trim(),
    steps: xraySteps(called.test.steps ?? [], context, false),
  };
}
