import type { FieldMapping, PlannedCase, PlannedNote, PlannedStep, Profile, TextTarget } from "@atm/shared";
import { mapSectionPath, splitValue } from "@atm/shared";
import { ATTACHMENT_SCHEME, convertText } from "../convert/markup.js";
import { examplesSink, type ExamplesSink } from "../convert/examples.js";
import { note } from "../convert/notes.js";
import { buildStep, inlineAttachment, textSteps } from "../convert/steps.js";
import { migrationTag } from "../convert/transform.js";
import type { ZephyrAssets } from "./assets.js";
import { ISSUES_PREFIX, plain, type ZephyrCatalog } from "./catalog.js";
import type { ZephyrAttachment, ZephyrCase, ZephyrTestStep } from "./types.js";

export interface ZephyrContext {
  profile: Profile;
  catalog: ZephyrCatalog;
  assets: ZephyrAssets;
  /** Jira site with a trailing slash. */
  jiraBase: string;
  /** Test cases called by steps of other test cases, by key. */
  called: Map<string, ZephyrCase>;
}

/** Called test cases inside called test cases are followed this deep. */
const MAX_CALL_DEPTH = 5;
const AUTO = { format: "auto" } as const;
const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
const IMAGE_SOURCE = /(<img\b[^>]*?\bsrc\s*=\s*["'])([^"']+)(["'])/gi;

/** Where people open a test case: the Zephyr page of the Jira project. */
export function zephyrCaseUrl(jiraBase: string, key: string): string {
  const project = key.replace(/-T\d+$/, "");
  return `${jiraBase}projects/${encodeURIComponent(project)}?selectedItem=com.atlassian.plugins.atlassian-connect-plugin:com.kanoah.test-manager__main-project-page#!/v2/testCase/${encodeURIComponent(key)}`;
}

/** The id at the end of a picture address, e.g. `.../attachments/12345` or `...?id=12345`. */
function addressIds(source: string): string[] {
  return [...source.matchAll(/(?:^|[/=])(\d+)(?=$|[/?#&])/g)].map((match) => match[1]!);
}

/** A picture in rich text that is one of these files, by the id in its address. */
export function matchingFile(source: string, files: { file: ZephyrAttachment; stepId: string | null }[]): { file: ZephyrAttachment; stepId: string | null } | null {
  const ids = addressIds(source);
  return files.find(({ file }) => ids.includes(String(file.id))) ?? null;
}

/** Every file of a test case and its steps, for matching pictures in text. */
export function filesOf(item: ZephyrCase): { file: ZephyrAttachment; stepId: string | null }[] {
  return [...item.attachments.map((file) => ({ file, stepId: null })), ...[...item.stepAttachments.entries()].flatMap(([stepId, files]) => files.map((file) => ({ file, stepId })))];
}

/**
 * Pictures in Zephyr rich text become planned files: files of the test case or step by the id in
 * their address, other pictures at the Zephyr API address are read with the token. Pictures
 * elsewhere stay links.
 */
function prepareHtml(raw: string, item: ZephyrCase, assets: ZephyrAssets, parameters?: Map<string, string>): string {
  let text = raw;
  if (parameters && parameters.size > 0) {
    // Values of the call replace {name} in the text of the called test case.
    text = text.replace(/\{([^{}\s]+)\}/g, (match, name: string) => (parameters.has(name) ? parameters.get(name)!.replace(/</g, "&lt;") : match));
  }
  const files = filesOf(item);
  return text.replace(IMAGE_SOURCE, (match, start: string, source: string, end: string) => {
    const known = matchingFile(source, files);
    if (known) {
      return `${start}${ATTACHMENT_SCHEME}${assets.planned(item.testCase.key, known.stepId, known.file).sourceId}${end}`;
    }
    if (/^https?:\/\//i.test(source) && assets.isApiAddress(source)) {
      return `${start}${ATTACHMENT_SCHEME}${assets.picture(source)}${end}`;
    }
    return match;
  });
}

/** Values of a field after applying the value mapping. */
export function mappedZephyrValues(item: ZephyrCase, mapping: FieldMapping, catalog: ZephyrCatalog, ownerDefault = false): string[] {
  const field = catalog.get(mapping.source);
  const value = catalog.value(item, mapping.source);
  const result: string[] = [];
  const push = (entry: string | null | undefined) => {
    const trimmed = entry?.trim();
    if (trimmed && !result.includes(trimmed)) {
      result.push(trimmed);
    }
  };
  if (field?.closed) {
    value.ids.forEach((id, index) => {
      if (Object.hasOwn(mapping.values, id)) {
        push(mapping.values[id]);
      } else if (ownerDefault && field.kind === "user") {
        // Allure TestOps finds the user by email; Jira often hides it, then the name is used.
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

/** Zephyr step custom fields, e.g. "Browser: Chrome", kept with the step data. */
function stepCustomFields(step: ZephyrTestStep): string {
  return Object.entries(step.inline?.customFields ?? {})
    .map(([name, value]) => {
      if (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) {
        return "";
      }
      const shown = Array.isArray(value) ? value.join(", ") : typeof value === "boolean" ? (value ? "Yes" : "No") : typeof value === "object" ? JSON.stringify(value) : plain(String(value));
      return `${name}: ${shown}`;
    })
    .filter(Boolean)
    .join("\n");
}

function calledName(key: string, called: ZephyrCase | undefined): string {
  return called ? `${key} ${called.testCase.name}`.trim() : key;
}

/** Steps to planned steps. A step that calls a test case becomes a shared step, or the steps of that test case. */
export function zephyrSteps(item: ZephyrCase, context: ZephyrContext, useSharedSteps: boolean, depth = 0, parameters?: Map<string, string>): PlannedStep[] {
  const { assets } = context;
  const result: PlannedStep[] = [];
  item.steps.forEach((step, index) => {
    if (step.testCase) {
      const key = step.testCase.testCaseKey;
      const called = context.called.get(key);
      const values = new Map((step.testCase.parameters ?? []).filter((p) => p.name && (p.value ?? "") !== "").map((p) => [p.name, String(p.value)]));
      // A shared step has no parameters: a call with values gets the steps of the called test case with the values in.
      if (useSharedSteps && called && values.size === 0) {
        result.push({ type: "shared", sourceId: called.testCase.id, name: calledName(key, called) });
        return;
      }
      result.push({
        type: "step",
        body: `Call ${calledName(key, called)}`,
        attachments: [],
        data: values.size > 0 ? [...values].map(([name, value]) => `${name}: ${value}`).join("\n") : null,
        dataAttachments: [],
        expected: null,
        expectedAttachments: [],
        ...(called && depth < MAX_CALL_DEPTH ? { steps: zephyrSteps(called, context, false, depth + 1, values) } : {}),
      });
      return;
    }
    const inline = step.inline ?? {};
    const html = (raw: string | null | undefined) => (raw ? prepareHtml(raw, item, assets, parameters) : null);
    const data = [html(inline.testData), stepCustomFields(step)].filter(Boolean).join("\n");
    const planned = buildStep(html(inline.description), html(inline.expectedResult), data || null, index + 1, AUTO);
    if (planned.type !== "step") {
      return;
    }
    for (const attachment of [...planned.attachments, ...planned.dataAttachments, ...planned.expectedAttachments]) {
      attachment.fileName = (attachment.sourceId && assets.fileName(attachment.sourceId)) || attachment.fileName;
    }
    const stepId = step.id === null || step.id === undefined ? null : String(step.id);
    for (const file of stepId ? (item.stepAttachments.get(stepId) ?? []) : []) {
      const attachment = assets.planned(item.testCase.key, stepId, file);
      if (!planned.attachments.some((known) => known.sourceId === attachment.sourceId)) {
        planned.attachments.push(attachment);
      }
    }
    if (!planned.body && planned.attachments.length > 0) {
      planned.body = "See attachment";
    }
    if (planned.body || planned.expected || planned.data) {
      result.push(planned);
    }
  });
  return result;
}

/** The test script as steps: a BDD scenario line by line, plain text as the scenario option says. */
function scriptSteps(item: ZephyrCase, context: ZephyrContext, examples: ExamplesSink): PlannedStep[] {
  const script = item.script;
  if (!script?.text.trim()) {
    return [];
  }
  if (script.type === "bdd") {
    return textSteps(script.text.replace(/^\s*#.*$/gm, ""), "lines", { format: "markdown" }, examples);
  }
  return textSteps(prepareHtml(script.text, item, context.assets), context.profile.options.textSteps, AUTO, examples);
}

/**
 * Turns a Zephyr test case into the Allure TestOps case the migration will write. Pure: the same
 * function backs the preview, the dry run and the migration.
 */
export function transformZephyrCase(item: ZephyrCase, context: ZephyrContext): { planned: PlannedCase; linkedCaseIds: string[] } {
  const { profile, catalog, assets } = context;
  const { testCase } = item;
  const options = profile.options;
  const notes: PlannedNote[] = [];
  const inlineIds = new Set<string>();
  const examples = examplesSink(options.gherkinExamples);
  const url = zephyrCaseUrl(context.jiraBase, testCase.key);

  const planned: PlannedCase = {
    sourceId: testCase.key,
    sourceUrl: url,
    name: plain(testCase.name) || testCase.key,
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
  if (options.selfLink) {
    planned.links.push({ name: `Zephyr ${testCase.key}`, url });
  }
  if (options.testKeyIntegrationId) {
    planned.testKeys = [{ key: testCase.key, integrationId: options.testKeyIntegrationId }];
  }
  const addCustomField = (name: string, values: string[]) => {
    if (values.length === 0) {
      return;
    }
    const existing = planned.customFields[name] ?? [];
    planned.customFields[name] = [...existing, ...values.filter((v) => !existing.includes(v))];
  };
  /** Zephyr rich text to Markdown; pictures inside it are planned as files of the case. */
  const text = (raw: string): string => {
    if (!raw.trim()) {
      return "";
    }
    const converted = convertText(prepareHtml(raw, item, assets), AUTO);
    converted.attachmentIds.forEach((id) => inlineIds.add(id));
    return converted.text.replace(/ /g, " ").trim();
  };
  const scriptText = (): string => {
    if (!item.script?.text.trim()) {
      return "";
    }
    return item.script.type === "bdd" ? `\`\`\`gherkin\n${item.script.text.trim()}\n\`\`\`` : text(item.script.text);
  };

  // The folder becomes custom fields, one per level.
  const path = testCase.folder ? (catalog.dictionaries.folderPaths.get(testCase.folder.id) ?? []) : [];
  for (const [field, values] of mapSectionPath(path, profile.structure)) {
    addCustomField(field, values);
  }

  const texts: Record<TextTarget, string[]> = { description: [], precondition: [], expectedResult: [] };
  let scenarioSet = false;
  const mapped = new Set(profile.fields.filter((m) => m.target.kind !== "ignore").map((m) => m.source));

  for (const mapping of profile.fields) {
    const target = mapping.target;
    const field = catalog.get(mapping.source);
    const label = field?.label ?? mapping.source;
    const values = () => mappedZephyrValues(item, mapping, catalog);
    const richText = () => (mapping.source === "zephyr:script" ? scriptText() : field?.kind === "text" ? text(catalog.text(item, mapping.source)) : values().join(", "));
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
        planned.owner ??= mappedZephyrValues(item, mapping, catalog, true)[0] ?? null;
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
        for (const name of mappedZephyrValues(item, mapping, catalog, true)) {
          if (!planned.members.some((m) => m.name === name && m.role === target.role)) {
            planned.members.push({ name, role: target.role });
          }
        }
        break;
      case "link":
        if (mapping.source === "zephyr:webLinks") {
          for (const link of testCase.links?.webLinks ?? []) {
            if (/^https?:\/\/\S+$/i.test(link.url ?? "")) {
              planned.links.push({ name: plain(link.description) || link.url, url: link.url });
            } else if (link.url) {
              notes.push(note.linkNotUrl(link.url, mapping.source, label));
            }
          }
          break;
        }
        for (const value of values()) {
          if (/^https?:\/\/\S+$/i.test(value)) {
            planned.links.push({ name: `${label}: ${value}`, url: value });
          } else if (ISSUE_KEY.test(value)) {
            planned.links.push({ name: `${label.replace(/^Issues: /, "")} ${value}`, url: `${context.jiraBase}browse/${value}` });
          } else {
            notes.push(note.linkNotUrl(value, mapping.source, label));
          }
        }
        break;
      case "issue": {
        const keys = values().filter((key) => ISSUE_KEY.test(key));
        keys.forEach((key) => planned.issues.push({ key, integrationId: target.integrationId }));
        if (target.integrationId === null && keys.length > 0) {
          notes.push(note.issueWithoutIntegration(mapping.source, label));
        }
        break;
      }
      case "description":
      case "precondition":
      case "expectedResult": {
        const value = richText();
        if (value) {
          texts[target.kind].push(target.heading ? `### ${target.heading}\n\n${value}` : value);
        }
        break;
      }
      case "comment": {
        const value = richText();
        if (value) {
          planned.comments.push(value);
        }
        break;
      }
      case "scenario": {
        let steps: PlannedStep[] = [];
        if (mapping.source === "zephyr:steps") {
          steps = zephyrSteps(item, context, options.migrateSharedSteps);
        } else if (mapping.source === "zephyr:script") {
          steps = scriptSteps(item, context, examples);
        } else {
          const raw = catalog.text(item, mapping.source);
          steps = raw ? textSteps(prepareHtml(raw, item, assets), options.textSteps, AUTO, examples) : [];
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
  // Files of the test case, then pictures that only appear in its text.
  for (const file of item.attachments) {
    planned.attachments.push(assets.planned(testCase.key, null, file));
  }
  for (const id of inlineIds) {
    if (!planned.attachments.some((attachment) => attachment.sourceId === id)) {
      planned.attachments.push({ ...inlineAttachment(id), fileName: assets.fileName(id) ?? inlineAttachment(id).fileName });
    }
  }
  if (examples.examples.length > 0) {
    planned.examples = examples.examples;
  }

  // Content of the test case that no mapping takes: say so, with the place to fix it.
  const unmapped = (source: string, what: string) => {
    if (!mapped.has(source)) {
      notes.push({
        code: "zephyr-content-not-mapped",
        text: `This test case has ${what}, but "${catalog.get(source)?.label ?? source}" is not migrated.`,
        summary: `Some test cases have content in "${catalog.get(source)?.label ?? source}", which is not migrated.`,
        hint: "Map it to the scenario, the description or another target on the Fields step.",
        fix: { step: "fields", field: source },
      });
    }
  };
  if (item.steps.length > 0) {
    unmapped("zephyr:steps", `${item.steps.length} step(s)`);
  }
  if (item.script?.text.trim()) {
    unmapped("zephyr:script", item.script.type === "bdd" ? "a BDD script" : "a plain text script");
  }
  for (const step of item.steps) {
    if (step.testCase && !context.called.has(step.testCase.testCaseKey)) {
      notes.push({
        code: "zephyr-called-test-missing",
        text: `A step calls ${step.testCase.testCaseKey}, which could not be read; the step only names it.`,
        summary: "Some steps call test cases that could not be read from Zephyr; those steps only name them.",
        hint: "The called test case may have been deleted, or be in a project the API token cannot read. Give access to it and run again.",
        fix: { step: "connections" },
      });
    }
  }
  const unresolved = (testCase.links?.issues ?? []).filter((link) => !catalog.dictionaries.issues.has(link.issueId));
  if (unresolved.length > 0 && [...mapped].some((source) => source.startsWith(ISSUES_PREFIX))) {
    notes.push({
      code: "zephyr-issue-not-found",
      text: `Jira did not give the key of issue ${unresolved.map((link) => link.issueId).join(", ")}, so it is not linked.`,
      summary: "Some linked Jira issues could not be read, so they are not linked.",
      hint: "The Jira user may not see the project of the issue, or the issue was deleted. Give the user access and run again.",
      fix: { step: "connections" },
    });
  }
  return { planned, linkedCaseIds: [] };
}
