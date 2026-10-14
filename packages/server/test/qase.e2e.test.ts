import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createQaseMock, createTestOpsMock, type TestOpsMockState } from "@atm/mocks";
import { mergeSuggestedMappings, newProfile, type Profile, type RunSummary } from "@atm/shared";
import { RunManager } from "../src/engine/runner.js";
import { discoverQase } from "../src/qase/discovery.js";
import { checkQase } from "../src/routes/checks.js";
import { FileStore } from "../src/storage/fileStore.js";
import { RunStore } from "../src/storage/runs.js";
import { discoverTestOps } from "../src/testops/discovery.js";

describe("Qase to Allure TestOps migration", () => {
  const testops = createTestOpsMock();
  // Two cases a page, so every list is read in several pages.
  const qase = createQaseMock({ pageSize: 2 });
  let state: TestOpsMockState;
  let dataDir: string;
  let store: RunStore;
  let runner: RunManager;

  beforeAll(async () => {
    await testops.app.listen({ port: 0, host: "127.0.0.1" });
    await qase.app.listen({ port: 0, host: "127.0.0.1" });
    state = testops.state;
    dataDir = await mkdtemp(join(tmpdir(), "atm-qase-"));
    store = new RunStore(dataDir);
    runner = new RunManager(store, { files: new FileStore(dataDir), retryPauseMs: 10 });
  });

  afterAll(async () => {
    await testops.app.close();
    await qase.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  function profile(id = "qase"): Profile {
    const p = newProfile(id, id, new Date(), "qase");
    p.qase.connection = { ...p.qase.connection, endpoint: `http://127.0.0.1:${(qase.app.server.address() as AddressInfo).port}`, apiToken: "demo-qase-token", rateLimit: "enterprise" };
    p.qase.scope.projectCode = "DEMO";
    p.testops.connection = { endpoint: `http://127.0.0.1:${(testops.app.server.address() as AddressInfo).port}/`, apiToken: "demo-api-token", insecureTls: false };
    p.testops.scope.projectId = 1;
    p.options.migrationTagPrefix = id;
    return p;
  }

  async function mapped(p: Profile): Promise<Profile> {
    const discovery = await discoverQase(p);
    p.fields = mergeSuggestedMappings([], discovery.fields, await discoverTestOps(p));
    p.structure.levels = ["Epic", "Feature", "Story"];
    return p;
  }

  async function run(p: Profile, dryRun = false): Promise<RunSummary> {
    const started = runner.start(p, dryRun);
    while (runner.isActive(p.id, started.id)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return (await store.get(p.id, started.id))!;
  }

  const byTag = (tag: string) => state.testCases.find((tc) => tc.tags.includes(tag))!;
  const cf = (tc: { cfv: { name: string; customField: { id: number } }[] }, name: string) =>
    tc.cfv.filter((v) => state.customFields.find((f) => f.id === v.customField.id)?.name === name).map((v) => v.name);

  it("checks the connection and lists the projects", async () => {
    const result = await checkQase(profile());
    expect(result).toMatchObject({ ok: true, projects: [{ key: "DEMO", name: "Demo shop (DEMO)" }, { key: "EMPTY", name: "Empty project (EMPTY)" }] });
    const wrong = profile();
    wrong.qase.connection.apiToken = "wrong";
    expect(await checkQase(wrong)).toMatchObject({ ok: false, message: expect.stringMatching(/rejected the credentials|API token/i) });
  });

  it("shows the suites, every field with its values and a suggestion", async () => {
    const discovery = await discoverQase(profile());
    expect(discovery.sampledCases).toBe(6);
    expect(discovery.levels.map((level) => level.sectionCount)).toEqual([2, 1, 1]);
    expect(discovery.structure[0]!.examplePaths[0]).toEqual(["Web", "Auth", "Password"]);
    const fields = Object.fromEntries(discovery.fields.map((f) => [f.systemName, f]));
    expect(Object.fromEntries(discovery.fields.map((f) => [f.label, f.suggestedTarget]))).toMatchObject({
      Description: { kind: "description", heading: "" },
      "Pre-conditions": { kind: "precondition", heading: "" },
      "Post-conditions": { kind: "description", heading: "Post-conditions" },
      Steps: { kind: "scenario" },
      Parameters: { kind: "description", heading: "Parameters" },
      Severity: { kind: "customField", name: "Severity" },
      Layer: { kind: "layer" },
      Status: { kind: "status" },
      Tags: { kind: "tag" },
      Author: { kind: "owner" },
      "Linked issues": { kind: "issue", integrationId: null },
      Browser: { kind: "customField", name: "Browser" },
      Platforms: { kind: "customField", name: "Platforms" },
      Spec: { kind: "link" },
      Notes: { kind: "description", heading: "Notes" },
    });
    // Values are shown by their names, with the users' emails for matching.
    expect(fields["qase:severity"]!.options!.map((o) => o.label).sort()).toEqual(["Critical", "Normal"]);
    expect(fields["qase:status"]!.suggestedValues).toMatchObject({ "0": "Active", "2": "Outdated" });
    expect(fields["qase:priority"]!.suggestedValues).toMatchObject({ "0": null });
    expect(fields["qase:author"]!.options).toEqual(expect.arrayContaining([expect.objectContaining({ label: "Jane Doe", email: "jane@example.com", count: 5 })]));
    expect(fields["qase:cf:2"]!.options!.map((o) => o.label).sort()).toEqual(["Android", "Web"]);
    // A field of another project is not offered.
    expect(discovery.fields.some((f) => f.label === "Other project only")).toBe(false);
  });

  it("migrates cases with steps, shared steps, files and fields, and updates them on a rerun", async () => {
    const p = await mapped(profile());
    const summary = await run(p);
    expect(summary.counters).toMatchObject({ total: 6, created: 6, failed: 0 });
    expect(summary.problems?.map((problem) => problem.code) ?? []).not.toContain("attachment-download");

    const reset = byTag("qase:DEMO-1");
    expect(reset.name).toBe("Reset a forgotten password");
    expect(cf(reset, "Epic")).toEqual(["Web"]);
    expect(cf(reset, "Feature")).toEqual(["Auth"]);
    expect(cf(reset, "Story")).toEqual(["Password"]);
    expect(cf(reset, "Severity")).toEqual(["Critical"]);
    expect(cf(reset, "Priority")).toEqual(["High"]);
    expect(cf(reset, "Type")).toEqual(["Security"]);
    expect(cf(reset, "Behavior")).toEqual(["Positive"]);
    expect(cf(reset, "Automation")).toEqual(["To be automated"]);
    expect(cf(reset, "Flaky")).toEqual(["Yes"]);
    expect(cf(reset, "Milestone")).toEqual(["Release 1.0"]);
    expect(cf(reset, "Browser")).toEqual(["Firefox"]);
    expect(cf(reset, "Platforms").sort()).toEqual(["Android", "Web"]);
    expect(cf(reset, "Reviewer")).toEqual(["Sam Tester"]);
    expect(cf(reset, "Needs review")).toEqual(["Yes"]);
    expect(cf(reset, "Build")).toEqual(["build-100"]);
    expect(reset.tags).toEqual(expect.arrayContaining(["smoke", "auth"]));
    expect(reset.precondition).toBe("The user `jane@example.com` exists.");
    expect(reset.description).toContain("Checks the **reset** flow.");
    expect(reset.description).toContain("### Post-conditions\n\nRemove the reset token.");
    expect(reset.description).toContain("- **browser**: chrome, firefox");
    expect(reset.description).toContain("| admin | en |");
    expect(reset.description).toContain("### Notes\n\nReview after the **redesign**.");
    expect(reset.links).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Qase DEMO-1", url: "https://app.qase.io/case/DEMO-1" }), expect.objectContaining({ url: "https://docs.example.com/specs/auth" })]));
    // Files of the case, of a step and the image inside the description.
    expect(reset.attachments.map((a) => a.name).sort()).toEqual(["diagram.png", "screenshot.png", "users.csv"]);
    const diagram = reset.attachments.find((a) => a.name === "diagram.png")!;
    expect(reset.description).toContain(`![diagram](/api/rs/testcase/attachment/${diagram.id}/content)`);
    // The token is not sent to the addresses of the files.
    expect(qase.state.downloads.length).toBeGreaterThan(0);
    expect(qase.state.downloads.every((download) => !download.withToken)).toBe(true);

    // The shared step is one reference, the rest keeps data, expected results and nesting.
    const shared = state.sharedSteps.find((s) => s.name === "Log in as a customer [sh1]")!;
    expect(shared.scenario.map((s) => s.data.body)).toEqual(["Open the login page", "Enter the credentials"]);
    expect(reset.scenario[0]!.data).toMatchObject({ type: "shared", sharedStepId: shared.id });
    expect(reset.scenario.slice(1).map((s) => s.data.body)).toEqual(["Click **Forgot password?**", "Submit the form", "Open the mailbox"]);
    expect(JSON.stringify(reset.scenario[1])).toContain("The reset form is shown");
    expect(JSON.stringify(reset.scenario[1])).toContain("Email: jane@example.com");
    expect(JSON.stringify(reset.scenario[2])).toContain("No validation error");

    const gherkin = byTag("qase:DEMO-2");
    expect(gherkin.scenario.map((s) => s.data.body).slice(0, 3)).toEqual(["Given I am on the sign-up page", 'When I enter the password "<password>"', 'Then I see "<message>"']);
    expect(cf(gherkin, "Automation")).toEqual(["Automated"]);
    expect(cf(gherkin, "Priority")).toEqual([]);

    const api = byTag("qase:DEMO-5");
    expect(cf(api, "Epic")).toEqual(["API"]);
    expect(byTag("qase:DEMO-6").scenario[0]!.data).toMatchObject({ type: "shared", sharedStepId: shared.id });
    expect(cf(byTag("qase:DEMO-6"), "Epic")).toEqual([]);

    const again = await run(p);
    expect(again.counters).toMatchObject({ created: 0, updated: 6, failed: 0 });
    expect(state.testCases.filter((tc) => tc.tags.some((t) => t.startsWith("qase:")))).toHaveLength(6);
    expect(state.sharedSteps).toHaveLength(1);
    expect(byTag("qase:DEMO-1").attachments).toHaveLength(3);
  });

  it("narrows the migration to suites or to single cases", async () => {
    const bySuite = await mapped(profile("suite"));
    bySuite.qase.scope.suiteIds = [2];
    expect((await run(bySuite, true)).counters).toMatchObject({ total: 3, failed: 0 });

    const byCase = await mapped(profile("single"));
    byCase.qase.scope.caseIds = [5, 404];
    const summary = await run(byCase);
    expect(summary.counters).toMatchObject({ total: 1, created: 1 });
    expect(byTag("single:DEMO-5").name).toBe("Orders API returns the list");
  });

  it("copies the steps of shared steps into the cases when shared steps are off", async () => {
    const p = await mapped(profile("inline"));
    p.options.migrateSharedSteps = false;
    p.qase.scope.caseIds = [6];
    await run(p);
    expect(byTag("inline:DEMO-6").scenario.map((s) => s.data.body)).toEqual(["Open the login page", "Enter the credentials"]);
  });
});
