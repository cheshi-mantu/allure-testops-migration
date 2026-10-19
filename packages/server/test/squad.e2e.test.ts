import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSquadMock, createTestOpsMock, type TestOpsMockState } from "@atm/mocks";
import { mergeSuggestedMappings, newProfile, type Profile, type RunSummary } from "@atm/shared";
import { RunManager } from "../src/engine/runner.js";
import { checkSquad } from "../src/routes/checks.js";
import { canonicalRequest, zapiToken } from "../src/squad/client.js";
import { discoverSquad } from "../src/squad/discovery.js";
import { FileStore } from "../src/storage/fileStore.js";
import { RunStore } from "../src/storage/runs.js";
import { discoverTestOps } from "../src/testops/discovery.js";

describe("Zephyr Squad to Allure TestOps migration", () => {
  const testops = createTestOpsMock();
  const squad = createSquadMock();
  let state: TestOpsMockState;
  let dataDir: string;
  let store: RunStore;
  let runner: RunManager;

  beforeAll(async () => {
    await testops.app.listen({ port: 0, host: "127.0.0.1" });
    await squad.app.listen({ port: 0, host: "127.0.0.1" });
    state = testops.state;
    dataDir = await mkdtemp(join(tmpdir(), "atm-squad-"));
    store = new RunStore(dataDir);
    runner = new RunManager(store, { files: new FileStore(dataDir), retryPauseMs: 10 });
  });

  afterAll(async () => {
    await testops.app.close();
    await squad.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const site = () => `http://127.0.0.1:${(squad.app.server.address() as AddressInfo).port}`;

  function profile(id = "squad"): Profile {
    const p = newProfile(id, id, new Date(), "squad");
    p.squad.connection = {
      ...p.squad.connection,
      endpoint: `${site()}/connect`,
      accessKey: "demo-access-key",
      secretKey: "demo-secret-key",
      jiraUrl: site(),
      jiraEmail: "demo@example.com",
      jiraApiToken: "demo-jira-token",
      requestsPerMinute: 6000,
    };
    p.squad.scope.projectKey = "CALC";
    p.testops.connection = { endpoint: `http://127.0.0.1:${(testops.app.server.address() as AddressInfo).port}/`, apiToken: "demo-api-token", insecureTls: false };
    p.testops.scope.projectId = 1;
    p.options.migrationTagPrefix = id;
    return p;
  }

  async function mapped(p: Profile): Promise<Profile> {
    const discovery = await discoverSquad(p);
    p.fields = mergeSuggestedMappings([], discovery.fields, await discoverTestOps(p));
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

  it("signs requests the way the Atlassian query string hash describes", () => {
    const base = "https://prod-api.zephyr4jiracloud.com/connect";
    expect(canonicalRequest("get", `${base}/public/rest/api/2.0/teststep/10001?projectId=10000&b=x%20y&a=2&a=1`, base)).toBe("GET&/public/rest/api/2.0/teststep/10001&a=1,2&b=x%20y&projectId=10000");
    expect(canonicalRequest("GET", `${base}/public/rest/api/1.0/serverinfo/`, base)).toBe("GET&/public/rest/api/1.0/serverinfo&");
    expect(canonicalRequest("GET", `${base}/x?q=a*b%21`, base)).toBe("GET&/x&q=a%2Ab%21");
    const token = zapiToken("GET", `${base}/public/rest/api/1.0/serverinfo`, base, { accessKey: "ak", secretKey: "sk", accountId: "acc" }, 1_700_000_000_000);
    const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());
    expect(claims).toMatchObject({ iss: "ak", sub: "acc", iat: 1_700_000_000, exp: 1_700_003_600 });
    expect(claims.qsh).toMatch(/^[0-9a-f]{64}$/);
  });

  it("checks Jira and the API keys", async () => {
    const result = await checkSquad(profile());
    expect(result).toMatchObject({ ok: true, projects: [{ key: "CALC", name: "Calculator (CALC)" }] });
    expect(result.details).toMatch(/GET public\/rest\/api\/1.0\/serverinfo: ok/);
    expect(result.details).not.toMatch(/demo-secret-key|demo-jira-token|JWT /);
    const wrong = profile();
    wrong.squad.connection.secretKey = "wrong";
    expect(await checkSquad(wrong)).toMatchObject({ ok: false, message: expect.stringMatching(/Jira works .* Zephyr Squad rejected the API keys/) });
    expect(squad.state.rejected).toContain("bad signature");
  });

  it("shows the steps and every Jira field with a suggestion", async () => {
    const discovery = await discoverSquad(profile());
    expect(discovery.sampledCases).toBe(3);
    expect(discovery.maxDepth).toBe(0);
    const fields = Object.fromEntries(discovery.fields.map((f) => [f.systemName, f]));
    expect(Object.fromEntries(discovery.fields.map((f) => [f.systemName, f.suggestedTarget]))).toMatchObject({
      "squad:steps": { kind: "scenario" },
      "jira:description": { kind: "description", heading: "" },
      "jira:labels": { kind: "tag" },
      "jira:assignee": { kind: "owner" },
      "jira:priority": { kind: "customField", name: "Priority" },
      "jira:customfield_10100": { kind: "customField", name: "Automation" },
      "jira:link:tests": { kind: "issue", integrationId: null },
      "jira:comment": { kind: "comment" },
    });
    // The Jira field of Zephyr Squad repeats what the steps carry.
    expect(fields["jira:customfield_10200"]?.suggestedTarget ?? { kind: "ignore" }).toEqual({ kind: "ignore" });
    expect(fields["squad:steps"]!.examples[0]).toBe("3 step(s): Open the login page");
  });

  it("migrates tests with steps, step files and Jira fields, and updates them on a rerun", async () => {
    const p = await mapped(profile());
    p.fields.find((m) => m.source === "jira:link:tests")!.target = { kind: "issue", integrationId: 1 };
    const summary = await run(p);
    expect(summary.counters).toMatchObject({ total: 3, created: 3, failed: 0 });
    expect(summary.problems?.map((problem) => problem.code) ?? []).not.toContain("attachment-download");
    expect(squad.state.rejected.filter((why) => why !== "bad signature")).toEqual([]);

    const login = byTag("squad:calc-1");
    expect(login.name).toBe("Log in with a valid password");
    expect(login.tags).toEqual(expect.arrayContaining(["smoke", "login"]));
    expect(cf(login, "Priority")).toEqual(["High"]);
    expect(cf(login, "Automation")).toEqual(["Manual"]);
    expect(login.members).toEqual([expect.objectContaining({ name: "jane", role: expect.objectContaining({ id: -1 }) })]);
    expect(login.issues).toEqual([expect.objectContaining({ name: "CALC-50" })]);
    expect(login.description).toContain("Checks the **login** form.");
    const picture = login.attachments.find((a) => a.name === "login.png")!;
    expect(login.description).toContain(`/api/rs/testcase/attachment/${picture.id}/content`);
    expect(login.links).toEqual([expect.objectContaining({ name: "Jira CALC-1", url: `${site()}/browse/CALC-1` })]);
    expect(state.comments.filter((c) => c.testCaseId === login.id).map((c) => c.body)).toEqual(["Reviewed by **QA**"]);
    // The third step has only an expected result; Allure TestOps needs a step text.
    expect(login.scenario.map((s) => s.data.body)).toEqual(["Open the login page", "Enter jane and the password", "Untitled step"]);
    expect(JSON.stringify(login.scenario[0])).toContain("url: /login");
    expect(JSON.stringify(login.scenario[1])).toContain(`"attachmentId":${login.attachments.find((a) => a.name === "dashboard.png")!.id}`);
    expect(JSON.stringify(login.scenario[2])).toContain("The name is shown in the header");

    // Steps answered in pages, a step file only the attachment search names, and a table in the test data.
    const pay = byTag("squad:calc-2");
    expect(pay.scenario.map((s) => s.data.body)).toEqual(["Add a phone to the cart", "Pay with the card", "Open My orders"]);
    expect(pay.attachments.map((a) => a.name).sort()).toEqual(expect.arrayContaining(["cards.csv"]));
    expect(cf(pay, "Automation")).toEqual(["Automated"]);
    expect(summary.problems?.find((problem) => problem.code === "user-missing")?.title).toContain("Sam Tester");

    expect(byTag("squad:calc-3").scenario).toEqual([]);
    expect(state.testCases.some((tc) => tc.tags.includes("squad:calc-4"))).toBe(false);

    const again = await run(p);
    expect(again.counters).toMatchObject({ created: 0, updated: 3, failed: 0 });
    expect(state.testCases.filter((tc) => tc.tags.some((t) => t.startsWith("squad:")))).toHaveLength(3);
  });

  it("writes a detailed log without keys, tokens or the text of the tests", async () => {
    const p = await mapped(profile("trace"));
    p.squad.scope.issueKeys = ["CALC-1", "CALC-2"];
    const summary = await run(p, true);
    const text = (await store.log(p.id, summary.id, 0, Number.MAX_SAFE_INTEGER)).filter((entry) => entry.level === "debug").map((entry) => entry.message).join("\n");
    expect(text).toContain("Zephyr Squad: Detailed log is on.");
    expect(text).toMatch(/GET public\/rest\/api\/2.0\/teststep\/10001\?projectId=10000: ok in \d+ ms, a list, 3 step\(s\), first step \{id:"0001-a", orderId:number, step:text 21, data:text 15, result:text 17, /);
    expect(text).toMatch(/GET public\/rest\/api\/2.0\/teststep\/10002\?projectId=10000: ok in \d+ ms, keys testSteps\/totalCount, 2 step\(s\), total 3/);
    expect(text).toMatch(/GET public\/rest\/api\/2.0\/teststep\/10002\?offsetOpt=2&projectId=10000: ok/);
    expect(text).toMatch(/CALC-1: 3 step\(s\) \(order 1,2,3; with step 2, data 1, result 3\); 2 step\(s\) with wiki markup; step files named in the step list; step 0001-b: dashboard.png; 1 issue file\(s\) \[login.png\]/);
    expect(text).toMatch(/CALC-2: .*step 0002-b: cards.csv/);
    expect(text).not.toMatch(/demo-secret-key|demo-access-key|demo-jira-token|demo@example\.com|JWT |login page|Checks the/);
  });

  it("narrows the migration with JQL and issue keys", async () => {
    const byLabel = await mapped(profile("label"));
    byLabel.squad.scope.jql = "labels = checkout";
    expect((await run(byLabel, true)).counters).toMatchObject({ total: 1, failed: 0 });
    const byKey = await mapped(profile("single"));
    byKey.squad.scope.issueKeys = ["calc-3", "CALC-4"];
    const summary = await run(byKey, true);
    expect(summary.counters).toMatchObject({ total: 1 });
    const log = await store.log(byKey.id, summary.id, 0, Number.MAX_SAFE_INTEGER);
    expect(log.map((entry) => entry.message).join("\n")).toContain('CALC-4 is not a test of type "Test" in project CALC');
  });
});
