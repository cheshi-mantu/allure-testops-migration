import { describe, expect, it } from "vitest";
import { FieldCatalog } from "./fields.js";

describe("FieldCatalog", () => {
  const catalog = new FieldCatalog({
    projectId: 1,
    caseFields: [
      { id: 1, system_name: "custom_testrail_bdd_scenario", name: "testrail_bdd_scenario", label: "BDD Scenario", type_id: 13, configs: [{ context: { is_global: true } }] },
      { id: 2, system_name: "custom_case_preconds", name: "preconds", label: "Preconditions", type_id: 3, configs: [{ context: { is_global: false, project_ids: [1] } }] },
    ],
    priorities: [],
    caseTypes: [],
    caseStatuses: [],
    users: [],
    milestones: [],
    templates: [],
  });

  it("reads BDD scenarios as text", () => {
    const testCase = { id: 1, title: "Log in", section_id: 1, suite_id: 1, custom_testrail_bdd_scenario: [{ content: "Scenario: Log in\nGiven I am on the login page" }, { content: "Scenario: Log out" }] };
    expect(catalog.get("custom_testrail_bdd_scenario")?.kind).toBe("text");
    expect(catalog.value(testCase, "custom_testrail_bdd_scenario").labels).toEqual(["Scenario: Log in\nGiven I am on the login page\n\nScenario: Log out"]);
  });

  it("keeps the system names of TestRail 9 and later", () => {
    expect(catalog.get("custom_case_preconds")?.label).toBe("Preconditions");
  });
});
