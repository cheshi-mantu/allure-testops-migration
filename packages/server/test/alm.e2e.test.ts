import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAlmMock, createTestOpsMock, type TestOpsMockState } from "@atm/mocks";
import { mergeSuggestedMappings, newProfile, type Profile, type RunSummary } from "@atm/shared";
import { almBase, almQuery } from "../src/alm/client.js";
import { discoverAlm, folderChoices, loadAlmContext } from "../src/alm/discovery.js";
import { RunManager } from "../src/engine/runner.js";
import { checkAlm } from "../src/routes/checks.js";
import { FileStore } from "../src/storage/fileStore.js";
import { RunStore } from "../src/storage/runs.js";
import { discoverTestOps } from "../src/testops/discovery.js";

describe("ALM to Allure TestOps migration", () => {
  const testops = createTestOpsMock();
  // Two entities a page, and a session that ends every 15 requests: paging and logging in again.
  const alm = createAlmMock({ pageSize: 2, sessionRequests: 15 });
  let state: TestOpsMockState;
  let dataDir: string;
  let store: RunStore;
  let runner: RunManager;

  beforeAll(async () => {
    await testops.app.listen({ port: 0, host: "127.0.0.1" });
    await alm.app.listen({ port: 0, host: "127.0.0.1" });
    state = testops.state;
    dataDir = await mkdtemp(join(tmpdir(), "atm-alm-"));
    store = new RunStore(dataDir);
    runner = new RunManager(store, { files: new FileStore(dataDir), retryPauseMs: 10 });
  });

  afterAll(async () => {
    await testops.app.close();
    await alm.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  function profile(id = "alm"): Profile {
    const p = newProfile(id, id, new Date(), "alm");
    p.alm.connection = { ...p.alm.connection, endpoint: `http://127.0.0.1:${(alm.app.server.address() as AddressInfo).port}/qcbin/`, username: "demo", password: "demo-password" };
    p.alm.scope.domain = "DEFAULT";
    p.alm.scope.project = "Banking";
    p.testops.connection = { endpoint: `http://127.0.0.1:${(testops.app.server.address() as AddressInfo).port}/`, apiToken: "demo-api-token", insecureTls: false };
    p.testops.scope.projectId = 1;
    p.options.migrationTagPrefix = id;
    return p;
  }

  async function mapped(p: Profile): Promise<Profile> {
    const discovery = await discoverAlm(p);
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

  const byTag = (tag: string) => state.testCases.find((tc) => tc.tags.includes(tag.toLowerCase()))!;
  const cf = (tc: { cfv: { name: string; customField: { id: number } }[] }, name: string) =>
    tc.cfv.filter((v) => state.customFields.find((f) => f.id === v.customField.id)?.name === name).map((v) => v.name);

  it("reads the address in any form and writes queries the ALM way", () => {
    expect(almBase("https://alm.example.com/qcbin/")).toBe("https://alm.example.com/");
    expect(almBase("https://alm.example.com")).toBe("https://alm.example.com/");
    expect(almBase("https://alm.example.com/qcbin/ui/")).toBe("https://alm.example.com/");
    expect(almQuery({ "parent-id": [1, 2], "parent-type": "test" })).toBe("{parent-id[1 OR 2];parent-type[test]}");
    expect(almQuery({ name: "a b" })).toBe('{name["a b"]}');
  });

  it("logs in with a password or an API key and lists the projects", async () => {
    const before = alm.state.logouts;
    expect(await checkAlm(profile())).toMatchObject({
      ok: true,
      projects: [
        { key: "DEFAULT", name: "Banking" },
        { key: "DEFAULT", name: "Empty" },
        { key: "OTHER", name: "Legacy" },
      ],
    });
    // Every session is closed, nothing stays open on the ALM server.
    expect(alm.state.logouts).toBe(before + 1);
    const apiKey = profile();
    apiKey.alm.connection = { ...apiKey.alm.connection, auth: "apiKey", clientId: "demo-client", secret: "demo-secret", username: "", password: "" };
    expect(await checkAlm(apiKey)).toMatchObject({ ok: true });
    // An older ALM without alm-authenticate: the Basic authentication resource.
    const legacy = createAlmMock({ legacyAuth: true });
    await legacy.app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const old = profile();
      old.alm.connection.endpoint = `http://127.0.0.1:${(legacy.app.server.address() as AddressInfo).port}`;
      expect(await checkAlm(old)).toMatchObject({ ok: true });
      expect(legacy.state.logouts).toBe(1);
    } finally {
      await legacy.app.close();
    }
    const wrong = profile();
    wrong.alm.connection.password = "wrong";
    expect(await checkAlm(wrong)).toMatchObject({ ok: false, message: expect.stringMatching(/rejected the credentials/i) });
  });

  it("shows the folders, every field with its values and a suggestion", async () => {
    const discovery = await discoverAlm(profile());
    expect(discovery.sampledCases).toBe(5);
    expect(discovery.levels.map((level) => level.sectionCount)).toEqual([2, 2, 1]);
    expect(discovery.structure[0]!.examplePaths[0]).toEqual(["Online banking", "Payments", "Cards"]);
    const fields = Object.fromEntries(discovery.fields.map((f) => [f.systemName, f]));
    expect(Object.fromEntries(discovery.fields.map((f) => [f.label, f.suggestedTarget]))).toMatchObject({
      "Design steps": { kind: "scenario" },
      Parameters: { kind: "description", heading: "Parameters" },
      Description: { kind: "description", heading: "" },
      Comments: { kind: "comment" },
      Designer: { kind: "owner" },
      Status: { kind: "status" },
      Type: { kind: "customField", name: "Test type" },
      Priority: { kind: "customField", name: "Priority" },
      "Test Areas": { kind: "customField", name: "Test Areas" },
      Requirement: { kind: "customField", name: "Requirement" },
      Reviewer: { kind: "role", role: "" },
    });
    // Internal and inactive fields are not offered.
    expect(discovery.fields.some((f) => ["Execution Status", "Creation Date", "Retired field", "Test Name"].includes(f.label))).toBe(false);
    expect(fields["alm:status"]!.suggestedValues).toEqual({ Ready: "Active", Design: "Draft", Repair: "Draft" });
    expect(fields["alm:user-02"]!.options!.map((o) => o.label).sort()).toEqual(["Regression", "Smoke"]);
    expect(fields["alm:owner"]!.options).toEqual(expect.arrayContaining([expect.objectContaining({ id: "jane", label: "Jane Doe (jane)", email: "jane@example.com", count: 3 })]));
    expect(fields["alm:subtype-id"]!.options!.map((o) => o.label).sort()).toEqual(["Manual (MANUAL)", "UFT (QUICKTEST_TEST)"]);
    const context = await loadAlmContext(profile());
    expect(folderChoices(context.folders).map((folder) => folder.name)).toEqual(["Mobile", "Online banking", "Online banking / Accounts", "Online banking / Payments", "Online banking / Payments / Cards"]);
    await context.client.logout();
  });

  it("migrates tests with steps, called tests, files and fields, and updates them on a rerun", async () => {
    const p = await mapped(profile());
    p.fields.find((m) => m.source === "alm:user-04")!.target = { kind: "role", role: "Reviewer" };
    const logins = alm.state.logins;
    const summary = await run(p);
    expect(summary.counters).toMatchObject({ total: 5, created: 5, failed: 0 });
    expect(summary.problems?.map((problem) => problem.code) ?? []).not.toContain("attachment-download");
    // The session ended on the way and was opened again, and it is closed at the end.
    expect(alm.state.logins - logins).toBeGreaterThan(1);
    expect(alm.state.sessions.size).toBe(0);

    const login = byTag("alm:1");
    expect(login.name).toBe("Log in with valid credentials");
    expect(cf(login, "Epic")).toEqual(["Online banking"]);
    expect(cf(login, "Feature")).toEqual(["Accounts"]);
    expect(cf(login, "Priority")).toEqual(["2-High"]);
    expect(cf(login, "Test Areas").sort()).toEqual(["Regression", "Smoke"]);
    expect(cf(login, "Requirement")).toEqual(["REQ-12"]);
    expect(cf(login, "Test type")).toEqual(["Manual"]);
    expect(login.statusId).toBe(2);
    expect(login.members).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "jane", role: expect.objectContaining({ id: -1 }) }), expect.objectContaining({ name: "sam", role: { id: 2 } })]),
    );
    expect(login.description).toContain("Checks the **login** page.");
    expect(login.description).not.toContain("converted");
    const picture = login.attachments.find((a) => a.name === "Test_1_login.png")!;
    expect(login.description).toContain(`/api/rs/testcase/attachment/${picture.id}/content`);
    expect(login.attachments.map((a) => a.name).sort()).toEqual(["Step_12_menu.png", "Test_1_login.png", "credentials.png", "spec.pdf"]);
    expect(state.comments.filter((c) => c.testCaseId === login.id).map((c) => c.body)).toEqual(["**jane**, 2024-03-01: reviewed"]);
    // Steps in the order of the test; a name someone wrote stays with its step.
    expect(login.scenario.map((s) => s.data.body)).toEqual(["Open the login page", "Enter **demo** / **secret**", "Check the menu\nLook at the menu"]);
    expect(JSON.stringify(login.scenario[0])).toContain("The form is shown");
    expect(JSON.stringify(login.scenario[1])).toContain("The dashboard opens");
    expect(JSON.stringify(login.scenario[2])).toContain(`"attachmentId":${login.attachments.find((a) => a.name === "Step_12_menu.png")!.id}`);

    // A step that calls a test is a shared step; the parameters stay readable.
    const pay = byTag("alm:2");
    const shared = state.sharedSteps.find((s) => s.name === "Open the payment form [3]")!;
    expect(shared.scenario.map((s) => s.data.body)).toEqual(["Open *Payments*", "Click **New payment**"]);
    expect(pay.scenario[0]!.data).toMatchObject({ type: "shared", sharedStepId: shared.id });
    expect(pay.scenario[1]!.data.body).toBe("Pay <<<amount>>> <<<currency>>>");
    expect(pay.description).toBe("Payment with a card stored in the profile.\n\n### Parameters\n\n- **amount**: 100 (Amount to pay)\n- **currency**: EUR");
    expect(pay.statusId).toBe(1);
    expect(pay.members).toEqual([expect.objectContaining({ name: "sam" })]);
    expect(cf(pay, "Story")).toEqual(["Cards"]);

    const old = byTag("alm:4");
    expect(old.links).toEqual([expect.objectContaining({ name: "Transfer rules", url: "https://wiki.example.com/transfers" })]);
    expect(old.description).toBe("Plain text description");
    expect(cf(old, "Test type")).toEqual(["UFT"]);

    const again = await run(p);
    expect(again.counters).toMatchObject({ created: 0, updated: 5, failed: 0 });
    expect(state.testCases.filter((tc) => tc.tags.some((t) => t.startsWith("alm:")))).toHaveLength(5);
    expect(state.sharedSteps.filter((s) => s.name.startsWith("Open the payment form"))).toHaveLength(1);
    expect(byTag("alm:1").attachments).toHaveLength(4);
  });

  it("writes a detailed log without credentials, cookies or the text of the tests", async () => {
    const p = await mapped(profile("trace"));
    p.alm.scope.testIds = [1, 2];
    const summary = await run(p, true);
    const lines = (await store.log(p.id, summary.id, 0, Number.MAX_SAFE_INTEGER)).filter((entry) => entry.level === "debug").map((entry) => entry.message);
    const text = lines.join("\n");
    expect(text).toContain("POST qcbin/authentication-point/alm-authenticate -> cookies now: LWSSO_COOKIE_KEY");
    expect(text).toMatch(/GET qcbin\/rest\/domains\/DEFAULT\/projects\/Banking\/tests\?query=\{id\[1 OR 2\]\}.* -> 2 entities, TotalResults 2/);
    // The fields of the first test once, by kind of value.
    expect(text).toMatch(/tests\?.* -> 1 entity, TotalResults 5; first entity: type "test", keys Type\/Fields, fields /);
    expect(text).toContain('subtype-id="MANUAL"');
    expect(text).toMatch(/description=html \d+/);
    expect(text).toContain("Field settings: id \"Test ID\" Number");
    expect(text).toMatch(/Test 1: 3 design step\(s\) \(step-order 1,2,3\).*pictures in text: test Test_1_login.png \(listed\); step 12 Step_12_menu.png \(listed\)/);
    expect(text).toMatch(/Test 2: .*calls test 3/);
    expect(text).toContain("POST qcbin/authentication-point/logout -> OK");
    // Nothing secret and nothing written in the tests.
    expect(text).not.toMatch(/demo-password|LWSSO_COOKIE_KEY=|QCSession=|lw\d|qc\d|Checks the|Payment with a card/);

    const check = await checkAlm(p);
    expect(check.details).toContain("Logged in: requests carry X-XSRF-TOKEN");
    expect(check.details).not.toContain("demo-password");
    const quiet = profile("quiet");
    quiet.alm.detailedLog = false;
    expect((await checkAlm(quiet)).details).toBeUndefined();
  });

  it("narrows the migration to folders or to single tests, and turns parameters into examples", async () => {
    const byFolder = await mapped(profile("folder"));
    byFolder.alm.scope.folderIds = [1002];
    expect((await run(byFolder, true)).counters).toMatchObject({ total: 3, failed: 0 });

    const byTest = await mapped(profile("single"));
    byTest.alm.scope.testIds = [2, 404];
    byTest.fields.find((m) => m.source === "alm:parameters")!.target = { kind: "examples" };
    const summary = await run(byTest);
    expect(summary.counters).toMatchObject({ total: 1, created: 1 });
    expect(byTag("single:2").examples.map((e) => e.parameters)).toEqual([[{ name: "amount", value: "100" }, { name: "currency", value: "EUR" }]]);
  });

  it("copies the steps of called tests when shared steps are off, and works without the field settings", async () => {
    const p = await mapped(profile("inline"));
    p.options.migrateSharedSteps = false;
    p.alm.scope.testIds = [2];
    await run(p);
    const pay = byTag("inline:2");
    expect(pay.scenario[0]!.data.body).toBe("Call Open the payment form");
    expect(JSON.stringify(pay.scenario[0])).toContain("Click **New payment**");

    const bare = createAlmMock({ noCustomization: true });
    await bare.app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const other = profile("bare");
      other.alm.connection.endpoint = `http://127.0.0.1:${(bare.app.server.address() as AddressInfo).port}`;
      const discovery = await discoverAlm(other);
      expect(discovery.fields.map((f) => f.label)).toEqual(expect.arrayContaining(["Design steps", "Description", "Designer", "Status", "user-01"]));
      expect(discovery.warnings.join(" ")).toMatch(/field settings/);
    } finally {
      await bare.app.close();
    }
  });
});
