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
      : {}),
  });
}

/** Field targets that make sense for a TestRail field, most natural first. */
export function allowedTargets(field: TestRailFieldInfo): FieldTarget["kind"][] {
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
        "issue",
        "comment",
        "allureId",
        "ignore",
      ];
    case "steps":
      return ["scenario", "ignore"];
    case "text":
      if (field.systemName === "custom_steps") {
        return ["scenario", "description", "precondition", "expectedResult", "comment", "ignore"];
      }
      return ["description", "precondition", "expectedResult", "comment", "customField", "tag", "ignore"];
    case "url":
      return ["link", "customField", "description", "ignore"];
    case "user":
      return ["owner", "customField", "tag", "ignore"];
    default:
      if (field.systemName === "refs") {
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

/** A sensible first mapping for a TestRail field. The user reviews every suggestion in the UI. */
export function suggestTarget(field: TestRailFieldInfo, testops?: TestOpsDiscovery | null): FieldTarget {
  if (field.suggestedTarget) {
    const target = field.suggestedTarget;
    if (target.kind === "issue" && target.integrationId === null && testops?.integrations.length === 1) {
      return { kind: "issue", integrationId: testops.integrations[0]!.id };
    }
    return target;
  }
  const preset = TEXT_DEFAULTS[field.systemName];
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
    values: field.kind === "checkbox" ? { "1": "Yes", "0": null } : {},
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
