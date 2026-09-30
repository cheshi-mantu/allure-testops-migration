import type { PlannedNote } from "@atm/shared";

/** Notes shared by all sources, so the same problem reads and groups the same way. */
export const note = {
  linkNotUrl: (value: string, field: string, label = field): PlannedNote => ({
    code: "link-not-url",
    text: `"${value}" in ${label} is not a URL, so it does not become a link.`,
    summary: `Values of ${label} that are not URLs do not become links.`,
    hint: "Only values starting with http:// or https:// become links. Set a separator if a cell holds several links, or map the field to a custom field or the description instead.",
    fix: { step: "fields", field },
  }),
  issueWithoutIntegration: (field: string, label = field): PlannedNote => ({
    code: "issue-no-integration",
    text: `Issues from ${label} are skipped: no issue tracker integration is chosen.`,
    summary: `Issues from ${label} are skipped: no issue tracker integration is chosen.`,
    hint: "Choose the issue tracker integration for this field. It must be set up in the Allure TestOps project first (project settings, Integrations).",
    fix: { step: "fields", field },
  }),
  scenarioTwice: (field: string, label = field): PlannedNote => ({
    code: "scenario-twice",
    text: `${label} also maps to the scenario; only the first non-empty one is used.`,
    summary: `Several fields map to the scenario; only the first non-empty one is used.`,
    hint: "Map only one field to the scenario, and the other one to the description or precondition.",
    fix: { step: "fields", field },
  }),
};
