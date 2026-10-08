import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestOpsMock, createXrayMock, type TestOpsMockState } from "@atm/mocks";
import { mergeSuggestedMappings, newProfile, type Profile, type RunSummary } from "@atm/shared";
import { RunManager } from "../src/engine/runner.js";
import { FileStore } from "../src/storage/fileStore.js";
import { RunStore } from "../src/storage/runs.js";
import { discoverTestOps } from "../src/testops/discovery.js";
import { checkXray } from "../src/routes/checks.js";
import { discoverXray } from "../src/xray/discovery.js";

describe("Xray Cloud to Allure TestOps migration", () => {
  const testops = createTestOpsMock();
  const xray = createXrayMock();
  let state: TestOpsMockState;
  let dataDir: string;
  let store: RunStore;
  let runner: RunManager;

  beforeAll(async () => {
    await testops.app.listen({ port: 0, host: "127.0.0.1" });
    await xray.app.listen({ port: 0, host: "127.0.0.1" });
    state = testops.state;
    dataDir = await mkdtemp(join(tmpdir(), "atm-xray-"));
    store = new RunStore(dataDir);
    runner = new RunManager(store, { files: new FileStore(dataDir), retryPauseMs: 10 });
  });

  afterAll(async () => {
    await testops.app.close();
    await xray.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  function profile(): Profile {
    const xrayUrl = `http://127.0.0.1:${(xray.app.server.address() as AddressInfo).port}`;
    const p = newProfile("xray", "xray", new Date(), "xray");
    p.xray.connection = {
      endpoint: xrayUrl,
      clientId: "demo-client-id",
      clientSecret: "demo-client-secret",
      jiraUrl: `${xrayUrl}/`,
      jiraEmail: "demo@example.com",
      jiraApiToken: "demo-jira-token",
    };
    p.xray.scope.projectKey = "CALC";
    p.testops.connection = { endpoint: `http://127.0.0.1:${(testops.app.server.address() as AddressInfo).port}/`, apiToken: "demo-api-token", insecureTls: false };
    p.testops.scope.projectId = 1;
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

  it("checks the connection and lists Jira projects", async () => {
    const result = await checkXray(profile());
    expect(result.ok).toBe(true);
    expect(result.projects).toEqual([{ id: 10000, key: "CALC", name: "Calculator (CALC)" }]);

    const wrong = profile();
    wrong.xray.connection.clientSecret = "wrong";
    expect((await checkXray(wrong)).message).toMatch(/Xray rejected the API key/);
  });

  it("shows every attribute of the tests for mapping", async () => {
    const discovery = await discoverXray(profile());
    expect(discovery.sampledCases).toBe(5);
    expect(discovery.maxDepth).toBe(3);
    const fields = Object.fromEntries(discovery.fields.map((f) => [f.systemName, f]));
    // Xray attributes, Jira system and custom fields, link directions and comments.
    for (const name of [
      "xray:testType",
      "xray:steps",
      "xray:definition",
      "xray:preconditions",
      "xray:testSets",
      "xray:testPlans",
      "xray:folder",
      "jira:comment",
      "jira:description",
      "jira:labels",
      "jira:priority",
      "jira:components",
      "jira:fixVersions",
      "jira:assignee",
      "jira:customfield_10100",
      "jira:customfield_10101",
      "jira:customfield_10103",
      "jira:link:tests",
      "jira:link:is blocked by",
    ]) {
      expect(fields[name], name).toBeDefined();
    }
    // Rank and handled fields are not offered.
    expect(fields["jira:customfield_10102"]).toBeUndefined();
    expect(fields["jira:summary"]).toBeUndefined();
    expect(fields["xray:testType"]!.options!.map((o) => o.label).sort()).toEqual(["Cucumber", "Generic", "Manual"]);
    expect(fields["jira:assignee"]!.options).toEqual(expect.arrayContaining([{ id: "acc-jane", label: "Jane Doe", count: 1, email: "jane@example.com" }]));
    expect(fields["jira:customfield_10100"]!.suggestedTarget).toEqual({ kind: "customField", name: "Automation status" });
    expect(fields["jira:link:tests"]!.suggestedTarget).toEqual({ kind: "issue", integrationId: null });
    expect(discovery.sampleCaseIds[0]).toEqual({ id: "CALC-1", name: "Login with valid credentials" });
  });

  it("migrates tests of every type with their Jira and Xray attributes, then updates them", async () => {
    const p = profile();
    const discovery = await discoverXray(p);
    const target = await discoverTestOps(p);
    p.fields = mergeSuggestedMappings([], discovery.fields, target);
    p.structure.levels = ["Area", "Feature", "Story"];

    const dry = await run(p, true);
    expect(dry.status).toBe("finished");
    expect(dry.counters).toMatchObject({ total: 5, failed: 0 });

    const summary = await run(p);
    expect(summary.status).toBe("finished");
    expect(summary.counters).toMatchObject({ total: 5, created: 5, failed: 0 });

    const login = byTag("xray:CALC-1");
    expect(login.name).toBe("Login with valid credentials");
    expect(login.description).toMatch(/Checks the \*\*login\*\* form\./);
    expect(login.description).toMatch(/!\[login-form\.png\]\(\/api\/rs\/testcase\/attachment\/\d+\/content\)/);
    expect(login.description).toMatch(/### Notes\n\nRun on \*staging\* first\./);
    expect(login.precondition).toBe("**User** jane exists");
    expect(login.tags).toEqual(expect.arrayContaining(["smoke", "login"]));
    expect(cf(login, "Area")).toEqual(["Web"]);
    expect(cf(login, "Feature")).toEqual(["Auth"]);
    expect(cf(login, "Story")).toEqual(["Login"]);
    expect(cf(login, "Test type")).toEqual(["Manual"]);
    expect(cf(login, "Priority")).toEqual(["High"]);
    expect(cf(login, "Components")).toEqual(["Auth"]);
    expect(cf(login, "Automation status")).toEqual(["Manual"]);
    expect(cf(login, "Test set")).toEqual(["CALC-20 Smoke"]);
    expect(cf(login, "Test plan")).toEqual(["CALC-30 Release 2.0"]);
    // Owner from the Jira assignee, found in Allure TestOps by email.
    expect(login.members).toEqual([{ name: "jane", role: { id: -1 } }]);
    // The requirement it tests, through the only issue tracker integration.
    expect(login.issues).toEqual([{ name: "CALC-100", integrationId: 1 }]);
    expect(login.links).toEqual(expect.arrayContaining([expect.objectContaining({ url: expect.stringMatching(/\/browse\/CALC-1$/) }), expect.objectContaining({ url: "https://wiki.example.com/login" })]));
    expect(state.comments.filter((c) => c.testCaseId === login.id).map((c) => c.body)).toEqual(["Reviewed, looks good."]);
    expect(login.attachments.map((a) => a.name).sort()).toEqual(["accounts.csv", "creds.png", "login-form.png", "step-2-data-table-1.csv"]);
    const steps = login.scenario.map((s) => s.data);
    // Step text is plain in Allure TestOps: no Markdown markers.
    expect(steps.map((s) => s.body)).toEqual(["Open the login page", "Enter valid credentials", "Press Log in"]);
    expect(JSON.stringify(steps[0])).toMatch(/URL: \/login/);
    expect(JSON.stringify(steps[1])).toMatch(/Data set: users-1/);
    expect(JSON.stringify(steps[2])).toMatch(/The dashboard opens/);

    const logout = byTag("xray:CALC-2");
    expect(logout.description).toMatch(/```gherkin\nScenario: Log out\n  Given I am logged in/);
    expect(cf(logout, "Test type")).toEqual(["Cucumber"]);

    const api = byTag("xray:CALC-3");
    expect(api.description).toBe("com.example.api.LoginContractTest");
    expect(cf(api, "Area")).toEqual(["API"]);

    // A step calling another test becomes a shared step.
    const checkout = byTag("xray:CALC-4");
    const shared = state.sharedSteps.find((s) => s.name === "CALC-5 Open the app [10005]")!;
    expect(shared.scenario.map((s) => s.data.body)).toEqual(["Start the app", "Accept cookies"]);
    expect(checkout.scenario.map((s) => s.data)).toEqual([expect.objectContaining({ sharedStepId: shared.id }), expect.objectContaining({ body: "Pay with a card" })]);

    // Rerun: same cases, updated, nothing duplicated.
    const again = await run(p);
    expect(again.counters).toMatchObject({ created: 0, updated: 5, failed: 0 });
    expect(state.testCases.filter((tc) => tc.tags.some((t) => t.startsWith("xray:")))).toHaveLength(5);
    expect(state.sharedSteps.filter((s) => s.name.startsWith("CALC-5"))).toHaveLength(1);
  });

  it("migrates only the tests matching the JQL filter or listed keys", async () => {
    const p = profile();
    p.options.migrationTagPrefix = "xray-filtered";
    p.fields = mergeSuggestedMappings([], (await discoverXray(p)).fields, await discoverTestOps(p));
    p.xray.scope.jql = "labels = smoke";
    expect((await run(p, true)).counters.total).toBe(1);
    p.xray.scope.jql = "";
    p.xray.scope.issueKeys = ["CALC-2", "CALC-3"];
    expect((await run(p, true)).counters.total).toBe(2);
  });
});
