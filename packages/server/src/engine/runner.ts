import { randomUUID } from "node:crypto";
import {
  runContext,
  testRailRequestsPerMinute,
  type LogLevel,
  type PlannedCase,
  type PlannedNote,
  type PlannedStep,
  type Profile,
  type RunLogEntry,
  type RunSummary,
} from "@atm/shared";
import { sharedRateLimiter, type RateLimiter } from "../http/rateLimiter.js";
import { TestOpsClient } from "../testops/client.js";
import { discoverTestOps, requireTestOpsProject } from "../testops/discovery.js";
import type { RunStore } from "../storage/runs.js";
import { CaseSkipped } from "./errors.js";
import { explain, fieldFor, isTransient, KnownProblem, OperationFailed, ProblemCollector, serviceOf, type ProblemInput } from "./problems.js";
import type { RetryInfo } from "../http/httpClient.js";
import { TargetResolver } from "./targets.js";
import { caseLabel, prepareSource, type PreparedSource, type SourceCase, type SourceDeps } from "./sources.js";
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
  private readonly problems = new ProblemCollector();
  /** Cases that failed on the server side and get a second attempt at the end. */
  private readonly retried = new Set<string>();

  constructor(
    private readonly profile: Profile,
    dryRun: boolean,
    private readonly store: RunStore,
    private readonly deps: RunDeps,
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
      context: runContext(profile, sourceLabelOf(profile)),
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  cancel() {
    this.cancelled = true;
    this.log("warn", `Cancellation requested during "${this.summary.phase}"; stopping after the current step.`);
  }

  private checkCancelled() {
    if (this.cancelled) {
      throw new CancelledError("Cancelled");
    }
  }

  log(level: LogLevel, message: string, caseId?: string, targetId?: number, problem?: string) {
    const entry: RunLogEntry = { seq: ++this.seq, time: new Date().toISOString(), level, message, caseId, targetId, problem };
    this.pendingLog.push(entry);
    this.listeners.forEach((listener) => listener({ type: "log", entry }));
    this.flushSoon();
  }

  /**
   * Records a problem for a case. Errors are logged for every case; a warning is logged the first time
   * only, the Problems list counts the rest.
   */
  private report(level: "warn" | "error", message: string, problem: ProblemInput, testCase?: SourceCase) {
    const entry = this.problems.report({ ...problem, level: level === "error" ? "error" : problem.level }, testCase ? caseLabel(testCase) : undefined);
    if (level === "error" || entry.count === 1) {
      this.log(level, message, testCase?.key, undefined, entry.key);
    }
  }

  private noteProblem(note: PlannedNote): ProblemInput {
    return {
      key: `${note.code}:${note.fix?.field ?? ""}`,
      code: note.code,
      level: "warn",
      title: note.summary ?? note.text,
      hint: note.hint ?? "",
      fix: note.fix,
    };
  }

  private emitSummary() {
    this.summary.problems = this.problems.list();
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
    let stoppedIn = "";
    try {
      await this.work();
      stoppedIn = this.summary.phase;
      this.summary.status = this.cancelled ? "cancelled" : "finished";
      this.summary.phase = this.cancelled ? "Cancelled" : "Done";
    } catch (error) {
      stoppedIn = this.summary.phase;
      if (error instanceof CancelledError) {
        this.summary.status = "cancelled";
        this.summary.phase = "Cancelled";
      } else {
        this.summary.status = "failed";
        const explanation =
          error instanceof KnownProblem
            ? error.explanation
            : explain(error, error instanceof OperationFailed ? error.operation : "read the project", {
                profile: this.profile,
                service: serviceOf(error, this.profile),
              });
        this.summary.error =
          explanation.detail && explanation.detail !== explanation.title
            ? `${explanation.title} Server message: "${explanation.detail}".`
            : explanation.title;
        this.summary.errorHint = explanation.hint;
        this.summary.errorFix = explanation.fix;
        this.summary.phase = "Failed";
        this.log("error", `Stopped during "${stoppedIn}": ${this.summary.error} ${explanation.hint}`);
      }
    } finally {
      this.summary.finishedAt = new Date().toISOString();
      this.log(this.summary.status === "finished" ? "info" : "warn", this.closingMessage(stoppedIn));
      if (this.rateLimit) {
        const { limiter, requests, waitedMs } = this.rateLimit;
        const waited = Math.round((limiter.waitedMs - waitedMs) / 1000);
        this.log("info", `TestRail API: ${limiter.requests - requests} request(s)${waited > 0 ? `, ${waited}s spent waiting for the rate limit` : ""}.`);
      }
      this.emitSummary();
      await this.flush();
    }
  }

  /** The last line of the log: what was done, and for a stopped run, where it stopped. */
  private closingMessage(stoppedIn: string): string {
    const { total, processed, created, updated, failed, skipped } = this.summary.counters;
    const notStarted = Math.max(0, total - processed);
    const rest = notStarted > 0 ? `, ${notStarted} not processed` : "";
    if (this.summary.dryRun) {
      const result = `${processed} of ${total} case(s) converted, ${failed} with errors, ${skipped} cannot be imported${rest}`;
      switch (this.summary.status) {
        case "cancelled":
          return `Dry run cancelled during "${stoppedIn}": ${result}. The check is incomplete.`;
        case "failed":
          return `Dry run failed during "${stoppedIn}": ${result}.`;
        default:
          return `Dry run finished: ${result}.`;
      }
    }
    const result = `${created} created, ${updated} updated, ${failed} failed, ${skipped} skipped of ${total}${rest}`;
    switch (this.summary.status) {
      case "cancelled":
        return `Migration cancelled during "${stoppedIn}": ${result}. Run it again to continue; migrated cases are updated, not duplicated.`;
      case "failed":
        return `Migration failed during "${stoppedIn}": ${result}.`;
      default:
        return `Finished: ${result}.`;
    }
  }

  private async work() {
    const profile = this.profile;
    if (profile.source === "csv" && profile.csv.fileId) {
      const file = (await this.deps.files.list().catch(() => [])).find((f) => f.id === profile.csv.fileId);
      if (file) {
        this.summary.context!.sourceLabel = file.name;
      }
    }
    const log = (level: "info" | "warn", message: string, caseId?: string) => this.log(level, message, caseId);
    this.phase(profile.source === "csv" ? "Reading the CSV file" : profile.source === "xray" ? "Connecting to Jira and Xray" : "Connecting to TestRail");
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
    const retryLog = (service: string) => (info: RetryInfo) =>
      this.log("warn", `${service}: ${info.url} failed (${info.reason}); retry ${info.attempt} of ${info.of} in ${Math.max(1, Math.round(info.delayMs / 1000))}s.`);
    const source = await prepareSource(profile, this.deps, log, retryLog(profile.source === "xray" ? "Jira or Xray" : "TestRail"));

    this.phase("Connecting to Allure TestOps");
    const projectId = requireTestOpsProject(profile);
    const testops = new TestOpsClient(profile.testops.connection, undefined, retryLog("Allure TestOps"));
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
    const retry: SourceCase[] = [];

    await pool(cases, profile.options.concurrency, async (testCase) => {
      if (this.cancelled) {
        return;
      }
      const ok = await this.migrateOne(testCase, source, writer, retry);
      migratedKeys.add(testCase.key);
      if (ok && ok.linkedCaseIds.some((id) => casesByKey.has(id) && !migratedKeys.has(id))) {
        relink.add(testCase.key);
      }
    });
    this.checkCancelled();

    if (retry.length > 0) {
      // Server side failures often pass: try once more, one case at a time, after a pause.
      this.phase(`Trying ${retry.length} case(s) again that failed because of server errors`);
      await new Promise((resolve) => setTimeout(resolve, this.deps.retryPauseMs ?? RETRY_PAUSE_MS));
      for (const testCase of retry) {
        this.checkCancelled();
        const ok = await this.migrateOne(testCase, source, writer, null);
        if (ok && ok.linkedCaseIds.some((id) => casesByKey.has(id))) {
          relink.add(testCase.key);
        }
      }
    }

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

  /**
   * `retryLater`: collects cases that failed on the server side instead of reporting them; null on the last attempt.
   * A case counts as processed once, on its first attempt.
   */
  private async migrateOne(testCase: SourceCase, source: PreparedSource, writer: TestOpsWriter, retryLater: SourceCase[] | null) {
    const firstAttempt = retryLater !== null || !this.retried.has(testCase.key);
    try {
      const where = caseLabel(testCase);
      const result = source.transform(testCase);
      result.planned.notes.forEach((note) => this.report("warn", `${where}: ${note.text}`, this.noteProblem(note), testCase));
      const written = await writer.writeCase(result.planned, result.linkedCaseIds, (level, message, problem) =>
        problem ? this.report(level === "error" ? "error" : "warn", `${where}: ${message}`, problem, testCase) : this.log(level, `${where}: ${message}`, testCase.key),
      );
      this.summary.counters[written.created ? "created" : "updated"] += 1;
      const again = this.retried.has(testCase.key) ? " on the second attempt" : "";
      this.log("info", `${where}: ${written.created ? "created" : "updated"} "${result.planned.name}"${again}`, testCase.key, written.testCaseId);
      return result;
    } catch (error) {
      if (error instanceof CaseSkipped) {
        this.summary.counters.skipped += 1;
        this.report("warn", error.message, this.noteProblem(error.note), testCase);
        return null;
      }
      if (retryLater && isTransient(error)) {
        retryLater.push(testCase);
        this.retried.add(testCase.key);
        this.log("warn", `${caseLabel(testCase)}: "${testCase.title}" failed because of a server error (${errorMessage(error)}); it is tried again at the end of the run.`, testCase.key);
        return null;
      }
      this.summary.counters.failed += 1;
      const explanation =
        error instanceof KnownProblem
          ? error.explanation
          : explain(error, error instanceof OperationFailed ? error.operation : "update the test case", {
              profile: this.profile,
              service: serviceOf(error, this.profile),
            });
      this.report(
        "error",
        `${caseLabel(testCase)}: failed "${testCase.title}": ${explanation.title}${explanation.detail ? ` ${explanation.detail}` : ""}`,
        { ...explanation, code: "failed", level: "error" },
        testCase,
      );
      return null;
    } finally {
      if (firstAttempt) {
        this.summary.counters.processed += 1;
      }
      this.emitSummary();
    }
  }

  private async dryRun(cases: SourceCase[], source: PreparedSource, testops: TestOpsClient) {
    this.phase("Checking conversion");
    const fieldValues = new Map<string, Set<string>>();
    // Value -> cases using it, so missing objects in Allure TestOps can be reported per case.
    const layers = new Map<string, SourceCase[]>();
    const statuses = new Map<string, SourceCase[]>();
    const owners = new Map<string, SourceCase[]>();
    const members = new Map<string, SourceCase[]>();
    const roles = new Map<string, SourceCase[]>();
    const sharedSteps = new Set<number>();
    let attachments = 0;
    const count = (map: Map<string, SourceCase[]>, key: string | null, testCase: SourceCase) => {
      if (key) {
        map.set(key, [...(map.get(key) ?? []), testCase]);
      }
    };

    for (const testCase of cases) {
      this.checkCancelled();
      try {
        const where = caseLabel(testCase);
        const { planned } = source.transform(testCase);
        planned.notes.forEach((note) => this.report("warn", `${where}: ${note.text}`, this.noteProblem(note), testCase));
        this.log("info", `${where}: "${planned.name}" ${describePlan(planned)}`, testCase.key);
        for (const [name, values] of Object.entries(planned.customFields)) {
          const set = fieldValues.get(name) ?? new Set<string>();
          values.forEach((value) => set.add(value));
          fieldValues.set(name, set);
        }
        count(layers, planned.layer, testCase);
        count(statuses, planned.status, testCase);
        count(owners, planned.owner, testCase);
        planned.members.forEach((member) => {
          count(members, member.name, testCase);
          count(roles, member.role, testCase);
        });
        planned.scenario.forEach((step) => step.type === "shared" && sharedSteps.add(step.sourceId));
        attachments += planned.attachments.length;
      } catch (error) {
        if (error instanceof CaseSkipped) {
          this.summary.counters.skipped += 1;
          this.report("warn", error.message, this.noteProblem(error.note), testCase);
          this.summary.counters.processed += 1;
          continue;
        }
        this.summary.counters.failed += 1;
        this.report(
          "error",
          `${caseLabel(testCase)}: cannot convert "${testCase.title}": ${errorMessage(error)}`,
          {
            key: "convert-failed",
            code: "convert-failed",
            level: "error",
            title: "Some cases could not be converted.",
            hint: "Open an affected case on the Preview step to see what it contains. If the reason is unclear, download the log and send it to support.",
            detail: errorMessage(error),
          },
          testCase,
        );
      }
      this.summary.counters.processed += 1;
      if (this.summary.counters.processed % 50 === 0) {
        this.emitSummary();
      }
    }

    this.phase("Checking the Allure TestOps project");
    const target = await discoverTestOps(this.profile, testops);
    target.warnings.forEach((warning) => this.log("warn", warning));
    const testKeyIntegration = this.profile.options.testKeyIntegrationId;
    if (testKeyIntegration) {
      const integration = target.integrations.find((i) => i.id === testKeyIntegration);
      if (integration) {
        this.log("info", `Test keys are written through the integration "${integration.name}".`);
      } else {
        this.report("warn", `Integration #${testKeyIntegration} for test keys is not enabled in the project; test keys would not be set.`, {
          key: "test-key-integration-missing",
          code: "test-key-integration-missing",
          level: "warn",
          title: "The integration chosen for test keys is not enabled in the Allure TestOps project.",
          hint: "Choose an enabled integration for test keys on the Options step, or turn test keys off.",
          fix: { step: "options" },
        });
      }
    }
    for (const [name, values] of fieldValues) {
      this.checkCancelled();
      const field = target.customFields.find((f) => f.name === name);
      if (!field) {
        this.log("info", `Custom field "${name}" will be created with ${values.size} value(s).`);
        continue;
      }
      if (!field.inProject) {
        this.log("info", `Custom field "${name}" exists and will be added to the project.`);
      }
      // Look the values up one by one: global fields can hold many thousands of values.
      const checked = [...values].slice(0, VALUE_CHECK_LIMIT);
      this.log("info", `Custom field "${name}": checking ${checked.length} of ${values.size} value(s) from the source...`);
      const existing = await testops.existingCustomFieldValues(field.id, checked).catch((error) => {
        const explanation = explain(error, "read the project", { profile: this.profile, service: "Allure TestOps" });
        this.report("warn", `Custom field "${name}": values could not be checked: ${explanation.title}`, {
          ...explanation,
          key: `cf-check:${name}`,
          code: "cf-check-failed",
          level: "warn",
          title: `Values of custom field "${name}" could not be checked in Allure TestOps.`,
        });
        return null;
      });
      if (existing) {
        const added = checked.filter((value) => !existing.has(value));
        this.log(
          "info",
          added.length > 0
            ? `Custom field "${name}": ${added.length} new value(s), e.g. ${added.slice(0, 5).map((v) => `"${v}"`).join(", ")}.`
            : `Custom field "${name}": all checked values exist.`,
        );
      }
    }
    for (const [name, affected] of layers) {
      if (!target.layers.some((layer) => layer.name.toLowerCase() === name.toLowerCase())) {
        this.log("info", `Test layer "${name}" will be created (${affected.length} case(s)).`);
      }
    }
    const fieldOf = (kind: string) => fieldFor(this.profile, (t) => t.kind === kind);
    for (const [name, affected] of statuses) {
      if (!target.statuses.some((status) => status.name.toLowerCase() === name.toLowerCase())) {
        for (const testCase of affected) {
          this.report("warn", `Status "${name}" does not exist in Allure TestOps; ${affected.length} case(s) would keep the default status.`, {
            key: `status:${name}`,
            code: "status-missing",
            level: "warn",
            title: `Status "${name}" does not exist in Allure TestOps; these cases would keep the default status.`,
            hint: "Statuses belong to the project's workflow and are not created by the migration. Map this value to an existing status in the value mapping of the status field, or add the status to the workflow in Allure TestOps.",
            fix: { step: "fields", field: fieldOf("status") },
          }, testCase);
        }
      }
    }
    if (target.users) {
      // Same lookup as the migration: by user name, or by email.
      const known = new Set(target.users.flatMap((user) => [user.username, ...(user.email ? [user.email.toLowerCase()] : [])]));
      for (const [map, isOwner] of [[owners, true], [members, false]] as const) {
        for (const [name, affected] of map) {
          if (known.has(name) || known.has(name.toLowerCase())) {
            continue;
          }
          for (const testCase of affected) {
            this.report("warn", `"${name}" is not an Allure TestOps user; ${affected.length} case(s) would miss this ${isOwner ? "owner" : "member"}.`, {
              key: `user:${name}`,
              code: "user-missing",
              level: "warn",
              title: `"${name}" is not an Allure TestOps user, so it would not be set as ${isOwner ? "owner" : "member"}.`,
              hint: "Map the source user to an existing Allure TestOps user name in the value mapping of the field, or create the user in Allure TestOps first.",
              fix: { step: "fields", field: fieldOf(isOwner ? "owner" : "role") },
            }, testCase);
          }
        }
      }
    } else if (owners.size + members.size > 0) {
      this.log("info", "The token cannot list users, so owners and members are not checked in advance.");
    }
    for (const [name, affected] of roles) {
      if (!target.roles.some((role) => role.name.toLowerCase() === name.toLowerCase())) {
        for (const testCase of affected) {
          this.report("warn", `Role "${name}" does not exist in Allure TestOps; ${affected.length} case(s) would miss these members.`, {
            key: `role:${name}`,
            code: "role-missing",
            level: "warn",
            title: `Role "${name}" does not exist in Allure TestOps, so members with it would not be set.`,
            hint: "Choose an existing role for the column, or create the role in Allure TestOps (Administration, Roles) first.",
            fix: { step: "fields", field: fieldFor(this.profile, (t) => t.kind === "role" && t.role === name) },
          }, testCase);
        }
      }
    }
    if (this.profile.structure.createTree && this.structureFieldNames().length > 0) {
      const exists = target.trees.some((tree) => tree.name === this.profile.structure.treeName);
      this.log("info", exists ? `Tree "${this.profile.structure.treeName}" already exists and is kept.` : `Tree "${this.profile.structure.treeName}" will be created.`);
    }
    if (this.profile.source === "xray") {
      this.log(
        "info",
        `${sharedSteps.size} called test(s) ${this.profile.options.migrateSharedSteps ? "become shared steps" : "are copied into the tests that call them"}; ${attachments} image(s) in Jira text; files of steps and issues are migrated too.`,
      );
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

  /** Custom fields of the suite and section levels; none for a CSV file without a section path column. */
  private structureFieldNames(): string[] {
    const structure = this.profile.structure;
    if (this.profile.source === "csv" && !this.profile.csv.pathColumn) {
      return [];
    }
    return [...new Set([structure.suiteField, ...structure.levels].filter((name): name is string => Boolean(name)))];
  }

  /** Creates the structure custom fields up front and the tree built from them. */
  private async prepareStructure(testops: TestOpsClient, targets: TargetResolver, projectId: number) {
    const structure = this.profile.structure;
    const unique = this.structureFieldNames();
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
      const explanation = explain(error, "create the tree", { profile: this.profile, service: "Allure TestOps" });
      this.report("warn", `The tree "${structure.treeName}" was not created: ${explanation.title}`, {
        ...explanation,
        key: "tree-not-created",
        code: "tree-not-created",
        level: "warn",
        title: `The tree "${structure.treeName}" was not created: ${explanation.title}`,
        hint: `${explanation.hint} The cases are migrated anyway; you can create the tree in the project settings of Allure TestOps (Trees) from the fields ${fields.map((field) => `"${field.name}"`).join(", ")}, or turn tree creation off on the ${this.profile.source === "csv" ? "Sections" : "Suites & sections"} step.`,
        fix: { step: "structure" },
      });
    }
  }
}

/** Values per custom field the dry run looks up in Allure TestOps. */
const VALUE_CHECK_LIMIT = 200;

/** The source of a run for people, until the run knows better (e.g. the file name). */
function sourceLabelOf(profile: Profile): string {
  switch (profile.source) {
    case "csv":
      return "CSV file";
    case "xray": {
      const jql = profile.xray.scope.jql.trim();
      return `Xray project ${profile.xray.scope.projectKey || "?"}${jql ? ` (${jql})` : ""}`;
    }
    default:
      return `TestRail project #${profile.testrail.scope.projectId ?? "?"}`;
  }
}
/** Pause before the second attempt, so an overloaded server can recover. */
const RETRY_PAUSE_MS = 5_000;

/** Short summary of a planned case for the dry run log. */
function describePlan(planned: PlannedCase): string {
  const count = (steps: PlannedStep[]): number => steps.reduce((sum, s) => sum + 1 + (s.type === "step" ? count(s.steps ?? []) : 0), 0);
  const parts = [`${count(planned.scenario)} step(s)`];
  const fieldValues = Object.values(planned.customFields).reduce((sum, v) => sum + v.length, 0);
  if (fieldValues) parts.push(`${fieldValues} custom field value(s)`);
  if (planned.tags.length > 1) parts.push(`${planned.tags.length - 1} tag(s)`);
  if (planned.issues.length) parts.push(`${planned.issues.length} issue(s)`);
  if (planned.testKeys?.length) parts.push(`test key ${planned.testKeys.map((k) => k.key).join(", ")}`);
  if (planned.links.length) parts.push(`${planned.links.length} link(s)`);
  if (planned.owner) parts.push(`owner ${planned.owner}`);
  if (planned.members.length) parts.push(`${planned.members.length} member(s)`);
  if (planned.attachments.length) parts.push(`${planned.attachments.length} inline attachment(s)`);
  return parts.join(", ") + ".";
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
export interface RunDeps extends SourceDeps {
  /** Pause before the second attempt of cases that failed on the server side; tests shorten it. */
  retryPauseMs?: number;
}

export class RunManager {
  private readonly active = new Map<string, Run>();

  constructor(
    private readonly store: RunStore,
    private readonly deps: RunDeps,
  ) {}

  start(profile: Profile, dryRun: boolean): RunSummary {
    if (this.active.has(profile.id)) {
      throw new Error("A migration for this profile is already running.");
    }
    if (!profile.options.migrationTagPrefix.trim()) {
      throw new Error("Enter the migration tag prefix on the Options step: reruns find migrated cases by it.");
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
