import type { PlannedCase, PlannedStep } from "./api.js";

/** Tags as Allure TestOps keeps them after a migration: in lower case, without repeats. */
export function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
}

const trimmed = (value: string | null | undefined): string | null => {
  const text = value?.trim();
  return text ? text : null;
};

function normalizeSteps(steps: PlannedStep[]): PlannedStep[] {
  return steps.map((step) =>
    step.type === "step"
      ? {
          ...step,
          body: step.body.trim(),
          data: trimmed(step.data),
          expected: trimmed(step.expected),
          ...(step.steps ? { steps: normalizeSteps(step.steps) } : {}),
        }
      : { ...step, name: step.name.trim() },
  );
}

/**
 * Every value of a planned case as the migration writes it, whatever the source: no spaces at the
 * start or end, no empty values, no repeats. Tags, the test layer and the status are in lower
 * case; layers and statuses are matched in Allure TestOps without regard to case.
 */
export function normalizePlanned<T extends PlannedCase>(planned: T): T {
  const values = (list: string[]) => [...new Set(list.map((value) => value.trim()).filter(Boolean))];
  const customFields: Record<string, string[]> = {};
  for (const [name, list] of Object.entries(planned.customFields)) {
    const field = name.trim();
    const kept = values([...(customFields[field] ?? []), ...list]);
    if (field && kept.length > 0) {
      customFields[field] = kept;
    }
  }
  const members = planned.members
    .map((member) => ({ name: member.name.trim(), role: member.role.trim() }))
    .filter((member, index, all) => member.name && all.findIndex((other) => other.name === member.name && other.role === member.role) === index);
  return {
    ...planned,
    sourceId: planned.sourceId.trim(),
    name: planned.name.trim(),
    description: planned.description.trim(),
    precondition: planned.precondition.trim(),
    expectedResult: planned.expectedResult.trim(),
    tags: normalizeTags(planned.tags),
    customFields,
    layer: trimmed(planned.layer)?.toLowerCase() ?? null,
    status: trimmed(planned.status)?.toLowerCase() ?? null,
    owner: trimmed(planned.owner),
    members,
    links: planned.links.map((link) => ({ name: link.name.trim() || link.url.trim(), url: link.url.trim() })).filter((link) => link.url),
    issues: planned.issues.map((issue) => ({ ...issue, key: issue.key.trim() })).filter((issue) => issue.key),
    ...(planned.testKeys ? { testKeys: planned.testKeys.map((key) => ({ ...key, key: key.key.trim() })).filter((key) => key.key) } : {}),
    ...(planned.examples ? { examples: planned.examples.map((example) => example.map((parameter) => ({ name: parameter.name.trim(), value: parameter.value.trim() }))) } : {}),
    comments: values(planned.comments),
    attachments: planned.attachments.map((attachment) => ({ ...attachment, fileName: attachment.fileName.trim() })),
    scenario: normalizeSteps(planned.scenario),
  };
}
