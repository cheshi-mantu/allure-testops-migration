import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestOpsMock, createZephyrMock, type TestOpsMockState } from "@atm/mocks";
import { mergeSuggestedMappings, newProfile, type Profile, type RunSummary } from "@atm/shared";
import { RunManager } from "../src/engine/runner.js";
import { checkZephyr } from "../src/routes/checks.js";
import { FileStore } from "../src/storage/fileStore.js";
import { RunStore } from "../src/storage/runs.js";
import { discoverTestOps } from "../src/testops/discovery.js";
import { zephyrBase } from "../src/zephyr/client.js";
import { discoverZephyr, folderChoices, loadZephyrContext } from "../src/zephyr/discovery.js";

describe("Zephyr to Allure TestOps migration", () => {
  const testops = createTestOpsMock();
  // Two items a page, and one 429 per list of test cases: paging and waiting when asked to.
  const zephyr = createZephyrMock({ pageSize: 2, rateLimitOnce: true });
  let state: TestOpsMockState;
  let dataDir: string;
  let store: RunStore;
  let runner: RunManager;

  beforeAll(async () => {
    await testops.app.listen({ port: 0, host: "127.0.0.1" });
    await zephyr.app.listen({ port: 0, host: "127.0.0.1" });
    state = testops.state;
    dataDir = await mkdtemp(join(tmpdir(), "atm-zephyr-"));
    store = new RunStore(dataDir);
    runner = new RunManager(store, { files: new FileStore(dataDir), retryPauseMs: 10 });
  });

  afterAll(async () => {
    await testops.app.close();
    await zephyr.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const site = () => `http://127.0.0.1:${(zephyr.app.server.address() as AddressInfo).port}`;

  function profile(id = "zephyr"): Profile {
    const p = newProfile(id, id, new Date(), "zephyr");
    p.zephyr.connection = { ...p.zephyr.connection, endpoint: `${site()}/v2`, apiToken: "demo-zephyr-token", jiraUrl: site(), jiraEmail: "demo@example.com", jiraApiToken: "demo-jira-token", requestsPerMinute: 6000 };
    p.zephyr.scope.projectKey = "CALC";
    p.testops.connection = { endpoint: `http://127.0.0.1:${(testops.app.server.address() as AddressInfo).port}/`, apiToken: "demo-api-token", insecureTls: false };
    p.testops.scope.projectId = 1;
    p.options.migrationTagPrefix = id;
    return p;
  }

  async function mapped(p: Profile): Promise<Profile> {
    const discovery = await discoverZephyr(p);
    p.fields = mergeSuggestedMappings([], discovery.fields, await discoverTestOps(p));
    p.structure.levels = ["Epic", "Feature"];
    return p;
  }

  async function run(p: Profile, dryRun = false): Promise<RunSummary> {
    const started = runner.start(p, dryRun);
    while (runner.isActive(p.id, started.id)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return (await store.get(p.id, started.id))!;
  }

  const byTag = (tag: string) => state.testCases.find((tc) => tc.tags.includes(tag.toLowerCase()))!;
  const cf = (tc: { cfv: { name: string; customField: { id: number } }[] }, name: string) =>
    tc.cfv.filter((v) => state.customFields.find((f) => f.id === v.customField.id)?.name === name).map((v) => v.name);

  it("reads the API address in any form", () => {
    expect(zephyrBase("https://api.zephyrscale.smartbear.com/v2")).toBe("https://api.zephyrscale.smartbear.com/v2/");
    expect(zephyrBase("https://eu.api.zephyrscale.smartbear.com/")).toBe("https://eu.api.zephyrscale.smartbear.com/v2/");
    expect(zephyrBase("")).toBe("https://api.zephyrscale.smartbear.com/v2/");
  });

  it("checks Jira and Zephyr and lists the projects Zephyr is on for", async () => {
    const result = await checkZephyr(profile());
    expect(result).toMatchObject({ ok: true, projects: [{ key: "CALC", name: "Calculator (CALC)" }] });
    expect(result.details).toContain("Zephyr projects: CALC");
    expect(result.details).not.toMatch(/demo-zephyr-token|demo-jira-token/);
    const wrong = profile();
    wrong.zephyr.connection.apiToken = "wrong";
    expect(await checkZephyr(wrong)).toMatchObject({ ok: false, message: expect.stringMatching(/Jira works .* Zephyr rejected the API access token/) });
    const quiet = profile();
    quiet.zephyr.detailedLog = false;
    expect((await checkZephyr(quiet)).details).toBeUndefined();
  });

  it("shows the folders and every field with its values and a suggestion", async () => {
    const discovery = await discoverZephyr(profile());
    expect(discovery.sampledCases).toBe(5);
    expect(discovery.levels.map((level) => level.sectionCount)).toEqual([2, 2]);
    expect(discovery.structure[0]!.examplePaths).toEqual(expect.arrayContaining([["Web", "Login"], ["Web", "Checkout"]]));
    const fields = Object.fromEntries(discovery.fields.map((f) => [f.systemName, f]));
    expect(Object.fromEntries(discovery.fields.map((f) => [f.systemName, f.suggestedTarget]))).toMatchObject({
      "zephyr:steps": { kind: "scenario" },
      "zephyr:script": { kind: "scenario" },
      "zephyr:objective": { kind: "description", heading: "" },
      "zephyr:precondition": { kind: "precondition", heading: "" },
      "zephyr:status": { kind: "status" },
      "zephyr:priority": { kind: "customField", name: "Priority" },
      "zephyr:labels": { kind: "tag" },
      "zephyr:component": { kind: "customField", name: "Component" },
      "zephyr:owner": { kind: "owner" },
      "zephyr:webLinks": { kind: "link" },
      "zephyr:issues:COVERAGE": { kind: "issue", integrationId: null },
      "zephyr:issues:RELATED": { kind: "link" },
      // Kinds of custom fields come from their values.
      "zephyr:cf:Automation": { kind: "customField", name: "Automation" },
      "zephyr:cf:Notes": { kind: "description", heading: "Notes" },
      "zephyr:cf:Browsers": { kind: "customField", name: "Browsers" },
      "zephyr:cf:Reviewer": { kind: "role", role: "" },
      "zephyr:cf:Release date": { kind: "ignore" },
      "zephyr:cf:Story points": { kind: "customField", name: "Story points" },
    });
    expect(fields["zephyr:cf:Reviewed"]!.kind).toBe("checkbox");
    expect(fields["zephyr:status"]!.suggestedValues).toEqual({ Draft: "Draft", Approved: "Active", Deprecated: "Outdated" });
    expect(fields["zephyr:owner"]!.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "5b10a2844c20165700ede21g", label: "Jane Doe", email: "jane@example.com" }),
        expect.objectContaining({ label: "Sam Tester" }),
      ]),
    );
    expect(fields["zephyr:priority"]!.options!.map((o) => o.label).sort()).toEqual(["High", "Low", "Normal"]);
    expect(fields["zephyr:component"]!.options!.map((o) => o.label)).toEqual(["Frontend"]);
    const context = await loadZephyrContext(profile());
    expect(folderChoices(context.folders).map((folder) => folder.name)).toEqual(["Mobile", "Web", "Web / Checkout", "Web / Login"]);
  });

  it("migrates test cases with steps, calls, scripts, files and fields, and updates them on a rerun", async () => {
    const p = await mapped(profile());
    p.fields.find((m) => m.source === "zephyr:issues:COVERAGE")!.target = { kind: "issue", integrationId: 1 };
    p.fields.find((m) => m.source === "zephyr:cf:Reviewer")!.target = { kind: "role", role: "Reviewer" };
    p.fields.find((m) => m.source === "zephyr:cf:Reviewer")!.values = { [ "557058:f58131cb-b67d-43c7-b30d-6b58d40bd077" ]: "sam" };
    const summary = await run(p);
    expect(summary.counters).toMatchObject({ total: 5, created: 5, failed: 0 });
    expect(summary.problems?.map((problem) => problem.code) ?? []).not.toContain("attachment-download");

    const login = byTag("zephyr:calc-t1");
    expect(login.name).toBe("Login with a valid password");
    expect(cf(login, "Epic")).toEqual(["Web"]);
    expect(cf(login, "Feature")).toEqual(["Login"]);
    expect(cf(login, "Priority")).toEqual(["High"]);
    expect(cf(login, "Component")).toEqual(["Frontend"]);
    expect(cf(login, "Automation")).toEqual(["Automated"]);
    expect(cf(login, "Reviewed")).toEqual(["Yes"]);
    expect(cf(login, "Browsers").sort()).toEqual(["Chrome", "Firefox"]);
    expect(cf(login, "Story points")).toEqual(["3"]);
    expect(login.tags).toEqual(expect.arrayContaining(["smoke", "login"]));
    expect(login.statusId).toBe(2);
    expect(login.members).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "jane", role: expect.objectContaining({ id: -1 }) }), expect.objectContaining({ name: "sam", role: { id: 2 } })]),
    );
    expect(login.description).toContain("Check that a **registered** user can log in.");
    expect(login.description).toContain("### Notes");
    const diagram = login.attachments.find((a) => a.name === "diagram.png")!;
    expect(login.description).toContain(`/api/rs/testcase/attachment/${diagram.id}/content`);
    expect(login.precondition).toBe("User **jane** exists");
    expect(login.attachments.map((a) => a.name).sort()).toEqual(["diagram.png", "form.png", "users.csv"]);
    expect(login.links).toEqual([expect.objectContaining({ name: "Login spec", url: "https://example.com/spec" })]);
    expect(login.issues).toEqual([expect.objectContaining({ name: "CALC-1" })]);
    expect(login.scenario.map((s) => s.data.body)).toEqual(["Open the *login* page", "Enter `jane` and the password"]);
    expect(JSON.stringify(login.scenario[0])).toContain("url: /login\\n\\nBrowser: Chrome");
    expect(JSON.stringify(login.scenario[0])).toContain("The form is shown");
    expect(JSON.stringify(login.scenario[0])).toContain(`"attachmentId":${login.attachments.find((a) => a.name === "form.png")!.id}`);

    // A call without values is a shared step; a call with values gets the steps with the values in.
    const checkout = byTag("zephyr:calc-t2");
    const shared = state.sharedSteps.find((s) => s.name === "CALC-T1 Login with a valid password")!;
    expect(shared.scenario.map((s) => s.data.body)).toEqual(["Open the *login* page", "Enter `jane` and the password"]);
    expect(checkout.scenario[0]!.data).toMatchObject({ type: "shared", sharedStepId: shared.id });
    expect(checkout.scenario[1]!.data.body).toBe("Call CALC-T4 Pay with a card");
    expect(JSON.stringify(checkout.scenario[1])).toContain("Enter the Visa card");
    expect(JSON.stringify(checkout.scenario[1])).toContain("card: Visa");
    expect(checkout.scenario[2]!.data.body).toBe("Confirm the order");
    expect(checkout.issues).toEqual([expect.objectContaining({ name: "CALC-2" })]);
    expect(checkout.links).toEqual([expect.objectContaining({ name: "related CALC-1", url: `${site()}/browse/CALC-1` })]);
    expect(checkout.statusId).toBe(1);
    // Jira hides the email of Sam: the name does not match an Allure TestOps user, and the run says so.
    expect(checkout.members).toEqual([]);
    expect(summary.problems?.find((problem) => problem.code === "user-missing")?.title).toContain("Sam Tester");

    const bdd = byTag("zephyr:calc-t3");
    expect(bdd.scenario.map((s) => s.data.body)).toEqual(["Feature: Checkout", "Scenario: Pay", "Given a cart", "When I pay", "Then the order is placed"]);
    expect(cf(bdd, "Epic")).toEqual(["Mobile"]);

    const plain = byTag("zephyr:calc-t5");
    expect(plain.scenario.map((s) => s.data.body)).toEqual(["Open the app", "Check the title"]);
    expect(plain.statusId).toBe(3);
    expect(plain.links).toEqual([]);

    const again = await run(p);
    expect(again.counters).toMatchObject({ created: 0, updated: 5, failed: 0 });
    expect(state.testCases.filter((tc) => tc.tags.some((t) => t.startsWith("zephyr:")))).toHaveLength(5);
    expect(state.sharedSteps.filter((s) => s.name.startsWith("CALC-T1 "))).toHaveLength(1);
    expect(byTag("zephyr:calc-t1").attachments).toHaveLength(3);
  });

  it("writes a detailed log without tokens or the text of the test cases", async () => {
    const p = await mapped(profile("trace"));
    p.zephyr.scope.testCaseKeys = ["CALC-T1", "CALC-T5"];
    const summary = await run(p, true);
    const log = await store.log(p.id, summary.id, 0, Number.MAX_SAFE_INTEGER);
    const text = log.filter((entry) => entry.level === "debug").map((entry) => entry.message).join("\n");
    expect(text).toContain("Zephyr: Detailed log is on.");
    // The fields of the first test case once, by kind of value.
    expect(text).toMatch(/GET testcases\?projectKey=CALC&startAt=0&maxResults=100: ok in \d+ ms, 2 item\(s\), total 5, isLast false, maxResults lowered to 2, first test case \{id:101, key:"CALC-T1", name:text 27, /);
    expect(text).toContain("customFields{Automation:text 9, Reviewed:boolean, Notes:html 27, Browsers[2]text 6, Reviewer:account id, Release date:date, Story points:number}");
    expect(text).toMatch(/GET testcases\/CALC-T1\/teststeps\?startAt=0&maxResults=100: ok in \d+ ms, 2 item\(s\), total 2, isLast true, maxResults lowered to 2/);
    expect(text).toMatch(/CALC-T1: script "teststeps"; 2 step\(s\);.*\[diagram.png, users.csv\]; step files step 1001: form.png; pictures in text: objective http:\/\/127\.0\.0\.1:\d+\/v2\/testcases\/…\/attachments\/301 \(a file of the test case\)/);
    expect(text).toMatch(/CALC-T5: script "testscript"; 0 step\(s\); plain script of 1 line\(s\)/);
    expect(text).toContain("Jira issues linked to test cases: 2 asked, 1 found.");
    expect(log.some((entry) => entry.level === "warn" || entry.message.includes("99999"))).toBe(true);
    // Nothing secret and nothing written in the test cases.
    expect(text).not.toMatch(/demo-zephyr-token|demo-jira-token|demo@example\.com|registered|Line one|Login with a valid/);
  });

  it("narrows the migration to folders or to single test cases", async () => {
    const byFolder = await mapped(profile("folder"));
    byFolder.zephyr.scope.folderIds = [1];
    expect((await run(byFolder, true)).counters).toMatchObject({ total: 3, failed: 0 });

    const byKey = await mapped(profile("single"));
    byKey.zephyr.scope.testCaseKeys = ["calc-t3", "CALC-T404", "bogus"];
    const summary = await run(byKey);
    expect(summary.counters).toMatchObject({ total: 1, created: 1 });
    const log = await store.log(byKey.id, summary.id, 0, Number.MAX_SAFE_INTEGER);
    expect(log.map((entry) => entry.message).join("\n")).toMatch(/CALC-T404 is not a Zephyr test case the API token can read[\s\S]*"bogus" is not a Zephyr test case key/);
  });

  it("copies the steps of called test cases when shared steps are off, and skips step files when asked", async () => {
    const p = await mapped(profile("inline"));
    p.options.migrateSharedSteps = false;
    p.zephyr.scope.testCaseKeys = ["CALC-T2"];
    p.zephyr.scope.stepFiles = false;
    const before = zephyr.state.requests.filter((r) => r.url.includes("/teststeps/") && r.url.endsWith("/attachments")).length;
    await run(p);
    const checkout = byTag("inline:calc-t2");
    expect(checkout.scenario[0]!.data.body).toBe("Call CALC-T1 Login with a valid password");
    expect(JSON.stringify(checkout.scenario[0])).toContain("Enter `jane` and the password");
    expect(zephyr.state.requests.filter((r) => r.url.includes("/teststeps/") && r.url.endsWith("/attachments")).length).toBe(before);
  });
});
