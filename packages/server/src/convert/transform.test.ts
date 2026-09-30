import { describe, expect, it } from "vitest";
import { newProfile, type FieldMapping, type Profile } from "@atm/shared";
import { FieldCatalog } from "../testrail/fields.js";
import { SectionTree } from "../testrail/sections.js";
import type { TrCase } from "../testrail/types.js";
import { transformCase, type SourceContext } from "./transform.js";

const catalog = new FieldCatalog({
  projectId: 1,
  caseFields: [
    { id: 1, system_name: "custom_preconds", name: "preconds", label: "Preconditions", type_id: 3, configs: [{ context: { is_global: true } }] },
    { id: 2, system_name: "custom_steps_separated", name: "steps_separated", label: "Steps", type_id: 10, configs: [{ context: { is_global: true } }] },
    {
      id: 3,
      system_name: "custom_platform",
      name: "platform",
      label: "Platform",
      type_id: 12,
      configs: [{ context: { is_global: false, project_ids: [1] }, options: { items: "1, Web\n2, iOS\n3, Android" } }],
    },
    { id: 4, system_name: "custom_other_project", name: "x", label: "X", type_id: 1, configs: [{ context: { is_global: false, project_ids: [99] } }] },
    { id: 5, system_name: "custom_automated", name: "automated", label: "Automated", type_id: 5, configs: [{ context: { is_global: true } }] },
  ],
  priorities: [
    { id: 1, name: "Low" },
    { id: 4, name: "Critical" },
  ],
  caseTypes: [{ id: 6, name: "Functional" }],
  caseStatuses: [],
  users: [{ id: 2, name: "Jane Doe", email: "jane@example.com" }],
  milestones: [],
  templates: [],
});

const baseCase: TrCase = {
  id: 101,
  title: "Login works",
  section_id: 12,
  suite_id: 3,
  priority_id: 4,
  type_id: 6,
  created_by: 2,
  refs: "PRJ-1, PRJ-2",
  custom_preconds: "User exists\n![](index.php?/attachments/get/77)",
  custom_platform: [1, 3],
  custom_automated: true,
  custom_steps_separated: [
    { content: "Open page", expected: "Page open" },
    { content: "shared 1", shared_step_id: 9 },
    { content: "shared 2", shared_step_id: 9 },
    { content: "Enter [other](https://tr.example/index.php?/cases/view/55)", additional_info: "|||:a|:b\n|| 1 | 2" },
  ],
};

function context(profile: Profile): SourceContext {
  return {
    catalog,
    profile,
    endpoint: "https://tr.example/",
    project: { id: 1, name: "Shop", suite_mode: 3 },
    suites: new Map([[3, { id: 3, name: "Regression", project_id: 1, description: "Suite notes" }]]),
    sections: new Map([
      [
        3,
        new SectionTree([
          { id: 10, name: "Web", parent_id: null, suite_id: 3, depth: 0 },
          { id: 11, name: "Auth", parent_id: 10, suite_id: 3, depth: 1 },
          { id: 12, name: "Login", parent_id: 11, suite_id: 3, depth: 2 },
        ]),
      ],
    ]),
  };
}

function profileWith(fields: FieldMapping[], patch: (p: Profile) => void = () => {}): Profile {
  const profile = newProfile("p1", "Test");
  profile.fields = fields;
  profile.structure.suiteField = "Suite";
  profile.structure.levels = ["Area", "Feature"];
  patch(profile);
  return profile;
}

const map = (source: string, target: FieldMapping["target"], values: Record<string, string | null> = {}, separator = ""): FieldMapping => ({
  source,
  target,
  values,
  separator,
});

describe("FieldCatalog", () => {
  it("only knows custom fields configured for the project", () => {
    expect(catalog.get("custom_platform")?.options?.get("3")).toBe("Android");
    expect(catalog.get("custom_other_project")).toBeUndefined();
  });
});

describe("transformCase", () => {
  it("maps structure, fields, values and scenario", () => {
    const profile = profileWith([
      map("priority_id", { kind: "customField", name: "Priority" }, { "4": "Blocker" }),
      map("custom_platform", { kind: "customField", name: "Platform" }, { "3": null }),
      map("type_id", { kind: "tag" }),
      map("created_by", { kind: "owner" }),
      map("refs", { kind: "issue", integrationId: 5 }, {}, ","),
      map("custom_preconds", { kind: "precondition", heading: "" }),
      map("custom_steps_separated", { kind: "scenario" }),
      map("custom_automated", { kind: "customField", name: "Automated" }),
    ]);
    const { planned, linkedCaseIds } = transformCase(baseCase, context(profile));

    expect(planned.name).toBe("Login works");
    expect(planned.tags).toEqual(["testrail:101", "Functional"]);
    expect(planned.customFields).toEqual({
      Suite: ["Regression"],
      Area: ["Web"],
      Feature: ["Auth / Login"],
      Priority: ["Blocker"],
      Platform: ["Web"],
      Automated: ["Yes"],
    });
    expect(planned.owner).toBe("jane@example.com");
    expect(planned.issues).toEqual([
      { key: "PRJ-1", integrationId: 5 },
      { key: "PRJ-2", integrationId: 5 },
    ]);
    expect(planned.precondition).toBe("User exists\n![](testrail-attachment:77)");
    expect(planned.attachments).toEqual([{ sourceId: "77", fileName: "attachment-77" }]);
    expect(planned.links[0]).toEqual({ name: "TestRail C101", url: "https://tr.example/index.php?/cases/view/101" });
    expect(linkedCaseIds).toEqual(["55"]);

    expect(planned.scenario).toHaveLength(3);
    expect(planned.scenario[0]).toMatchObject({ type: "step", body: "Open page", expected: "Page open" });
    expect(planned.scenario[1]).toEqual({ type: "shared", sourceId: 9, name: "" });
    const last = planned.scenario[2]!;
    expect(last.type === "step" && last.dataAttachments[0]).toMatchObject({ sourceId: null, fileName: "step-4-data-table-1.csv", content: "a,b\n1,2\n" });
  });

  it("drops deeper sections when configured and adds parent descriptions", () => {
    const profile = profileWith([], (p) => {
      p.structure.deeperLevels = "drop";
      p.options.parentDescriptions = true;
      p.options.selfLink = false;
    });
    const { planned } = transformCase(baseCase, context(profile));
    expect(planned.customFields.Feature).toEqual(["Auth"]);
    expect(planned.description).toBe("### Regression\n\nSuite notes");
    expect(planned.links).toEqual([]);
  });

  it("combines several text fields with headings", () => {
    const profile = profileWith([
      map("custom_preconds", { kind: "description", heading: "Preconditions" }),
      map("priority_id", { kind: "description", heading: "Priority" }),
    ]);
    const { planned } = transformCase(baseCase, context(profile));
    expect(planned.description).toBe("### Preconditions\n\nUser exists\n![](testrail-attachment:77)\n\n### Priority\n\nCritical");
  });

  it("inlines shared steps when shared step migration is off", () => {
    const profile = profileWith([map("custom_steps_separated", { kind: "scenario" })], (p) => {
      p.options.migrateSharedSteps = false;
    });
    const { planned } = transformCase(baseCase, context(profile));
    expect(planned.scenario.map((s) => (s.type === "step" ? s.body : "shared"))).toEqual(["Open page", "shared 1", "shared 2", "Enter [other](https://tr.example/index.php?/cases/view/55)"]);
  });

  it("builds text scenarios line by line", () => {
    const profile = profileWith([map("custom_steps", { kind: "scenario" })]);
    const { planned } = transformCase({ ...baseCase, custom_steps: "1. Open\n![](index.php?/attachments/get/3)\n2. Click" }, context(profile));
    expect(planned.scenario).toHaveLength(2);
    expect(planned.scenario[0]).toMatchObject({ body: "Open", attachments: [{ sourceId: "3" }] });
    expect(planned.scenario[1]).toMatchObject({ body: "Click" });
  });
});
