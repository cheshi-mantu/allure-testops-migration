import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestOpsMock, type TestOpsMockState } from "@atm/mocks";
import { mergeSuggestedMappings, newProfile, type Profile, type RunSummary } from "@atm/shared";
import { discoverCsv } from "../src/csv/discovery.js";
import { RunManager } from "../src/engine/runner.js";
import { FileStore } from "../src/storage/fileStore.js";
import { RunStore } from "../src/storage/runs.js";
import { discoverTestOps } from "../src/testops/discovery.js";

/** The layout from the generic CSV documentation: one row per case, classic indented scenario. */
const SINGLE_ROW = `allure_id,name,description,precondition,scenario,expected_result,folder,tags,created_by,reviewers,useful_links,jira
,Login works,Checks the login,"database must exist","Start login process
\tLaunch application
\t\tNavigate to login page
\tEnter credentials
Validate dashboard
\tCheck welcome message",we expect all is okay,Web / Auth / Login,"regular, critical",jane,"sam, ghost",https://intranet.example.com,AE-5
,Logout works,,,"Click avatar
Select ""Log out""",,Web / Auth,regular,sam,,,
`;

/** One step per row: case fields on the first row, following rows continue the case. */
const MULTI_ROW = `ID;Title;Section;Step;Expected Result;Priority
T-1;Checkout;Shop > Cart > Checkout;Open the cart;Cart is shown;High
;;;Click Pay;Payment form is shown;
;;;Confirm;Order is placed;
T-2;Search;Shop > Catalog;Type a query;Results appear;Low
`;

describe("CSV to Allure TestOps migration", () => {
  const testops = createTestOpsMock();
  let state: TestOpsMockState;
  let dataDir: string;
  let files: FileStore;
  let store: RunStore;
  let runner: RunManager;

  beforeAll(async () => {
    await testops.app.listen({ port: 0, host: "127.0.0.1" });
    state = testops.state;
    dataDir = await mkdtemp(join(tmpdir(), "atm-csv-"));
    files = new FileStore(dataDir);
    store = new RunStore(dataDir);
    runner = new RunManager(store, { files });
  });

  afterAll(async () => {
    await testops.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function profileFor(csv: string, id: string): Promise<Profile> {
    const file = await files.save(`${id}.csv`, Buffer.from(csv));
    const profile = newProfile(id, id, new Date(), "csv");
    profile.csv.fileId = file.id;
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

  it("migrates a one-row-per-case file with nested steps, roles and a section path", async () => {
    const profile = await profileFor(SINGLE_ROW, "single");
    const discovery = await discoverCsv(profile, files);
    expect(discovery.csv).toMatchObject({ delimiter: ",", caseCount: 2, multiRow: false, stepFormat: "indented" });
    expect(discovery.csv?.pathCandidates[0]).toEqual({ column: "folder", separator: " / " });
    const suggested = Object.fromEntries(discovery.fields.map((f) => [f.systemName, f.suggestedTarget?.kind]));
    expect(suggested).toMatchObject({
      allure_id: "ignore",
      name: "name",
      description: "description",
      precondition: "precondition",
      scenario: "scenario",
      expected_result: "scenarioExpected",
      tags: "tag",
      created_by: "owner",
      reviewers: "role",
      jira: "issue",
    });

    const target = await discoverTestOps(profile);
    profile.fields = mergeSuggestedMappings([], discovery.fields, target).map((m) =>
      m.source === "expected_result" ? { ...m, target: { kind: "expectedResult", heading: "" } } : m,
    );
    profile.csv.pathColumn = "folder";
    profile.structure.levels = ["Epic", "Feature", "Story"];

    const summary = await run(profile);
    expect(summary.counters).toMatchObject({ total: 2, created: 2, failed: 0 });

    const first = state.testCases.find((tc) => tc.name === "Login works")!;
    expect(first.description).toBe("Checks the login");
    expect(first.precondition).toBe("database must exist");
    expect(first.expectedResult).toBe("we expect all is okay");
    expect(first.tags).toEqual(expect.arrayContaining(["regular", "critical"]));
    expect(cf(first, "Epic")).toEqual(["Web"]);
    expect(cf(first, "Feature")).toEqual(["Auth"]);
    expect(cf(first, "Story")).toEqual(["Login"]);
    // "ghost" is not a user: the other members stay.
    expect(first.members).toEqual([
      { name: "jane", role: { id: -1 } },
      { name: "sam", role: { id: 2 } },
    ]);
    expect(first.issues).toEqual([{ name: "AE-5", integrationId: 1 }]);
    expect(first.scenario.map((s) => s.data.body)).toEqual(["Start login process", "Validate dashboard"]);
    const nested = first.scenario[0]!.data.steps as { body: string; steps?: { body: string }[] }[];
    expect(nested.map((s) => s.body)).toEqual(["Launch application", "Enter credentials"]);
    expect(nested[0]!.steps?.[0]?.body).toBe("Navigate to login page");

    const second = state.testCases.find((tc) => tc.name === "Logout works")!;
    expect(second.scenario.map((s) => s.data.body)).toEqual(["Click avatar", 'Select "Log out"']);
    expect(cf(second, "Story")).toEqual([]);

    // Rerun: same cases, updated.
    const again = await run(profile);
    expect(again.counters).toMatchObject({ created: 0, updated: 2, failed: 0 });
    expect(state.testCases.filter((tc) => tc.tags.some((t) => t.startsWith("csv:")))).toHaveLength(2);
  });

  it("migrates a file where each case spans several rows", async () => {
    const profile = await profileFor(MULTI_ROW, "multi");
    const discovery = await discoverCsv(profile, files);
    expect(discovery.csv).toMatchObject({ delimiter: ";", rowCount: 4, caseCount: 2, multiRow: true });
    const suggested = Object.fromEntries(discovery.fields.map((f) => [f.systemName, f.suggestedTarget?.kind]));
    expect(suggested).toMatchObject({ ID: "sourceId", Title: "name", Step: "scenario", "Expected Result": "scenarioExpected", Priority: "customField" });
    expect(discovery.fields.find((f) => f.systemName === "Priority")?.options?.map((o) => o.label)).toEqual(["High", "Low"]);

    profile.fields = mergeSuggestedMappings([], discovery.fields, null).map((m) => (m.source === "Priority" ? { ...m, values: { High: "Critical" } } : m));
    profile.csv.pathColumn = "Section";
    profile.structure.levels = ["Epic", "Feature"];

    const dry = await run(profile, true);
    expect(dry.counters).toMatchObject({ total: 2, failed: 0 });
    expect(state.testCases.filter((tc) => tc.tags.includes("csv:T-1"))).toHaveLength(0);

    const summary = await run(profile);
    expect(summary.counters).toMatchObject({ total: 2, created: 2, failed: 0 });
    const checkout = byTag("csv:T-1");
    expect(checkout.scenario.map((s) => [s.data.body, (s.data.expectedResultSteps as { body: string }[])[0]!.body])).toEqual([
      ["Open the cart", "Cart is shown"],
      ["Click Pay", "Payment form is shown"],
      ["Confirm", "Order is placed"],
    ]);
    expect(cf(checkout, "Priority")).toEqual(["Critical"]);
    expect(cf(checkout, "Feature")).toEqual(["Cart / Checkout"]);
    expect(cf(byTag("csv:T-2"), "Priority")).toEqual(["Low"]);
  });

  it("updates an existing case given by its Allure ID", async () => {
    const existing = state.testCases.find((tc) => tc.name === "Search")!;
    const csv = `allure_id,name\n${existing.id},Search renamed\n`;
    const profile = await profileFor(csv, "byid");
    const discovery = await discoverCsv(profile, files);
    profile.fields = mergeSuggestedMappings([], discovery.fields, null).map((m) => (m.source === "allure_id" ? { ...m, target: { kind: "allureId" } } : m));
    const summary = await run(profile);
    expect(summary.counters).toMatchObject({ updated: 1, created: 0, failed: 0 });
    expect(existing.name).toBe("Search renamed");
  });
});
