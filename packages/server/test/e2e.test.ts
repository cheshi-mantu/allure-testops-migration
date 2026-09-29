import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestOpsMock, createTestRailMock, type TestOpsMockState } from "@atm/mocks";
import { mergeSuggestedMappings, newProfile, type Profile, type RunSummary } from "@atm/shared";
import { RunManager } from "../src/engine/runner.js";
import { RunStore } from "../src/storage/runs.js";
import { discoverTestOps } from "../src/testops/discovery.js";
import { discoverTestRail } from "../src/testrail/discovery.js";

/** Full migration against the fake TestRail and Allure TestOps servers. */
describe("TestRail to Allure TestOps migration", () => {
  const testrail = createTestRailMock({ sessionCookie: "tr_session=abc" });
  const testops = createTestOpsMock();
  let state: TestOpsMockState;
  let dataDir: string;
  let profile: Profile;
  let runner: RunManager;
  let store: RunStore;

  const url = (address: AddressInfo) => `http://127.0.0.1:${address.port}/`;

  beforeAll(async () => {
    await testrail.listen({ port: 0, host: "127.0.0.1" });
    await testops.app.listen({ port: 0, host: "127.0.0.1" });
    state = testops.state;
    dataDir = await mkdtemp(join(tmpdir(), "atm-e2e-"));
    store = new RunStore(dataDir);
    runner = new RunManager(store);

    profile = newProfile("e2e", "E2E");
    profile.testrail.connection = {
      endpoint: url(testrail.server.address() as AddressInfo),
      username: "demo@example.com",
      apiKey: "demo-api-key",
      sessionCookie: "tr_session=abc",
      insecureTls: false,
    };
    profile.testrail.scope.projectId = 1;
    profile.testops.connection = { endpoint: url(testops.app.server.address() as AddressInfo), apiToken: "demo-api-token", insecureTls: false };
    profile.testops.scope.projectId = 1;
  });

  afterAll(async () => {
    await testrail.close();
    await testops.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function run(dryRun: boolean): Promise<RunSummary> {
    const started = runner.start(profile, dryRun);
    while (runner.isActive(profile.id, started.id)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return (await store.get(profile.id, started.id))!;
  }

  it("discovers the TestRail structure and fields", async () => {
    const discovery = await discoverTestRail(profile);
    expect(discovery.suites.map((s) => s.name)).toEqual(["Web shop", "Mobile app"]);
    expect(discovery.maxDepth).toBe(4);
    expect(discovery.levels.map((l) => l.examples[0])).toEqual(["Storefront", "Catalog", "Search", "Filters"]);
    const fields = new Map(discovery.fields.map((f) => [f.systemName, f]));
    expect(fields.has("custom_legacy")).toBe(false);
    expect(fields.has("custom_other_team")).toBe(false);
    expect(fields.get("custom_platforms")?.options?.map((o) => o.label)).toEqual(["Web", "iOS", "Android"]);
    expect(fields.get("priority_id")?.options?.find((o) => o.label === "Critical")?.count).toBeGreaterThan(0);

    const target = await discoverTestOps(profile);
    expect(target.warnings).toEqual([]);
    expect(target.customFields.filter((f) => f.inProject).map((f) => f.name)).toEqual(["Epic", "Feature", "Story"]);
    expect(target.integrations).toEqual([{ id: 1, name: "Jira" }]);
    expect(target.users?.map((u) => u.username)).toContain("jane");

    profile.fields = mergeSuggestedMappings([], discovery.fields, target);
    // Owners: TestRail users -> Allure TestOps user names.
    profile.fields = profile.fields.map((m) => (m.source === "created_by" ? { ...m, values: { "1": "admin", "2": "jane", "3": "sam" } } : m));
    profile.structure = { ...profile.structure, suiteField: "Suite", levels: ["Epic", "Feature"], deeperLevels: "join", createTree: true, treeName: "TestRail" };
  });

  it("dry run converts every case without writing", async () => {
    const summary = await run(true);
    expect(summary.status).toBe("finished");
    expect(summary.counters).toMatchObject({ total: 36, failed: 0 });
    expect(state.testCases).toHaveLength(0);
    const log = (await store.log(profile.id, summary.id)).map((e) => e.message);
    expect(log).toContain('Tree "TestRail" will be created.');
    expect(log.some((m) => m.startsWith('Custom field "Suite" will be created'))).toBe(true);
    expect(log.some((m) => m.startsWith('Custom field "Epic": 2 new value(s)'))).toBe(false);
  });

  it("migrates all cases with structure, fields, scenario and attachments", async () => {
    const summary = await run(false);
    expect(summary.status).toBe("finished");
    expect(summary.counters).toMatchObject({ total: 36, created: 36, failed: 0 });
    expect(state.testCases).toHaveLength(36);

    const tree = state.trees.find((t) => t.name === "TestRail");
    const names = (ids: { id: number }[]) => ids.map(({ id }) => state.customFields.find((f) => f.id === id)?.name);
    expect(names(tree!.fields)).toEqual(["Suite", "Epic", "Feature"]);

    const filters = state.testCases.find((tc) => tc.tags.includes("testrail:1001"))!;
    const cf = (name: string) => filters.cfv.filter((v) => state.customFields.find((f) => f.id === v.customField.id)?.name === name).map((v) => v.name);
    expect(cf("Suite")).toEqual(["Web shop"]);
    expect(cf("Epic")).toEqual(["Storefront"]);
    expect(cf("Feature")).toEqual(["Catalog / Search / Filters"]);
    expect(cf("Platforms")).toEqual(["Web"]);
    expect(filters.members).toEqual([{ name: "admin", role: { id: -1 } }]);
    expect(filters.issues).toEqual([
      { name: "SHOP-100", integrationId: 1 },
      { name: "SHOP-200", integrationId: 1 },
    ]);
    expect(filters.precondition).toContain("| Field | Value |");
    expect(filters.scenario.length).toBeGreaterThanOrEqual(3);
    // Link to a case migrated later was rewritten in the relink pass.
    expect(filters.expectedResult).toMatch(/project\/1\/test-cases\/\d+/);

    const html = state.testCases.find((tc) => tc.tags.includes("testrail:1002"));
    expect(html).toBeDefined();
    const withImage = state.testCases.find((tc) => tc.tags.includes("testrail:1004"))!;
    expect(withImage.precondition).toMatch(/!\[\]\(\/api\/rs\/testcase\/attachment\/\d+\/content\)/);

    const steps = state.testCases.find((tc) => tc.tags.includes("testrail:1002"))!;
    expect(steps.scenario.some((s) => s.data.type === "shared")).toBe(true);
    expect(state.sharedSteps.map((s) => s.name).sort()).toEqual(["Add a product to the cart [2]", "Log in as customer [1]"]);
    expect(state.sharedSteps.find((s) => s.name.endsWith("[2]"))!.attachments).toHaveLength(1);
  });

  it("updates instead of duplicating on rerun", async () => {
    const attachmentsBefore = state.testCases.reduce((sum, tc) => sum + tc.attachments.length, 0);
    const summary = await run(false);
    expect(summary.counters).toMatchObject({ total: 36, updated: 36, created: 0, failed: 0 });
    expect(state.testCases).toHaveLength(36);
    expect(state.sharedSteps).toHaveLength(2);
    expect(state.trees).toHaveLength(1);
    expect(state.testCases.reduce((sum, tc) => sum + tc.attachments.length, 0)).toBe(attachmentsBefore);
  });
});
