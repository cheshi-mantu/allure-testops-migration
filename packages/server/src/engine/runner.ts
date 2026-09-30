import { randomUUID } from "node:crypto";
import { testRailRequestsPerMinute, type LogLevel, type Profile, type RunLogEntry, type RunSummary } from "@atm/shared";
import { sharedRateLimiter, type RateLimiter } from "../http/rateLimiter.js";
import { TestOpsClient } from "../testops/client.js";
import { discoverTestOps, requireTestOpsProject } from "../testops/discovery.js";
import type { RunStore } from "../storage/runs.js";
import { CaseSkipped } from "./errors.js";
import { TargetResolver } from "./targets.js";
import { prepareSource, type PreparedSource, type SourceCase, type SourceDeps } from "./sources.js";
import { TestOpsWriter } from "./writer.js";

type Listener = (event: { type: "log"; entry: RunLogEntry } | { type: "summary"; summary: RunSummary }) => void;

class CancelledError extends Error {}

/** One migration or dry run in progress. */
export class Run {
  readonly summary: RunSummary;
  private seq = 0;
  private pendingLog: RunLogEntry[] = [];
  private readonly listeners = new Set<Listener>();
  private cancelled = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private rateLimit: { limiter: RateLimiter; requests: number; waitedMs: number } | null = null;

  constructor(
    private readonly profile: Profile,
    dryRun: boolean,
    private readonly store: RunStore,
    private readonly deps: SourceDeps,
  ) {
    this.summary = {
      id: `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`,
      profileId: profile.id,
      dryRun,
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      counters: { total: 0, processed: 0, created: 0, updated: 0, failed: 0, skipped: 0 },
      phase: "Starting",
      error: null,
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  cancel() {
    this.cancelled = true;
    this.log("warn", "Cancellation requested; finishing the cases in progress.");
  }

  private checkCancelled() {
    if (this.cancelled) {
      throw new CancelledError("Cancelled");
    }
  }

  log(level: LogLevel, message: string, caseId?: string, targetId?: number) {
    const entry: RunLogEntry = { seq: ++this.seq, time: new Date().toISOString(), level, message, caseId, targetId };
    this.pendingLog.push(entry);
    this.listeners.forEach((listener) => listener({ type: "log", entry }));
    this.flushSoon();
  }

  private emitSummary() {
    this.listeners.forEach((listener) => listener({ type: "summary", summary: { ...this.summary, counters: { ...this.summary.counters } } }));
    this.flushSoon();
  }

  private flushSoon() {
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => void this.flush(), 500);
    }
  }

  async flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const entries = this.pendingLog;
    this.pendingLog = [];
    await this.store.appendLog(this.profile.id, this.summary.id, entries);
    await this.store.save(this.summary);
  }

  private phase(name: string) {
    this.summary.phase = name;
    this.log("info", name);
    this.emitSummary();
  }

  async execute(): Promise<void> {
    try {
      await this.work();
      this.summary.status = this.cancelled ? "cancelled" : "finished";
      this.summary.phase = this.cancelled ? "Cancelled" : "Done";
    } catch (error) {
      if (error instanceof CancelledError) {
        this.summary.status = "cancelled";
        this.summary.phase = "Cancelled";
      } else {
        this.summary.status = "failed";
        this.summary.error = error instanceof Error ? error.message : String(error);
        this.log("error", `Migration stopped: ${this.summary.error}`);
      }
    } finally {
      this.summary.finishedAt = new Date().toISOString();
      const { total, created, updated, failed, skipped } = this.summary.counters;
      this.log(
        "info",
        this.summary.dryRun
          ? `Dry run finished: ${total} case(s) checked, ${failed} with errors, ${skipped} cannot be imported.`
          : `Finished: ${created} created, ${updated} updated, ${failed} failed, ${skipped} skipped of ${total}.`,
      );
      if (this.rateLimit) {
        const { limiter, requests, waitedMs } = this.rateLimit;
        const waited = Math.round((limiter.waitedMs - waitedMs) / 1000);
        this.log("info", `TestRail API: ${limiter.requests - requests} request(s)${waited > 0 ? `, ${waited}s spent waiting for the rate limit` : ""}.`);
      }
      this.emitSummary();
      await this.flush();
    }
  }

  private async work() {
    const profile = this.profile;
    const log = (level: "info" | "warn", message: string, caseId?: string) => this.log(level, message, caseId);
    this.phase(profile.source === "csv" ? "Reading the CSV file" : "Connecting to TestRail");
    if (profile.source === "testrail") {
      const perMinute = testRailRequestsPerMinute(profile.testrail.connection);
      if (perMinute === null) {
        this.log("info", "TestRail rate limit: off.");
      } else {
        const limiter = sharedRateLimiter(profile.testrail.connection.endpoint, perMinute);
        this.rateLimit = { limiter, requests: limiter.requests, waitedMs: limiter.waitedMs };
        this.log("info", `TestRail rate limit: ${perMinute} requests per minute, shared by everything this tool sends to that TestRail instance.`);
      }
    }
    const source = await prepareSource(profile, this.deps, log);

    this.phase("Connecting to Allure TestOps");
    const projectId = requireTestOpsProject(profile);
    const testops = new TestOpsClient(profile.testops.connection);
    const project = await testops.project(projectId);
    this.log("info", `Target project: ${project.name} (#${project.id}).`);
    const targets = new TargetResolver(testops, projectId, (level, message) => this.log(level, message));

    this.checkCancelled();
    this.phase(`Reading test cases from ${source.name}`);
    const cases = await source.readCases(log, () => this.cancelled);
    this.summary.counters.total = cases.length;
    this.log("info", `${cases.length} test case(s) to migrate.`);
    this.emitSummary();

    if (this.summary.dryRun) {
      await this.dryRun(cases, source, testops);
      return;
    }

    this.checkCancelled();
    this.phase("Preparing custom fields and tree");
    await this.prepareStructure(testops, targets, projectId);

    this.checkCancelled();
    this.phase("Migrating test cases");
    const writer = new TestOpsWriter(profile, testops, source.assets, targets, projectId);
    const casesByKey = new Map(cases.map((c) => [c.key, c]));
    const migratedKeys = new Set<string>();
    const relink = new Set<string>();

    await pool(cases, profile.options.concurrency, async (testCase) => {
      if (this.cancelled) {
        return;
      }
      const ok = await this.migrateOne(testCase, source, writer);
      migratedKeys.add(testCase.key);
      if (ok && ok.linkedCaseIds.some((id) => casesByKey.has(id) && !migratedKeys.has(id))) {
        relink.add(testCase.key);
      }
    });
    targets.reportMissingOwners();
    this.checkCancelled();

    if (relink.size > 0) {
      this.phase(`Updating links in ${relink.size} case(s) that point to cases migrated later`);
      await pool([...relink], profile.options.concurrency, async (key) => {
        const { planned, linkedCaseIds } = source.transform(casesByKey.get(key)!);
        try {
          await writer.writeCase(planned, linkedCaseIds, (level, message) => this.log(level, message, key));
        } catch (error) {
          this.log("warn", `Links were not updated: ${errorMessage(error)}`, key);
        }
      });
    }
  }

  private async migrateOne(testCase: SourceCase, source: PreparedSource, writer: TestOpsWriter) {
    try {
      const result = source.transform(testCase);
      result.planned.notes.forEach((note) => this.log("warn", note, testCase.key));
      const written = await writer.writeCase(result.planned, result.linkedCaseIds, (level, message) => this.log(level, message, testCase.key));
      this.summary.counters[written.created ? "created" : "updated"] += 1;
      this.log("info", `${written.created ? "Created" : "Updated"} "${result.planned.name}"`, testCase.key, written.testCaseId);
      return result;
    } catch (error) {
      if (error instanceof CaseSkipped) {
        this.summary.counters.skipped += 1;
        this.log("warn", error.message, testCase.key);
        return null;
      }
      this.summary.counters.failed += 1;
      this.log("error", `Failed "${testCase.title}": ${errorMessage(error)}`, testCase.key);
      return null;
    } finally {
      this.summary.counters.processed += 1;
      this.emitSummary();
    }
  }

  private async dryRun(cases: SourceCase[], source: PreparedSource, testops: TestOpsClient) {
    this.phase("Checking conversion");
    const fieldValues = new Map<string, Set<string>>();
    const layers = new Map<string, number>();
    const statuses = new Map<string, number>();
    const owners = new Map<string, number>();
    const roles = new Map<string, number>();
    const sharedSteps = new Set<number>();
    let attachments = 0;
    let issuesWithoutIntegration = 0;
    const count = (map: Map<string, number>, key: string | null) => key && map.set(key, (map.get(key) ?? 0) + 1);

    for (const testCase of cases) {
      this.checkCancelled();
      try {
        const { planned } = source.transform(testCase);
        planned.notes.forEach((note) => this.log("warn", note, testCase.key));
        for (const [name, values] of Object.entries(planned.customFields)) {
          const set = fieldValues.get(name) ?? new Set<string>();
          values.forEach((value) => set.add(value));
          fieldValues.set(name, set);
        }
        count(layers, planned.layer);
        count(statuses, planned.status);
        count(owners, planned.owner);
        planned.members.forEach((member) => {
          count(owners, member.name);
          count(roles, member.role);
        });
        planned.scenario.forEach((step) => step.type === "shared" && sharedSteps.add(step.sourceId));
        attachments += planned.attachments.length;
        issuesWithoutIntegration += planned.issues.filter((issue) => issue.integrationId === null).length;
      } catch (error) {
        if (error instanceof CaseSkipped) {
          this.summary.counters.skipped += 1;
          this.log("warn", error.message, testCase.key);
          this.summary.counters.processed += 1;
          continue;
        }
        this.summary.counters.failed += 1;
        this.log("error", `Cannot convert "${testCase.title}": ${errorMessage(error)}`, testCase.key);
      }
      this.summary.counters.processed += 1;
      if (this.summary.counters.processed % 50 === 0) {
        this.emitSummary();
      }
    }

    this.phase("Checking the Allure TestOps project");
    const target = await discoverTestOps(this.profile, testops);
    target.warnings.forEach((warning) => this.log("warn", warning));
    for (const [name, values] of fieldValues) {
      const field = target.customFields.find((f) => f.name === name);
      if (!field) {
        this.log("info", `Custom field "${name}" will be created with ${values.size} value(s).`);
        continue;
      }
      if (!field.inProject) {
        this.log("info", `Custom field "${name}" exists and will be added to the project.`);
      }
      const existing = new Set((await testops.customFieldValues(field.id).catch(() => [])).map((v) => v.name));
      const added = [...values].filter((value) => !existing.has(value));
      if (added.length > 0) {
        this.log("info", `Custom field "${name}": ${added.length} new value(s), e.g. ${added.slice(0, 5).map((v) => `"${v}"`).join(", ")}.`);
      }
    }
    for (const [name, total] of layers) {
      if (!target.layers.some((layer) => layer.name.toLowerCase() === name.toLowerCase())) {
        this.log("info", `Test layer "${name}" will be created (${total} case(s)).`);
      }
    }
    for (const [name, total] of statuses) {
      if (!target.statuses.some((status) => status.name.toLowerCase() === name.toLowerCase())) {
        this.log("warn", `Status "${name}" does not exist; ${total} case(s) keep the default status.`);
      }
    }
    if (target.users) {
      for (const [name, total] of owners) {
        if (!target.users.some((user) => user.username === name)) {
          this.log("warn", `"${name}" is not an Allure TestOps user; ${total} case(s) would miss this owner or member.`);
        }
      }
    } else if (owners.size > 0) {
      this.log("info", "The token cannot list users, so owners are not checked in advance.");
    }
    for (const [name, total] of roles) {
      if (!target.roles.some((role) => role.name.toLowerCase() === name.toLowerCase())) {
        this.log("warn", `Role "${name}" does not exist in Allure TestOps; ${total} member(s) would be skipped.`);
      }
    }
    if (issuesWithoutIntegration > 0) {
      this.log("warn", `${issuesWithoutIntegration} issue link(s) have no issue tracker integration and will be skipped.`);
    }
    const structureFields = [this.profile.structure.suiteField, ...this.profile.structure.levels].filter(Boolean);
    if (this.profile.structure.createTree && structureFields.length > 0) {
      const exists = target.trees.some((tree) => tree.name === this.profile.structure.treeName);
      this.log("info", exists ? `Tree "${this.profile.structure.treeName}" already exists and is kept.` : `Tree "${this.profile.structure.treeName}" will be created.`);
    }
    if (source.testrail) {
      this.log("info", `${sharedSteps.size} shared step(s) and ${attachments} inline attachment(s) are referenced; attachments of cases are migrated too.`);
      // One attachment listing per case, one download per attachment, one read per shared step.
      const requests = cases.length + attachments + sharedSteps.size;
      const perMinute = testRailRequestsPerMinute(this.profile.testrail.connection);
      this.log(
        "info",
        perMinute === null
          ? `The migration needs at least ${requests} more TestRail request(s).`
          : `The migration needs at least ${requests} more TestRail request(s): about ${Math.max(1, Math.ceil(requests / perMinute))} minute(s) or more at ${perMinute} requests per minute.`,
      );
    }
    this.emitSummary();
  }

  /** Creates the structure custom fields up front and the tree built from them. */
  private async prepareStructure(testops: TestOpsClient, targets: TargetResolver, projectId: number) {
    const structure = this.profile.structure;
    const names = [structure.suiteField, ...structure.levels].filter((name): name is string => Boolean(name));
    const unique = [...new Set(names)];
    const fields = [];
    for (const name of unique) {
      fields.push(await targets.customField(name));
    }
    if (!structure.createTree || fields.length === 0) {
      return;
    }
    try {
      const trees = await testops.trees(projectId);
      const existing = trees.find((tree) => tree.name === structure.treeName);
      if (existing) {
        this.log("info", `Tree "${structure.treeName}" already exists; it is left as is.`);
        return;
      }
      await testops.createTree(projectId, structure.treeName, fields.map((field) => field.id));
      this.log("info", `Created tree "${structure.treeName}": ${fields.map((field) => field.name).join(" → ")}.`);
    } catch (error) {
      this.log("warn", `The tree was not created: ${errorMessage(error)}. You can create it in the project settings.`);
    }
  }
}

async function pool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await worker(item);
    }
  });
  await Promise.all(lanes);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Keeps track of runs; at most one active run per profile. */
export class RunManager {
  private readonly active = new Map<string, Run>();

  constructor(
    private readonly store: RunStore,
    private readonly deps: SourceDeps,
  ) {}

  start(profile: Profile, dryRun: boolean): RunSummary {
    if (this.active.has(profile.id)) {
      throw new Error("A migration for this profile is already running.");
    }
    const run = new Run(profile, dryRun, this.store, this.deps);
    this.active.set(profile.id, run);
    void run.execute().finally(() => {
      if (this.active.get(profile.id) === run) {
        this.active.delete(profile.id);
      }
    });
    return run.summary;
  }

  activeRun(profileId: string): Run | undefined {
    return this.active.get(profileId);
  }

  isActive(profileId: string, runId: string): boolean {
    return this.active.get(profileId)?.summary.id === runId;
  }

  cancel(profileId: string): boolean {
    const run = this.active.get(profileId);
    run?.cancel();
    return run !== undefined;
  }
}
