import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestOpsMock } from "@atm/mocks";
import { newProfile, type RunSummary } from "@atm/shared";
import { RunManager } from "../src/engine/runner.js";
import { FileStore } from "../src/storage/fileStore.js";
import { RunStore } from "../src/storage/runs.js";

const CSV = `ID,Title,Steps
C1,First case,Open the page
C2,Second case,Close the page
`;

describe("migration against an overloaded Allure TestOps", () => {
  const failures = [
    // Answered by the web application instead of the API: repeated by the HTTP client.
    { method: "GET", path: /^\/api\/rs\/testcase\/__search$/, times: 1, answer: "webPage" as const },
    // Writes are not repeated by the HTTP client: the case gets a second attempt at the end of the run.
    { method: "POST", path: /^\/api\/rs\/testcase$/, times: 1, answer: 500 as const },
    // The case exists by now but has no tag yet: the second attempt must reuse it, not create another one.
    { method: "POST", path: /^\/api\/rs\/testcase\/\d+\/tag$/, times: 1, answer: 500 as const },
  ];
  const testops = createTestOpsMock({ failures });
  let dataDir: string;
  let files: FileStore;
  let store: RunStore;
  let runner: RunManager;

  beforeAll(async () => {
    await testops.app.listen({ port: 0, host: "127.0.0.1" });
    dataDir = await mkdtemp(join(tmpdir(), "atm-flaky-"));
    files = new FileStore(dataDir);
    store = new RunStore(dataDir);
    runner = new RunManager(store, { files, retryPauseMs: 10 });
  });

  afterAll(async () => {
    await testops.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("tries cases that failed on the server side again, without duplicates", async () => {
    const file = await files.save("flaky.csv", Buffer.from(CSV));
    const profile = newProfile("flaky", "flaky", new Date(), "csv");
    profile.csv.fileId = file.id;
    profile.testops.connection = {
      endpoint: `http://127.0.0.1:${(testops.app.server.address() as AddressInfo).port}/`,
      apiToken: "demo-api-token",
      insecureTls: false,
    };
    profile.testops.scope.projectId = 1;
    profile.options.concurrency = 1;
    profile.fields = [
      { source: "ID", target: { kind: "sourceId" }, values: {}, separator: "" },
      { source: "Title", target: { kind: "name" }, values: {}, separator: "" },
      { source: "Steps", target: { kind: "scenario" }, values: {}, separator: "" },
    ];

    const started = runner.start(profile, false);
    while (runner.isActive(profile.id, started.id)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const summary = (await store.get(profile.id, started.id)) as RunSummary;
    const log = (await store.log(profile.id, started.id, 0, 1000)).map((e) => e.message);

    expect(failures.every((f) => f.times === 0)).toBe(true);
    expect(summary.status).toBe("finished");
    expect(summary.counters).toMatchObject({ total: 2, processed: 2, created: 2, failed: 0 });
    expect(summary.problems).toEqual([]);
    expect(log.filter((m) => m.includes("it is tried again at the end of the run"))).toHaveLength(2);
    expect(log.filter((m) => m.includes("on the second attempt"))).toHaveLength(2);
    const migrated = testops.state.testCases.filter((tc) => tc.tags.some((t) => t.startsWith("csv:")));
    expect(migrated.map((tc) => tc.name).sort()).toEqual(["First case", "Second case"]);
    expect(testops.state.testCases).toHaveLength(2);
  });
});
