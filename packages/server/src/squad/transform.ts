import type { PlannedAttachment, PlannedCase, PlannedNote, PlannedStep, Profile, TextTarget } from "@atm/shared";
import { examplesSink } from "../convert/examples.js";
import { note } from "../convert/notes.js";
import { buildStep, inlineAttachment, textSteps } from "../convert/steps.js";
import { migrationTag } from "../convert/transform.js";
import { JiraCatalog, mappedJiraValues } from "../jira/catalog.js";
import { wikiToStepText } from "../jira/wiki.js";
import { SQUAD_ATTACHMENT_PREFIX } from "./assets.js";
import type { SquadCatalog } from "./catalog.js";
import type { SquadAttachment, SquadCase } from "./types.js";

export interface SquadContext {
  profile: Profile;
  catalog: SquadCatalog;
  /** Jira site with a trailing slash. */
  jiraBase: string;
}

const MARKDOWN = { format: "markdown" } as const;
const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;

function stepFiles(files: SquadAttachment[]): PlannedAttachment[] {
  return files.map((file) => ({ sourceId: `${SQUAD_ATTACHMENT_PREFIX}${file.id}`, fileName: file.name }));
}

/** Zephyr Squad steps to planned steps: step, test data and expected result in Jira wiki markup, and the files of the step. */
export function squadSteps(testCase: SquadCase): PlannedStep[] {
  const result: PlannedStep[] = [];
  testCase.steps.forEach((step, index) => {
    const planned = buildStep(wikiToStepText(step.step ?? ""), wikiToStepText(step.result ?? ""), wikiToStepText(step.data ?? ""), index + 1, MARKDOWN);
    if (planned.type !== "step") {
      return;
    }
    planned.attachments.push(...stepFiles(testCase.stepAttachments.get(step.id) ?? step.attachments ?? []));
    if (!planned.body && planned.attachments.length > 0) {
      planned.body = "See attachment";
    }
    if (planned.body || planned.expected || planned.data) {
      result.push(planned);
    }
  });
  return result;
}

/**
 * Turns a Zephyr Squad test (Jira issue plus its steps) into the Allure TestOps case the migration
 * will write. Pure: the same function backs the preview, the dry run and the migration.
 */
export function transformSquadCase(testCase: SquadCase, context: SquadContext): { planned: PlannedCase; linkedCaseIds: string[] } {
  const { profile, catalog } = context;
  const { issue } = testCase;
  const options = profile.options;
  const notes: PlannedNote[] = [];
  const inlineIds = new Set<string>();
  const examples = examplesSink(options.gherkinExamples);
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
  if (options.testKeyIntegrationId) {
    planned.testKeys = [{ key: issue.key, integrationId: options.testKeyIntegrationId }];
  }
  const addCustomField = (name: string, values: string[]) => {
    if (values.length === 0) {
      return;
    }
    const existing = planned.customFields[name] ?? [];
    planned.customFields[name] = [...existing, ...values.filter((v) => !existing.includes(v))];
  };
  const withImages = (markdown: string) => {
    JiraCatalog.imageIds(markdown).forEach((id) => inlineIds.add(id));
    return markdown;
  };

  const texts: Record<TextTarget, string[]> = { description: [], precondition: [], expectedResult: [] };
  let scenarioSet = false;
  const mapped = new Set(profile.fields.filter((m) => m.target.kind !== "ignore").map((m) => m.source));

  for (const mapping of profile.fields) {
    const target = mapping.target;
    const field = catalog.get(mapping.source);
    const label = field?.label ?? mapping.source;
    const values = () => mappedJiraValues(testCase, mapping, catalog);
    switch (target.kind) {
      case "ignore":
      case "name":
      case "sourceId":
      case "allureId":
      case "scenarioExpected":
      case "attachment":
      case "examples":
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
        planned.owner ??= mappedJiraValues(testCase, mapping, catalog, true)[0] ?? null;
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
        for (const name of mappedJiraValues(testCase, mapping, catalog, true)) {
          if (!planned.members.some((m) => m.name === name && m.role === target.role)) {
            planned.members.push({ name, role: target.role });
          }
        }
        break;
      case "link":
        for (const value of values()) {
          if (/^https?:\/\/\S+$/i.test(value)) {
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
        if (mapping.source === "squad:steps") {
          steps = squadSteps(testCase);
        } else {
          const text = catalog.text(testCase, mapping.source);
          steps = text ? textSteps(text, options.textSteps, MARKDOWN, examples) : [];
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
  if (examples.examples.length > 0) {
    planned.examples = examples.examples;
  }
  if (testCase.steps.length > 0 && !mapped.has("squad:steps")) {
    notes.push({
      code: "squad-steps-not-mapped",
      text: `This test has ${testCase.steps.length} step(s), but "Test steps" is not migrated.`,
      summary: 'Some tests have steps, but "Test steps" is not migrated.',
      hint: "Map Test steps to the scenario on the Fields step.",
      fix: { step: "fields", field: "squad:steps" },
    });
  }
  return { planned, linkedCaseIds: [] };
}
