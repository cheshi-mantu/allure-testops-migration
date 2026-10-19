import type { TestOpsDiscovery, TestRailFieldInfo } from "./api.js";
import { ProfileSchema, type FieldMapping, type FieldTarget, type Profile, type SourceType } from "./profile.js";

export function newProfile(id: string, name: string, now = new Date(), source: SourceType = "testrail"): Profile {
  return ProfileSchema.parse({
    id,
    name,
    source,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...(source === "csv"
      ? { options: { migrationTagPrefix: "csv", selfLink: false }, structure: { treeName: "CSV sections" } }
      : source === "xml"
        ? { options: { migrationTagPrefix: "xml", selfLink: false }, structure: { treeName: "XML sections" } }
        : source === "xray"
          ? { options: { migrationTagPrefix: "xray" }, structure: { treeName: "Xray folders" } }
          : source === "zephyr"
            ? { options: { migrationTagPrefix: "zephyr", selfLink: false }, structure: { treeName: "Zephyr folders" } }
          : source === "squad"
            ? { options: { migrationTagPrefix: "squad" }, structure: { createTree: false } }
          : source === "qase"
            ? { options: { migrationTagPrefix: "qase" }, structure: { treeName: "Qase suites" } }
            : source === "alm"
              ? { options: { migrationTagPrefix: "alm", selfLink: false }, structure: { treeName: "ALM folders" } }
            : source === "testops"
              ? { options: { migrationTagPrefix: "old_id", selfLink: false }, structure: { createTree: false } }
              : {}),
  });
}

/**
 * TestRail 9.0 and later name case fields `custom_case_<name>`, older ones `custom_<name>`:
 * the name the defaults below are written for.
 */
function classicName(systemName: string): string {
  return systemName.replace(/^custom_case_/, "custom_");
}

/** Field targets that make sense for a source field: "Do not migrate" first, then the most natural ones. */
export function allowedTargets(field: TestRailFieldInfo): FieldTarget["kind"][] {
  return ["ignore", ...targetsOf(field).filter((kind) => kind !== "ignore")];
}

function targetsOf(field: TestRailFieldInfo): FieldTarget["kind"][] {
  switch (field.kind) {
    case "column":
      return [
        "name",
        "sourceId",
        "description",
        "precondition",
        "expectedResult",
        "scenario",
        "scenarioExpected",
        "customField",
        "tag",
        "layer",
        "status",
        "owner",
        "role",
        "link",
        "attachment",
        "issue",
        "comment",
        "allureId",
        "ignore",
      ];
    case "steps":
      return ["scenario", "ignore"];
    case "text":
      if (field.systemName === "qase:parameters" || field.systemName === "alm:parameters") {
        return ["examples", "description", "comment", "ignore"];
      }
      if (field.systemName === "xray:preconditions") {
        return ["precondition", "description", "comment", "customField", "tag", "ignore"];
      }
      if (classicName(field.systemName) === "custom_steps" || field.systemName === "xray:definition" || field.systemName === "zephyr:script") {
        return ["scenario", "description", "precondition", "expectedResult", "comment", "ignore"];
      }
      return ["description", "precondition", "expectedResult", "comment", "customField", "tag", "ignore"];
    case "url":
      return ["link", "customField", "description", "ignore"];
    case "user":
      return ["owner", "role", "customField", "tag", "ignore"];
    default:
      if (field.systemName === "refs" || field.systemName.startsWith("jira:link:") || field.systemName.startsWith("zephyr:issues:") || field.systemName === "qase:external_issues") {
        return ["issue", "link", "tag", "customField", "ignore"];
      }
      return ["customField", "tag", "layer", "status", "owner", "description", "precondition", "comment", "ignore"];
  }
}

const TEXT_DEFAULTS: Record<string, FieldTarget> = {
  custom_preconds: { kind: "precondition", heading: "" },
  custom_steps: { kind: "scenario" },
  custom_steps_separated: { kind: "scenario" },
  custom_expected: { kind: "expectedResult", heading: "" },
  custom_description: { kind: "description", heading: "" },
  custom_mission: { kind: "description", heading: "Mission" },
  custom_goals: { kind: "description", heading: "Goals" },
};

/** A sensible first mapping for a source field. The user reviews every suggestion in the UI. */
export function suggestTarget(field: TestRailFieldInfo, testops?: TestOpsDiscovery | null): FieldTarget {
  // Empty in every sampled record: nothing to migrate. The user can still choose a target.
  if (field.filledCount === 0) {
    return { kind: "ignore" };
  }
  if (field.suggestedTarget) {
    const target = field.suggestedTarget;
    if (target.kind === "issue" && target.integrationId === null && testops?.integrations.length === 1) {
      return { kind: "issue", integrationId: testops.integrations[0]!.id };
    }
    return target;
  }
  const preset = TEXT_DEFAULTS[classicName(field.systemName)];
  if (preset) {
    return preset;
  }
  switch (field.systemName) {
    case "created_by":
      return { kind: "owner" };
    case "refs": {
      const integration = testops?.integrations.length === 1 ? testops.integrations[0]! : null;
      return integration ? { kind: "issue", integrationId: integration.id } : { kind: "link" };
    }
    case "updated_by":
    case "estimate":
    case "template_id":
    case "created_on":
    case "updated_on":
      return { kind: "ignore" };
    default:
      break;
  }
  switch (field.kind) {
    case "steps":
      return { kind: "scenario" };
    case "text":
      return field.filledCount > 0 ? { kind: "description", heading: field.label } : { kind: "ignore" };
    case "url":
      return { kind: "link" };
    case "date":
      return { kind: "ignore" };
    case "user":
      return { kind: "customField", name: field.label };
    default:
      return { kind: "customField", name: field.label };
  }
}

export function suggestMapping(field: TestRailFieldInfo, testops?: TestOpsDiscovery | null): FieldMapping {
  return {
    source: field.systemName,
    target: suggestTarget(field, testops),
    values: field.suggestedValues ?? (field.kind === "checkbox" ? { "1": "Yes", "0": null } : {}),
    separator: field.suggestedSeparator ?? (field.systemName === "refs" ? "," : ""),
  };
}

/**
 * Adds a suggested mapping for every discovered field that has none yet, keeping the user's choices.
 * Mappings of fields that no longer exist are kept too, so a temporary connection problem loses nothing.
 */
export function mergeSuggestedMappings(
  current: FieldMapping[],
  fields: TestRailFieldInfo[],
  testops?: TestOpsDiscovery | null,
): FieldMapping[] {
  const known = new Set(current.map((mapping) => mapping.source));
  const added = fields.filter((field) => !known.has(field.systemName)).map((field) => suggestMapping(field, testops));
  return [...current, ...added];
}
