import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestOpsMock, type TestOpsMockState } from "@atm/mocks";
import { mergeSuggestedMappings, newProfile, type Profile, type RunSummary } from "@atm/shared";
import { RunManager } from "../src/engine/runner.js";
import { FileStore } from "../src/storage/fileStore.js";
import { RunStore } from "../src/storage/runs.js";
import { discoverTestOps } from "../src/testops/discovery.js";
import { discoverXml, previewXml } from "../src/xml/source.js";

const fixture = (name: string) => readFile(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));

describe("XML to Allure TestOps migration", () => {
  const testops = createTestOpsMock();
  let state: TestOpsMockState;
  let dataDir: string;
  let files: FileStore;
  let store: RunStore;
  let runner: RunManager;

  beforeAll(async () => {
    await testops.app.listen({ port: 0, host: "127.0.0.1" });
    state = testops.state;
    dataDir = await mkdtemp(join(tmpdir(), "atm-xml-"));
    files = new FileStore(dataDir);
    store = new RunStore(dataDir);
    runner = new RunManager(store, { files });
  });

  afterAll(async () => {
    await testops.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function profileFor(name: string, id: string): Promise<Profile> {
    const file = await files.save(name, await fixture(name));
    const profile = newProfile(id, id, new Date(), "xml");
    profile.xml.fileId = file.id;
    profile.testops.connection = {
      endpoint: `http://127.0.0.1:${(testops.app.server.address() as AddressInfo).port}/`,
      apiToken: "demo-api-token",
      insecureTls: false,
    };
    profile.testops.scope.projectId = 1;
    return profile;
  }

  async function run(profile: Profile, dryRun = false): Promise<RunSummary> {
    const started = runner.start(profile, dryRun);
    while (runner.isActive(profile.id, started.id)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return (await store.get(profile.id, started.id))!;
  }

  const byTag = (tag: string) => state.testCases.find((tc) => tc.tags.includes(tag))!;
  const cf = (tc: { cfv: { name: string; customField: { id: number } }[] }, name: string) =>
    tc.cfv.filter((v) => state.customFields.find((f) => f.id === v.customField.id)?.name === name).map((v) => v.name);

  it("migrates a TestRail export with the suggested mapping", async () => {
    const profile = await profileFor("testrail-export.xml", "testrail");
    const preview = await previewXml(profile, files);
    expect(preview).toMatchObject({ caseElement: "case", caseCount: 5, depth: 3 });
    expect(preview.stepLists).toEqual([{ field: "custom/steps_separated", action: "content", expected: "expected", data: "additional_info", cases: 2 }]);
    expect(preview.sample[1]).toMatchObject({ id: "C11", name: "Reset a forgotten password", path: ["Web shop", "Auth", "Password"], steps: 3 });

    const discovery = await discoverXml(profile, files);
    expect(discovery.levels.map((level) => level.sectionCount)).toEqual([2, 1, 1]);
    const suggested = Object.fromEntries(discovery.fields.map((f) => [f.systemName, f.suggestedTarget]));
    expect(suggested).toMatchObject({
      id: { kind: "sourceId" },
      title: { kind: "name" },
      type: { kind: "customField", name: "Type" },
      priority: { kind: "customField", name: "Priority" },
      "custom/browser": { kind: "customField", name: "Browser" },
      "custom/platforms": { kind: "customField", name: "Platforms" },
      "custom/preconds": { kind: "precondition" },
      "custom/steps_separated": { kind: "scenario" },
      "custom/steps": { kind: "scenario" },
      "custom/expected": { kind: "expectedResult" },
      "custom/testrail_bdd_scenario/scenario/content": { kind: "scenario" },
      "attachments/url": { kind: "link" },
      "attachments/name": { kind: "ignore" },
      "attachments/id": { kind: "ignore" },
      is_converted: { kind: "ignore" },
    });
    expect(discovery.fields.find((f) => f.systemName === "custom/platforms")?.options?.map((o) => o.label).sort()).toEqual(["API", "Web", "iOS"]);

    const target = await discoverTestOps(profile);
    profile.fields = mergeSuggestedMappings([], discovery.fields, target);
    profile.structure.levels = ["Epic", "Feature", "Story"];

    const summary = await run(profile);
    // The case without a title cannot be created.
    expect(summary.counters).toMatchObject({ total: 5, created: 4 });
    expect(JSON.stringify(summary.problems)).toContain("map a field that is always filled");

    const checklist = byTag("xml:C10");
    expect(checklist.name).toBe("Release smoke checklist");
    expect(cf(checklist, "Epic")).toEqual(["Web shop"]);
    expect(cf(checklist, "Priority")).toEqual(["High"]);
    expect(cf(checklist, "Browser")).toEqual(["Edge"]);
    expect(checklist.scenario.map((s) => s.data.body)).toEqual(["Open the home page", "Log in as a customer"]);

    const reset = byTag("xml:C11");
    expect(cf(reset, "Epic")).toEqual(["Web shop"]);
    expect(cf(reset, "Feature")).toEqual(["Auth"]);
    expect(cf(reset, "Story")).toEqual(["Password"]);
    expect(cf(reset, "Platforms").sort()).toEqual(["Web", "iOS"]);
    expect(reset.precondition).toContain("[screenshot.png](https://testrail.example.com/index.php?/attachments/get/501)");
    expect(reset.precondition).toContain("**User** `jane@example.com` exists.");
    expect(reset.scenario).toHaveLength(3);
    expect(reset.scenario[0]!.data.body).toBe("Open the login page");
    expect(JSON.stringify(reset.scenario[1])).toContain("The reset form is shown");
    // The table of step data is kept as an attachment of the step.
    expect(JSON.stringify(reset.scenario[2])).toContain('"type":"attachment"');
    expect(reset.links.map((link: { name: string }) => link.name).sort()).toEqual(["screenshot.png", "test-data.csv"]);

    const bdd = byTag("xml:C12");
    expect(bdd.scenario.map((s) => s.data.body).join("\n")).toContain("Given I am on the sign-up page");

    const text = byTag("xml:C13");
    expect(text.scenario.map((s) => s.data.body)).toEqual(["Create an order", "Pay for it"]);
    expect(text.expectedResult).toBe("The order is paid.");
    expect(cf(text, "Epic")).toEqual(["API"]);

    const again = await run(profile);
    expect(again.counters).toMatchObject({ created: 0, updated: 4 });
    expect(state.testCases.filter((tc) => tc.tags.some((t) => t.startsWith("xml:")))).toHaveLength(4);
  });

  it("migrates a TestLink export: names in attributes, pairs and numeric codes", async () => {
    const profile = await profileFor("testlink-export.xml", "testlink");
    profile.migrationTagPrefix = "tl";
    const discovery = await discoverXml(profile, files);
    const suggested = Object.fromEntries(discovery.fields.map((f) => [f.systemName, f.suggestedTarget]));
    expect(suggested).toMatchObject({
      "@name": { kind: "name" },
      summary: { kind: "description" },
      preconditions: { kind: "precondition" },
      "keywords/@name": { kind: "tag" },
      "custom_fields/Browser": { kind: "customField", name: "Browser" },
      importance: { kind: "customField", name: "Importance" },
      status: { kind: "status" },
      steps: { kind: "scenario" },
      "@internalid": { kind: "ignore" },
      node_order: { kind: "ignore" },
    });
    expect(discovery.fields.find((f) => f.systemName === "importance")?.suggestedValues).toMatchObject({ "3": "High" });

    const target = await discoverTestOps(profile);
    profile.fields = mergeSuggestedMappings([], discovery.fields, target);
    profile.structure.levels = ["Epic", "Feature"];
    const summary = await run(profile);
    expect(summary.counters).toMatchObject({ total: 2, created: 2, failed: 0 });

    const valid = state.testCases.find((tc) => tc.name === "Valid login")!;
    expect(valid.description).toBe("Checks that a **registered** user can sign in.");
    expect(valid.precondition).toBe("The user exists.");
    expect(valid.tags).toEqual(expect.arrayContaining(["smoke", "login"]));
    expect(cf(valid, "Importance")).toEqual(["High"]);
    expect(cf(valid, "Browser")).toEqual(["Chrome"]);
    expect(cf(valid, "Epic")).toEqual(["Login"]);
    expect(valid.scenario.map((s) => s.data.body)).toEqual(["Open the login page", "Enter the credentials and submit"]);
    const wrong = state.testCases.find((tc) => tc.name === "Wrong password")!;
    expect(cf(wrong, "Feature")).toEqual(["Errors"]);
    expect(cf(wrong, "Importance")).toEqual(["Medium"]);
  });

  it("explains a file that is not XML", async () => {
    const file = await files.save("cases.xml", Buffer.from("id,title\n1,Login\n"));
    const profile = newProfile("broken", "broken", new Date(), "xml");
    profile.xml.fileId = file.id;
    await expect(previewXml(profile, files)).rejects.toMatchObject({ explanation: { key: "xml-not-readable" } });
  });
});
