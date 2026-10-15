import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestOpsMock, type TestOpsMockState } from "@atm/mocks";
import { newProfile, type Profile, type RunSummary } from "@atm/shared";
import { RunManager } from "../src/engine/runner.js";
import { FileStore } from "../src/storage/fileStore.js";
import { RunStore } from "../src/storage/runs.js";
import { TestOpsClient } from "../src/testops/client.js";

describe("Allure TestOps to Allure TestOps migration", () => {
  const source = createTestOpsMock();
  const target = createTestOpsMock();
  let state: TestOpsMockState;
  let dataDir: string;
  let store: RunStore;
  let runner: RunManager;
  let manualId = 0;
  let automatedId = 0;
  const url = (mock: typeof source) => `http://127.0.0.1:${(mock.app.server.address() as AddressInfo).port}/`;

  beforeAll(async () => {
    await source.app.listen({ port: 0, host: "127.0.0.1" });
    await target.app.listen({ port: 0, host: "127.0.0.1" });
    state = target.state;
    dataDir = await mkdtemp(join(tmpdir(), "atm-testops-"));
    store = new RunStore(dataDir);
    runner = new RunManager(store, { files: new FileStore(dataDir), retryPauseMs: 10 });

    // The source project, written through the API like a team would have it.
    const api = new TestOpsClient({ endpoint: url(source), apiToken: "demo-api-token", insecureTls: false });
    const shared = await api.createSharedStep(1, "Log in");
    await api.uploadSharedStepAttachment(shared.id, "login.png", Buffer.from("png"), "image/png");
    await api.setSharedStepScenario(shared.id, [{ type: "body", body: "Open the login page" }, { type: "body", body: "Enter the credentials" }]);

    const manual = await api.createTestCase(1, "Reset a forgotten password");
    manualId = manual.id;
    const [screenshot] = [await api.uploadTestCaseAttachment(manual.id, "screenshot.png", Buffer.from("png"), "image/png")];
    await api.uploadTestCaseAttachment(manual.id, "data.csv", Buffer.from("a,b"), "text/csv");
    await api.updateTestCase(manual.id, {
      description: `Checks the **reset** flow.\n\n![shot](/api/rs/testcase/attachment/${screenshot!.id}/content)`,
      precondition: "The user exists.",
      expectedResult: "The password is changed.",
      statusId: 2,
      testLayerId: 1,
      links: [{ name: "Spec", url: "https://docs.example.com/reset" }],
    });
    await api.setTags(manual.id, ["smoke", "auth"]);
    await api.setCustomFieldValues(manual.id, [
      { name: "Web", customField: { id: 1 } },
      { name: "Auth", customField: { id: 2 } },
      { name: "High", customField: { id: 4 } },
      { name: "Critical", customField: { id: 4 } },
    ]);
    await api.setIssues(manual.id, [{ name: "SHOP-12", integrationId: 1 }]);
    await api.setTestKeys(manual.id, [{ name: "QA-7", integrationId: 1 }]);
    await api.setMembers(manual.id, [
      { name: "jane", role: { id: -1 } },
      { name: "sam", role: { id: 2 } },
    ]);
    await api.setExamples(manual.id, [[{ name: "browser", value: "chrome" }], [{ name: "browser", value: "firefox" }]]);
    await api.addComment(manual.id, "Reviewed by **sam**.");
    await api.setScenario(manual.id, [
      { type: "shared", sharedStepId: shared.id },
      {
        type: "body",
        body: "Request a reset",
        steps: [{ type: "body", body: "Click Forgot password" }, { type: "attachment", attachmentId: screenshot!.id }],
        expectedResultSteps: [{ type: "expected_body", body: "The reset form is shown" }],
      },
      { type: "body", body: "Open the mailbox" },
    ]);

    // A workflow of its own, with a status the target does not have, for manual cases of the project.
    const inReview = await api.createStatus("In review", "#ffaa00");
    const flow = await api.createWorkflow("QA flow", [1, inReview.id]);
    await api.createWorkflowSchema(1, flow.id, "manual");
    await api.updateTestCase(manual.id, { workflowId: flow.id, statusId: inReview.id });

    // The target already has a workflow of the same name, without that status.
    const targetApi = new TestOpsClient({ endpoint: url(target), apiToken: "demo-api-token", insecureTls: false });
    await targetApi.createWorkflow("QA flow", [1]);

    const automated = await api.createTestCase(1, "Orders API returns the list");
    automatedId = automated.id;
    await api.updateTestCase(automated.id, { automated: true, statusId: 1 });
    await api.setTags(automated.id, ["api"]);
    await api.createTree(1, "Features", [1, 2]);
  });

  afterAll(async () => {
    await source.app.close();
    await target.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  function profile(id: string, targetName: string): Profile {
    const p = newProfile(id, id, new Date(), "testops");
    p.testopsSource.connection = { endpoint: url(source), apiToken: "demo-api-token", insecureTls: false };
    p.testopsSource.projects = [{ sourceId: 1, sourceName: "Demo", targetName }];
    p.testopsSource.integrations = { "1": 1 };
    p.testops.connection = { endpoint: url(target), apiToken: "demo-api-token", insecureTls: false };
    return p;
  }

  async function run(p: Profile, dryRun = false): Promise<RunSummary> {
    const started = runner.start(p, dryRun);
    while (runner.isActive(p.id, started.id)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return (await store.get(p.id, started.id))!;
  }

  const cf = (tc: { cfv: { name: string; customField: { id: number } }[] }, name: string) =>
    tc.cfv.filter((v) => state.customFields.find((f) => f.id === v.customField.id)?.name === name).map((v) => v.name);

  it("checks a project that does not exist yet on a dry run, without creating it", async () => {
    const summary = await run(profile("dry", "Demo dry"), true);
    expect(summary.status).toBe("finished");
    expect(summary.counters).toMatchObject({ total: 2, failed: 0 });
    const log = (await store.log("dry", summary.id)).map((entry) => entry.message);
    expect(log).toContain('Target project "Demo dry" will be created.');
    expect(log.some((message) => message.startsWith('Tree "Features"'))).toBe(true);
    expect(log).toContain('Workflow "QA flow" will get the statuses "In review".');
    expect((await new TestOpsClient({ endpoint: url(target), apiToken: "demo-api-token", insecureTls: false }).projects()).map((p) => p.name)).not.toContain("Demo dry");
  });

  it("copies the project one to one: cases, fields, issues, members, files and steps", async () => {
    const summary = await run(profile("copy", "Demo copy"));
    expect(summary.status).toBe("finished");
    expect(summary.counters).toMatchObject({ total: 2, created: 2, failed: 0 });
    expect(summary.problems ?? []).toEqual([]);

    const projects = await new TestOpsClient({ endpoint: url(target), apiToken: "demo-api-token", insecureTls: false }).projects();
    const project = projects.find((p) => p.name === "Demo copy")!;
    expect(project).toBeDefined();
    expect(state.trees.find((tree) => tree.projectId === project.id)?.name).toBe("Features");

    const copy = state.testCases.find((tc) => tc.projectId === project.id && tc.tags.includes(`old_id:${manualId}`))!;
    expect(copy.name).toBe("Reset a forgotten password");
    expect(copy.tags).toEqual([`old_id:${manualId}`, "smoke", "auth"]);
    expect(copy.precondition).toBe("The user exists.");
    expect(copy.expectedResult).toBe("The password is changed.");
    // The workflow of the target got the missing status; the case has both.
    const targetApi = new TestOpsClient({ endpoint: url(target), apiToken: "demo-api-token", insecureTls: false });
    const flow = (await targetApi.workflows()).find((w) => w.name === "QA flow")!;
    const flowStatuses = await targetApi.allStatuses(flow.id);
    expect(flowStatuses.map((s) => s.name)).toEqual(["Draft", "In review"]);
    expect(copy.workflowId).toBe(flow.id);
    expect(copy.statusId).toBe(flowStatuses.find((s) => s.name === "In review")!.id);
    expect((await targetApi.workflowSchemas(project.id)).map((schema) => [schema.type, schema.workflow.name])).toEqual([["manual", "QA flow"]]);
    expect(copy.links).toEqual([{ name: "Spec", url: "https://docs.example.com/reset" }]);
    expect(cf(copy, "Epic")).toEqual(["Web"]);
    expect(cf(copy, "Priority").sort()).toEqual(["Critical", "High"]);
    expect(copy.issues).toEqual([{ name: "SHOP-12", integrationId: 1 }]);
    expect(copy.testKeys).toEqual([{ name: "QA-7", integrationId: 1 }]);
    expect(copy.members).toEqual([
      { name: "jane", role: { id: -1 } },
      { name: "sam", role: { id: 2 } },
    ]);
    expect(copy.examples.map((e) => e.parameters)).toEqual([[{ name: "browser", value: "chrome" }], [{ name: "browser", value: "firefox" }]]);
    expect(state.comments.filter((c) => c.testCaseId === copy.id).map((c) => c.body)).toEqual(["Reviewed by **sam**."]);
    // Every file of the case, and the image in the description points to the copy.
    expect(copy.attachments.map((a) => a.name).sort()).toEqual(["data.csv", "screenshot.png"]);
    const shot = copy.attachments.find((a) => a.name === "screenshot.png")!;
    expect(copy.description).toBe(`Checks the **reset** flow.\n\n![shot](/api/rs/testcase/attachment/${shot.id}/content)`);

    // Steps: the shared step, a step with a nested step, a file and an expected result, a plain step.
    const shared = state.sharedSteps.find((s) => s.projectId === project.id)!;
    expect(shared.name).toBe("Log in");
    expect(shared.scenario.map((s) => s.data.body)).toEqual(["Open the login page", "Enter the credentials"]);
    expect(shared.attachments.map((a) => a.name)).toEqual(["login.png"]);
    expect(copy.scenario.map((s) => s.data)).toEqual([
      { type: "shared", sharedStepId: shared.id },
      {
        type: "body",
        body: "Request a reset",
        steps: [{ type: "body", body: "Click Forgot password" }, { type: "attachment", attachmentId: shot.id }],
        expectedResultSteps: [{ type: "expected_body", body: "The reset form is shown" }],
      },
      { type: "body", body: "Open the mailbox" },
    ]);

    // The integration of the issues was added to the new project.
    const integrations = await new TestOpsClient({ endpoint: url(target), apiToken: "demo-api-token", insecureTls: false }).projectIntegrations(project.id);
    expect(integrations.map((i) => i.id)).toEqual([1]);

    const automated = state.testCases.find((tc) => tc.projectId === project.id && tc.tags.includes(`old_id:${automatedId}`))!;
    expect(automated.automated).toBe(true);
    expect(automated.statusId).toBe(1);

    // A rerun finds the project and the cases: nothing is duplicated.
    const again = await run(profile("copy", "Demo copy"));
    expect(again.counters).toMatchObject({ created: 0, updated: 2, failed: 0 });
    expect(projects.filter((p) => p.name === "Demo copy")).toHaveLength(1);
    expect(state.testCases.filter((tc) => tc.projectId === project.id)).toHaveLength(2);
    expect(state.sharedSteps.filter((s) => s.projectId === project.id)).toHaveLength(1);
    expect(copy.attachments).toHaveLength(2);
  });

  it("creates a workflow the target lacks, with its statuses", async () => {
    const api = new TestOpsClient({ endpoint: url(source), apiToken: "demo-api-token", insecureTls: false });
    const blocked = await api.createStatus("Blocked", "#ff0000");
    const support = await api.createWorkflow("Support flow", [1, blocked.id]);
    await api.updateTestCase(automatedId, { workflowId: support.id, statusId: blocked.id });
    const p = profile("support", "Demo support");
    p.testopsSource.caseIds = [automatedId];
    expect((await run(p)).counters).toMatchObject({ created: 1, failed: 0 });

    const targetApi = new TestOpsClient({ endpoint: url(target), apiToken: "demo-api-token", insecureTls: false });
    const created = (await targetApi.workflows()).find((w) => w.name === "Support flow")!;
    const statuses = await targetApi.allStatuses(created.id);
    expect(statuses.map((s) => [s.name, s.color])).toEqual([["Draft", undefined], ["Blocked", "#ff0000"]]);
    const copy = state.testCases.find((tc) => tc.tags.includes(`old_id:${automatedId}`) && tc.workflowId === created.id)!;
    expect(copy.statusId).toBe(statuses.find((s) => s.name === "Blocked")!.id);
  });

  it("migrates only manual or only automated test cases when asked", async () => {
    const manualOnly = profile("manual", "Demo manual");
    manualOnly.testopsSource.automated = false;
    const first = await run(manualOnly);
    expect(first.counters).toMatchObject({ total: 1, created: 1, failed: 0 });
    const manualProject = (await new TestOpsClient({ endpoint: url(target), apiToken: "demo-api-token", insecureTls: false }).projects()).find((p) => p.name === "Demo manual")!;
    expect(state.testCases.filter((tc) => tc.projectId === manualProject.id).map((tc) => tc.name)).toEqual(["Reset a forgotten password"]);
    const log = (await store.log("manual", first.id)).map((entry) => entry.message);
    expect(log.some((message) => message.includes("1 automated case(s) are left out by the filter"))).toBe(true);

    const automatedOnly = profile("automated", "Demo automated");
    automatedOnly.testopsSource.manual = false;
    expect((await run(automatedOnly)).counters).toMatchObject({ total: 1, created: 1, failed: 0 });

    const neither = profile("neither", "Demo neither");
    neither.testopsSource.manual = false;
    neither.testopsSource.automated = false;
    const failed = await run(neither);
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/Neither manual nor automated/);
  });

  it("says which issues are not migrated when no target integration is chosen for them", async () => {
    const p = profile("nointegration", "Demo without issues");
    p.testopsSource.integrations = {};
    p.testopsSource.caseIds = [manualId];
    const summary = await run(p);
    expect(summary.counters).toMatchObject({ created: 1, failed: 0 });
    expect(summary.problems?.find((problem) => problem.code === "testops-integration-not-mapped")).toMatchObject({ fix: { step: "scope" } });
  });
});
