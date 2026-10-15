import type { PlannedAttachment, PlannedCase, PlannedNote, PlannedStep, Profile } from "@atm/shared";
import { ATTACHMENT_SCHEME } from "../convert/markup.js";
import { migrationTag } from "../convert/transform.js";
import type { ToComment, ToNormalizedScenarioFull, ToNormalizedStep, ToTestCaseOverview } from "../testops/client.js";

/**
 * A test case of one Allure TestOps instance as the case another instance gets: the same fields,
 * text, scenario, custom fields with all their values, members, issues and test keys. Text is
 * Markdown on both sides and is kept as it is; only references to files are re-pointed.
 */

/** A source case with what is read about it besides the overview. */
export interface SourceTestCase {
  overview: ToTestCaseOverview;
  scenario: ToNormalizedScenarioFull;
  comments: ToComment[];
}

export interface FromTestOpsContext {
  profile: Profile;
  /** Address of the source instance with a trailing slash, for links back to the cases. */
  sourceBase: string;
  /** Integration of the source -> integration of the target; null skips it. */
  integrations: Map<number, number | null>;
  /** Names of the source integrations, for messages. */
  integrationNames: Map<number, string>;
}

/** Planned attachment ids: files of cases and files of shared steps are served by different paths. */
export const CASE_FILE = "c";
export const SHARED_FILE = "s";

/** `![x](/api/rs/testcase/attachment/12/content)`, also with the address of the instance in front. */
const FILE_LINK = /(?:https?:\/\/[^\s)"'<>]*?)?\/api\/rs\/(testcase|sharedstep)\/attachment\/(\d+)\/content/g;

/** References to files of the source become references to planned attachments. */
export function withFileReferences(text: string): { text: string; ids: string[] } {
  const ids: string[] = [];
  const replaced = text.replace(FILE_LINK, (_match, owner: string, id: string) => {
    const key = `${owner === "sharedstep" ? SHARED_FILE : CASE_FILE}${id}`;
    ids.push(key);
    return `${ATTACHMENT_SCHEME}${key}`;
  });
  return { text: replaced, ids };
}

/** The steps of a normalized scenario, nested as they are; files become attachments of their step. */
export function scenarioSteps(
  ids: number[],
  scenario: ToNormalizedScenarioFull,
  options: { useSharedSteps: boolean; inShared: boolean },
): PlannedStep[] {
  const steps = options.inShared ? (scenario.sharedStepScenarioSteps ?? {}) : (scenario.scenarioSteps ?? {});
  const files = options.inShared ? (scenario.sharedStepAttachments ?? {}) : (scenario.attachments ?? {});
  const prefix = options.inShared ? SHARED_FILE : CASE_FILE;
  const file = (attachmentId: number): PlannedAttachment => ({ sourceId: `${prefix}${attachmentId}`, fileName: files[attachmentId]?.name ?? `attachment-${attachmentId}` });
  const result: PlannedStep[] = [];
  for (const id of ids) {
    const step = steps[id];
    if (!step) {
      continue;
    }
    if (step.sharedStepId) {
      const shared = scenario.sharedSteps?.[step.sharedStepId];
      const name = shared?.name ?? shared?.body ?? `Shared step ${step.sharedStepId}`;
      if (options.useSharedSteps) {
        result.push({ type: "shared", sourceId: step.sharedStepId, name });
      } else {
        // Copied in place: the steps of the shared step under a step named after it.
        const inner = scenarioSteps(shared?.children ?? [], scenario, { useSharedSteps: false, inShared: true });
        result.push({ type: "step", body: name, steps: inner, attachments: [], data: null, dataAttachments: [], expected: null, expectedAttachments: [] });
      }
      continue;
    }
    if (step.attachmentId && !step.body) {
      // A file on its own place among the steps: a step that only holds the file, written back as a file step.
      result.push({ type: "step", body: "", attachments: [file(step.attachmentId)], data: null, dataAttachments: [], expected: null, expectedAttachments: [] });
      continue;
    }
    const children = (step.children ?? []).filter((child) => child !== step.expectedResultId);
    const nested = scenarioSteps(children, scenario, options);
    const expectedHolder = step.expectedResultId ? steps[step.expectedResultId] : undefined;
    const expectedSteps = scenarioSteps(expectedHolder?.children ?? [], scenario, options);
    const expectedText = expectedSteps
      .map((expected) => (expected.type === "step" ? expected.body : expected.name))
      .filter(Boolean)
      .join("\n");
    const expectedAttachments = expectedSteps.flatMap((expected) => (expected.type === "step" ? expected.attachments : []));
    result.push({
      type: "step",
      body: step.body ?? "",
      ...(nested.length > 0 ? { steps: nested } : {}),
      attachments: step.attachmentId ? [file(step.attachmentId)] : [],
      data: null,
      dataAttachments: [],
      expected: expectedText || null,
      expectedAttachments,
    });
  }
  return result;
}

export function transformTestOpsCase(source: SourceTestCase, context: FromTestOpsContext): { planned: PlannedCase; linkedCaseIds: string[] } {
  const { overview, scenario } = source;
  const { profile } = context;
  const options = profile.options;
  const notes: PlannedNote[] = [];
  const inline = new Set<string>();
  const text = (raw: string | null | undefined) => {
    const converted = withFileReferences(raw ?? "");
    converted.ids.forEach((id) => inline.add(id));
    return converted.text;
  };
  const url = `${context.sourceBase}project/${overview.projectId}/test-cases/${overview.id}`;

  const customFields: Record<string, string[]> = {};
  for (const value of overview.customFields ?? []) {
    const name = value.customField?.name;
    if (name && value.name) {
      customFields[name] = [...(customFields[name] ?? []), value.name];
    }
  }

  // Owner is the member with the owner role; other roles are kept by name.
  let owner: string | null = null;
  const members: { name: string; role: string }[] = [];
  for (const member of overview.members ?? []) {
    if (member.role?.id === -1 || member.role?.name?.toLowerCase() === "owner") {
      owner ??= member.name;
    } else if (member.role?.name) {
      members.push({ name: member.name, role: member.role.name });
    }
  }

  /** Keys of an integration of the source, written through the integration chosen for it in the target. */
  const throughIntegration = (keys: { integrationId?: number | null; name: string }[], what: string) => {
    const result: { key: string; integrationId: number }[] = [];
    for (const key of keys) {
      const target = key.integrationId ? context.integrations.get(key.integrationId) : undefined;
      if (target) {
        result.push({ key: key.name, integrationId: target });
        continue;
      }
      const name = (key.integrationId && context.integrationNames.get(key.integrationId)) || `#${key.integrationId ?? "?"}`;
      notes.push({
        code: "testops-integration-not-mapped",
        text: `${what} ${key.name} of the integration "${name}" is not migrated: no integration of the target is chosen for it.`,
        summary: `${what}s of the integration "${name}" are not migrated: no integration of the target is chosen for it.`,
        hint: "Choose the integration of the target Allure TestOps for it on the Projects step. Set it up in the target first (Administration, Integrations) if it is not there.",
        fix: { step: "scope" },
      });
    }
    return result;
  };

  const planned: PlannedCase = {
    sourceId: String(overview.id),
    sourceUrl: url,
    allureId: null,
    name: overview.name,
    description: text(overview.description),
    precondition: text(overview.precondition),
    expectedResult: text(overview.expectedResult),
    tags: [migrationTag(options.migrationTagPrefix, overview.id), ...(overview.tags ?? []).map((tag) => tag.name)],
    customFields,
    layer: overview.layer?.name ?? null,
    status: overview.status?.name ?? null,
    workflow: overview.workflow?.name ?? null,
    automated: Boolean(overview.automated),
    owner,
    members,
    links: (overview.links ?? []).filter((link) => link.url).map((link) => ({ name: link.name || link.url, url: link.url })),
    issues: throughIntegration(overview.issues ?? [], "Issue").map((issue) => ({ key: issue.key, integrationId: issue.integrationId })),
    testKeys: throughIntegration(overview.testKeys ?? [], "Test key"),
    examples: (overview.examples ?? []).map((example) => example.parameters ?? []).filter((parameters) => parameters.length > 0),
    comments: source.comments.map((comment) => text(comment.body)).filter(Boolean),
    attachments: [],
    scenario: scenarioSteps(scenario.root?.children ?? [], scenario, { useSharedSteps: options.migrateSharedSteps, inShared: false }),
    notes,
  };
  if (options.additionalTag.trim()) {
    planned.tags.push(options.additionalTag.trim());
  }
  if (options.selfLink) {
    planned.links.push({ name: `Allure TestOps #${overview.id}`, url });
  }
  // Images in text are files of the case; the rest of its files are listed by the source as the case's attachments.
  planned.attachments = [...inline].map((id) => ({ sourceId: id, fileName: `attachment-${id.slice(1)}` }));
  return { planned, linkedCaseIds: [] };
}
