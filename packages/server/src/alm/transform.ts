import type { FieldMapping, PlannedCase, PlannedNote, PlannedStep, Profile, TextTarget } from "@atm/shared";
import { mapSectionPath, splitValue } from "@atm/shared";
import { ATTACHMENT_SCHEME, convertText, type TextOptions } from "../convert/markup.js";
import { examplesSink } from "../convert/examples.js";
import { note } from "../convert/notes.js";
import { buildStep, inlineAttachment, textSteps } from "../convert/steps.js";
import { migrationTag } from "../convert/transform.js";
import type { AlmAssets, AlmOwner } from "./assets.js";
import { isHtml, plain, type AlmCatalog } from "./catalog.js";
import { idOf, one, type AlmRecord, type AlmTest } from "./types.js";

export interface AlmFolder {
  name: string;
  parentId: number;
}

export interface AlmContext {
  profile: Profile;
  catalog: AlmCatalog;
  assets: AlmAssets;
  /** Test Plan folders by id. */
  folders: Map<number, AlmFolder>;
  /** Tests called by design steps of other tests, by id. */
  called: Map<number, AlmTest>;
}

/** Called tests inside called tests are followed this deep. */
const MAX_CALL_DEPTH = 5;
/** ALM keeps rich text as HTML pages and short values as plain text. */
const formatOf = (raw: string | null): TextOptions => ({ format: raw && isHtml(raw) ? "html" : "markdown" });

/** "Test 12": how the run log and the preview name an ALM test. */
export function almLabel(id: number | string): string {
  return `Test ${id}`;
}

/** Names of the Test Plan folders around a test, outermost first, without the root folder "Subject". */
export function folderPath(folderId: number | null, folders: Map<number, AlmFolder>): string[] {
  const path: string[] = [];
  const seen = new Set<number>();
  for (let id = folderId; id !== null && folders.has(id) && !seen.has(id); ) {
    const folder = folders.get(id)!;
    seen.add(id);
    if (folder.parentId === 0) {
      break;
    }
    path.unshift(folder.name);
    id = folder.parentId;
  }
  return path;
}

/** Comments ALM leaves in its HTML, and pictures it keeps as attachments of the test or step. */
const IMAGE_SOURCE = /(\bsrc\s*=\s*["'])file:\/\/\[IMAGE_BASE_PATH_PLACEHOLDER\]([^"']+)(["'])/gi;

function prepareHtml(raw: string, assets: AlmAssets, owner: AlmOwner): string {
  if (!isHtml(raw)) {
    return raw;
  }
  return raw
    .replace(/<!--[\s\S]*?-->/g, "")
    // Parameters such as <<<amount>>> are text, not tags.
    .replace(/<<<([^<>]+)>>>/g, "&lt;&lt;&lt;$1&gt;&gt;&gt;")
    .replace(IMAGE_SOURCE, (_match, start: string, name: string, end: string) => `${start}${ATTACHMENT_SCHEME}${assets.register(owner, decodeURIComponent(name))}${end}`);
}

/** Spaces ALM puts into empty lines and line ends. */
function tidy(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Values of a field after applying the value mapping. */
export function mappedAlmValues(test: AlmTest, mapping: FieldMapping, catalog: AlmCatalog, ownerDefault = false): string[] {
  const field = catalog.get(mapping.source);
  const value = catalog.value(test, mapping.source);
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
        // Allure TestOps finds the user by email, or by the same user name.
        push(value.emails?.get(id) ?? id);
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

function calledName(test: AlmTest | undefined, id: number): string {
  return test ? (one(test.test, "name") ?? almLabel(id)) : almLabel(id);
}

/** Design steps to planned steps. A step that calls another test becomes a shared step, or the steps of that test. */
export function almSteps(test: AlmTest, context: AlmContext, useSharedSteps: boolean, depth = 0): PlannedStep[] {
  const { assets } = context;
  const result: PlannedStep[] = [];
  test.steps.forEach((step, index) => {
    const calledId = Number(one(step, "link-test") ?? 0);
    if (calledId > 0) {
      const called = context.called.get(calledId);
      if (useSharedSteps && called) {
        result.push({ type: "shared", sourceId: calledId, name: calledName(called, calledId) });
      } else {
        result.push({
          type: "step",
          body: `Call ${calledName(called, calledId)}`,
          attachments: [],
          data: null,
          dataAttachments: [],
          expected: null,
          expectedAttachments: [],
          ...(called && depth < MAX_CALL_DEPTH ? { steps: almSteps(called, context, false, depth + 1) } : {}),
        });
      }
      return;
    }
    const owner: AlmOwner = { kind: "design-steps", id: idOf(step), testId: idOf(test.test) };
    const html = (name: string) => {
      const raw = one(step, name);
      return raw ? prepareHtml(raw, assets, owner) : null;
    };
    const planned = buildStep(html("description"), html("expected"), null, index + 1, formatOf(one(step, "description") ?? one(step, "expected")));
    if (planned.type !== "step") {
      return;
    }
    planned.body = tidy(planned.body);
    planned.expected = planned.expected ? tidy(planned.expected) : null;
    // Pictures in the text are known by the names ALM gave them.
    for (const attachment of [...planned.attachments, ...planned.expectedAttachments]) {
      attachment.fileName = (attachment.sourceId && assets.fileName(attachment.sourceId)) || attachment.fileName;
    }
    // ALM names steps "Step 1", "Step 2"; a name someone wrote is kept above the step.
    const name = plain(one(step, "name"));
    if (name && !/^step\s*\d*$/i.test(name)) {
      planned.body = planned.body ? `${name}\n${planned.body}` : name;
    }
    for (const file of test.stepAttachments.get(String(idOf(step))) ?? []) {
      if (isUrlAttachment(file)) {
        planned.body = `${planned.body}\n${one(file, "name")}`.trim();
      } else if (!planned.attachments.some((attachment) => attachment.sourceId === assets.register(owner, one(file, "name")!))) {
        planned.attachments.push(assets.planned(owner, file));
      }
    }
    if (!planned.body && planned.attachments.length > 0) {
      planned.body = "See attachment";
    }
    if (planned.body || planned.expected) {
      result.push(planned);
    }
  });
  return result;
}

export function isUrlAttachment(file: AlmRecord): boolean {
  return (one(file, "ref-type") ?? "").toLowerCase() === "url";
}

/**
 * Turns an ALM test into the Allure TestOps case the migration will write. Pure: the same function
 * backs the preview, the dry run and the migration.
 */
export function transformAlmTest(test: AlmTest, context: AlmContext): { planned: PlannedCase; linkedCaseIds: string[] } {
  const { profile, catalog, assets } = context;
  const options = profile.options;
  const notes: PlannedNote[] = [];
  const id = idOf(test.test);
  const key = String(id);
  const owner: AlmOwner = { kind: "tests", id, testId: id };

  const planned: PlannedCase = {
    sourceId: key,
    sourceUrl: null,
    name: plain(one(test.test, "name")) || almLabel(id),
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
  const addCustomField = (name: string, values: string[]) => {
    if (values.length === 0) {
      return;
    }
    const existing = planned.customFields[name] ?? [];
    planned.customFields[name] = [...existing, ...values.filter((v) => !existing.includes(v))];
  };
  const inlineIds = new Set<string>();
  const examples = examplesSink(options.gherkinExamples);
  /** ALM rich text to Markdown; pictures inside it are planned as attachments of the case. */
  const text = (raw: string): string => {
    const converted = convertText(prepareHtml(raw, assets, owner), formatOf(raw));
    converted.attachmentIds.forEach((attachmentId) => inlineIds.add(attachmentId));
    return tidy(converted.text);
  };

  // The Test Plan folders around the test become custom fields, one per level.
  for (const [field, values] of mapSectionPath(folderPath(Number(one(test.test, "parent-id") ?? 0) || null, context.folders), profile.structure)) {
    addCustomField(field, values);
  }

  const texts: Record<TextTarget, string[]> = { description: [], precondition: [], expectedResult: [] };
  let scenarioSet = false;

  for (const mapping of profile.fields) {
    const target = mapping.target;
    const field = catalog.get(mapping.source);
    const label = field?.label ?? mapping.source;
    const values = () => mappedAlmValues(test, mapping, catalog);
    const richText = () => (mapping.source === "alm:parameters" ? catalog.text(test, mapping.source) : field?.kind === "text" ? text(catalog.text(test, mapping.source)) : values().join(", "));
    switch (target.kind) {
      case "ignore":
      case "name":
      case "sourceId":
      case "allureId":
      case "scenarioExpected":
      case "attachment":
        break;
      case "examples": {
        // ALM keeps one default value per parameter; the values of a run are set in the test set.
        const row = test.parameters.map((parameter) => ({ name: one(parameter, "name") ?? "", value: plain(one(parameter, "default-value")) })).filter((parameter) => parameter.name);
        if (row.length > 0) {
          examples.examples.push(row);
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
        planned.owner ??= mappedAlmValues(test, mapping, catalog, true)[0] ?? null;
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
        for (const name of mappedAlmValues(test, mapping, catalog, true)) {
          if (!planned.members.some((m) => m.name === name && m.role === target.role)) {
            planned.members.push({ name, role: target.role });
          }
        }
        break;
      case "link":
        for (const value of values()) {
          if (/^https?:\/\/\S+$/i.test(value)) {
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
        if (mapping.source === "alm:steps") {
          steps = almSteps(test, context, options.migrateSharedSteps);
        } else {
          const raw = catalog.text(test, mapping.source);
          steps = raw ? textSteps(prepareHtml(raw, assets, owner), options.textSteps, formatOf(raw), examples) : [];
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
  // Files of the test, then pictures that only appear in its text. Attachments that are addresses become links.
  for (const file of test.attachments) {
    const name = one(file, "name");
    if (!name) {
      continue;
    }
    if (isUrlAttachment(file)) {
      if (/^https?:\/\/\S+$/i.test(name)) {
        planned.links.push({ name: plain(one(file, "description")) || name, url: name });
      }
    } else {
      planned.attachments.push(assets.planned(owner, file));
    }
  }
  for (const attachmentId of inlineIds) {
    if (!planned.attachments.some((attachment) => attachment.sourceId === attachmentId)) {
      planned.attachments.push({ ...inlineAttachment(attachmentId), fileName: assets.fileName(attachmentId) ?? inlineAttachment(attachmentId).fileName });
    }
  }
  if (examples.examples.length > 0) {
    planned.examples = examples.examples;
  }

  for (const step of test.steps) {
    const calledId = Number(one(step, "link-test") ?? 0);
    if (calledId > 0 && !context.called.has(calledId)) {
      notes.push({
        code: "alm-called-test-missing",
        text: `A step calls ${almLabel(calledId)}, which could not be read; the step only names it.`,
        summary: "Some steps call tests that could not be read; those steps only name the test.",
        hint: "The called test may have been deleted, or be in a folder the ALM user cannot see. Give the user access to it and run again.",
        fix: { step: "connections" },
      });
    }
  }
  if (test.steps.length > 0 && !profile.fields.some((m) => m.source === "alm:steps" && m.target.kind !== "ignore")) {
    notes.push({
      code: "alm-steps-not-mapped",
      text: `This test has ${test.steps.length} design step(s), but "Design steps" is not migrated.`,
      summary: 'Some tests have design steps, but "Design steps" is not migrated.',
      hint: "Map Design steps to the scenario on the Fields step.",
      fix: { step: "fields", field: "alm:steps" },
    });
  }
  return { planned, linkedCaseIds: [] };
}
