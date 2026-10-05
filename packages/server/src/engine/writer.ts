import type { PlannedAttachment, PlannedCase, PlannedStep, Profile } from "@atm/shared";
import { resolveAttachmentImages, resolveCaseLinks } from "../convert/markup.js";
import type { TestOpsClient, ToAttachment, ToCustomFieldValue, ToScenarioStep, ToTestCase, ToTestCasePatch } from "../testops/client.js";
import { contentTypeFor, safeFileName } from "./attachments.js";
import type { CaseAttachments, SourceAssets } from "./assets.js";
import { explain, fieldFor, KnownProblem, OperationFailed, type Operation, type ProblemInput } from "./problems.js";
import type { TargetResolver } from "./targets.js";

/** Log line from the writer; with a problem it also lands in the run's problem list. */
export type WriteLog = (level: "info" | "warn" | "error", message: string, problem?: ProblemInput) => void;

export interface WriteResult {
  testCaseId: number;
  created: boolean;
}

interface Uploader {
  existing(): Promise<ToAttachment[]>;
  upload(name: string, data: Buffer, contentType: string): Promise<ToAttachment>;
}

/**
 * Writes planned cases and shared steps to Allure TestOps. Every write is idempotent:
 * cases are found by their migration tag, shared steps by name, attachments by file name.
 */
export class TestOpsWriter {
  /** Source case key -> Allure TestOps test case id, filled as cases are migrated. */
  private readonly migrated = new Map<string, number>();
  /** Source case keys whose Allure TestOps case this run created, also when a later step failed. */
  private readonly created = new Set<string>();
  private readonly sharedSteps = new Map<number, Promise<number | null>>();

  constructor(
    private readonly profile: Profile,
    private readonly testops: TestOpsClient,
    private readonly assets: SourceAssets,
    private readonly targets: TargetResolver,
    private readonly projectId: number,
  ) {}

  private get tagPrefix(): string {
    return this.profile.options.migrationTagPrefix;
  }

  /** Allure TestOps URL for a source case that is already migrated (in this run or before). */
  async testCaseUrlFor(caseId: string): Promise<string | null> {
    let id = this.migrated.get(caseId);
    if (id === undefined) {
      const found = await this.testops.findTestCaseByTag(this.projectId, `${this.tagPrefix}:${caseId}`).catch(() => null);
      if (!found) {
        return null;
      }
      id = found.id;
      this.migrated.set(caseId, id);
    }
    return this.testops.testCaseUrl(this.projectId, id);
  }

  private async resolveLinks(text: string, linkedCaseIds: string[]): Promise<string> {
    if (!text || linkedCaseIds.length === 0) {
      return text;
    }
    const urls = new Map<string, string | null>();
    for (const id of linkedCaseIds) {
      urls.set(id, await this.testCaseUrlFor(id));
    }
    return resolveCaseLinks(text, (id) => urls.get(String(id)) ?? null);
  }

  /** Runs one call to Allure TestOps and remembers what it was for, so a failure can be explained. */
  private async op<T>(operation: Operation, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw error instanceof OperationFailed || error instanceof KnownProblem ? error : new OperationFailed(operation, error);
    }
  }

  private explainFailure(error: unknown, operation: Operation): ProblemInput {
    const e = explain(error, operation, { profile: this.profile, service: "Allure TestOps" });
    return { ...e, code: "failed", level: "warn" };
  }

  /** The case to update: the given Allure TestOps id, else the one carrying the migration tag. */
  private async findTarget(planned: PlannedCase): Promise<ToTestCase | null> {
    if (planned.allureId) {
      const byId = await this.testops.getTestCase(planned.allureId).catch(() => null);
      if (!byId || byId.projectId !== this.projectId) {
        const column = fieldFor(this.profile, (t) => t.kind === "allureId");
        throw new KnownProblem({
          key: "allure-id-missing",
          title: `Allure TestOps test case #${planned.allureId} does not exist in project #${this.projectId}.`,
          hint: "The file refers to cases of another project, or to deleted cases. To create new cases instead, map this column to \"Case id (for reruns)\".",
          fix: { step: "fields", field: column },
        });
      }
      return byId;
    }
    // A second attempt after a failure: the case may exist without its tag yet.
    const known = this.migrated.get(planned.sourceId);
    if (known !== undefined) {
      const byKnownId = await this.testops.getTestCase(known).catch(() => null);
      if (byKnownId && !byKnownId.deleted) {
        return byKnownId;
      }
    }
    return this.op("find the test case", () => this.testops.findTestCaseByTag(this.projectId, `${this.tagPrefix}:${planned.sourceId}`));
  }

  async writeCase(planned: PlannedCase, linkedCaseIds: string[], log: WriteLog): Promise<WriteResult> {
    const existing = await this.findTarget(planned);
    const testCase = existing ?? (await this.op("create the test case", () => this.testops.createTestCase(this.projectId, planned.name)));
    this.migrated.set(planned.sourceId, testCase.id);
    if (!existing) {
      this.created.add(planned.sourceId);
    }

    // Tags first: they make the case findable on rerun even if a later step fails.
    await this.op("set tags", () => this.testops.setTags(testCase.id, planned.tags));

    const source = this.assets.attachments(planned.sourceId);
    const uploader: Uploader = {
      existing: () => this.testops.testCaseAttachments(testCase.id),
      upload: (name, data, type) => this.testops.uploadTestCaseAttachment(testCase.id, name, data, type),
    };
    const uploaded = await this.uploadAll(this.collectAttachments(planned), source, uploader, log);
    if (this.profile.options.migrateAttachments) {
      // Attachments of the case that are not referenced inline.
      for (const attachment of await source.caseAttachments()) {
        await this.upload({ sourceId: String(attachment.id), fileName: "" }, source, uploader, uploaded, log);
      }
    }

    const imageUrl = (sourceId: string) => {
      const attachment = uploaded.get(sourceId);
      return attachment ? `/api/rs/testcase/attachment/${attachment.id}/content` : null;
    };
    const text = async (value: string) => resolveAttachmentImages(await this.resolveLinks(value, linkedCaseIds), imageUrl);

    const patch: ToTestCasePatch = {
      name: planned.name,
      description: await text(planned.description),
      precondition: await text(planned.precondition),
      expectedResult: await text(planned.expectedResult),
      links: planned.links,
    };
    if (planned.layer) {
      try {
        const layer = await this.targets.layer(planned.layer);
        patch.testLayerId = layer.id;
      } catch (error) {
        const problem = this.explainFailure(error, "create a test layer");
        log("warn", `Test layer "${planned.layer}" was not set: ${problem.title}`, {
          ...problem,
          key: `layer:${planned.layer}`,
          code: "layer-not-created",
          title: `Test layer "${planned.layer}" does not exist and could not be created.`,
          hint: `${problem.hint} Or map the value to an existing layer in the value mapping of the layer field.`,
          fix: { step: "fields", field: fieldFor(this.profile, (t) => t.kind === "layer") },
        });
      }
    }
    if (planned.status) {
      const status = await this.targets.status(planned.status);
      if (status) {
        patch.statusId = status.id;
      } else {
        log("warn", `Status "${planned.status}" does not exist; the default status is kept.`, {
          key: `status:${planned.status}`,
          code: "status-missing",
          level: "warn",
          title: `Status "${planned.status}" does not exist in Allure TestOps; these cases keep the default status.`,
          hint: "Statuses belong to the project's workflow and are not created by the migration. Map this value to an existing status in the value mapping of the status field, or add the status to the workflow in Allure TestOps.",
          fix: { step: "fields", field: fieldFor(this.profile, (t) => t.kind === "status") },
        });
      }
    }
    await this.op("update the test case", () => this.testops.updateTestCase(testCase.id, patch));

    await this.op("set custom fields", () => this.writeCustomFields(testCase.id, planned.customFields));

    const issuesByIntegration = planned.issues.filter((issue) => issue.integrationId !== null);
    if (issuesByIntegration.length > 0) {
      await this.op("set issues", () =>
        this.testops.setIssues(
          testCase.id,
          issuesByIntegration.map((issue) => ({ name: issue.key, integrationId: issue.integrationId! })),
        ),
      );
    }

    await this.writeMembers(testCase.id, planned, log);

    if (planned.comments.length > 0) {
      await this.op("add comments", async () => {
        const present = new Set((await this.testops.comments(testCase.id)).map((c) => c.body.trim()));
        for (const comment of planned.comments) {
          const body = await text(comment);
          if (!present.has(body.trim())) {
            await this.testops.addComment(testCase.id, body);
          }
        }
      });
    }

    const steps = await this.scenarioSteps(planned.scenario, uploaded, linkedCaseIds, log);
    await this.op("set the scenario", async () => {
      await this.testops.clearScenario(testCase.id);
      if (steps.length > 0) {
        await this.testops.setScenario(testCase.id, steps);
      }
    });
    return { testCaseId: testCase.id, created: this.created.has(planned.sourceId) };
  }

  private userMissing(name: string, isOwner: boolean, log: WriteLog) {
    const field = fieldFor(this.profile, (t) => (isOwner ? t.kind === "owner" : t.kind === "role"));
    log("warn", `"${name}" is not an Allure TestOps user; ${isOwner ? "the owner" : "this member"} is not set.`, {
      key: `user:${name}`,
      code: "user-missing",
      level: "warn",
      title: `"${name}" is not an Allure TestOps user, so it is not set as ${isOwner ? "owner" : "member"}.`,
      hint: "Map the source user to an existing Allure TestOps user name in the value mapping of the field, or create the user in Allure TestOps and run again.",
      fix: { step: "fields", field },
    });
  }

  private async writeMembers(testCaseId: number, planned: PlannedCase, log: WriteLog): Promise<void> {
    const members: { name: string; role: { id: number }; owner: boolean }[] = [];
    if (planned.owner) {
      const owner = await this.targets.owner(planned.owner);
      if (owner) {
        members.push({ name: owner, role: { id: -1 }, owner: true });
      } else {
        this.userMissing(planned.owner, true, log);
      }
    }
    for (const member of planned.members) {
      const [user, role] = await Promise.all([this.targets.owner(member.name), this.targets.role(member.role)]);
      if (!role) {
        log("warn", `Role "${member.role}" does not exist; members with it are not set.`, {
          key: `role:${member.role}`,
          code: "role-missing",
          level: "warn",
          title: `Role "${member.role}" does not exist in Allure TestOps, so members with it are not set.`,
          hint: "Choose an existing role for the column, or create the role in Allure TestOps (Administration, Roles) and run again.",
          fix: { step: "fields", field: fieldFor(this.profile, (t) => t.kind === "role" && t.role === member.role) },
        });
      } else if (!user) {
        this.userMissing(member.name, false, log);
      } else if (!members.some((m) => m.name === user && m.role.id === role.id)) {
        members.push({ name: user, role: { id: role.id }, owner: false });
      }
    }
    if (members.length === 0) {
      return;
    }
    const body = (list: typeof members) => list.map(({ name, role }) => ({ name, role }));
    try {
      await this.testops.setMembers(testCaseId, body(members));
    } catch {
      // Usually an unknown user; retry one by one so the valid members stay.
      const valid: typeof members = [];
      for (const member of members) {
        try {
          await this.testops.setMembers(testCaseId, body([...valid, member]));
          valid.push(member);
        } catch {
          this.userMissing(member.name, member.owner, log);
        }
      }
    }
  }

  private async writeCustomFields(testCaseId: number, planned: Record<string, string[]>): Promise<void> {
    const names = Object.keys(planned);
    if (names.length === 0) {
      return;
    }
    const values: ToCustomFieldValue[] = [];
    const managed = new Set<number>();
    for (const name of names) {
      const field = await this.targets.customField(name);
      managed.add(field.id);
      for (const value of planned[name] ?? []) {
        values.push({ name: value, customField: { id: field.id, name: field.name } });
      }
    }
    // Keep values of fields the migration does not manage, e.g. set by hand after a previous run.
    const current = await this.testops.getCustomFieldValues(testCaseId).catch(() => []);
    for (const value of current) {
      if (!managed.has(value.customField.id)) {
        values.push({ name: value.name, customField: { id: value.customField.id, name: value.customField.name } });
      }
    }
    await this.testops.setCustomFieldValues(testCaseId, values);
  }

  private collectAttachments(planned: PlannedCase): PlannedAttachment[] {
    return [...planned.attachments, ...stepAttachments(planned.scenario)];
  }

  /** Uploads attachments not yet present; returns planned key -> uploaded attachment. */
  private async uploadAll(attachments: PlannedAttachment[], source: CaseAttachments, uploader: Uploader, log: WriteLog) {
    const uploaded = new Map<string, ToAttachment>();
    for (const attachment of attachments) {
      await this.upload(attachment, source, uploader, uploaded, log);
    }
    return uploaded;
  }

  private existingCache = new WeakMap<Uploader, Promise<ToAttachment[]>>();

  private async upload(
    attachment: PlannedAttachment,
    source: CaseAttachments,
    uploader: Uploader,
    uploaded: Map<string, ToAttachment>,
    log: WriteLog,
  ): Promise<void> {
    const key = attachmentKey(attachment);
    if (uploaded.has(key)) {
      return;
    }
    if (attachment.sourceId !== null && !this.profile.options.migrateAttachments) {
      return;
    }
    try {
      let fileName: string;
      let data: Buffer;
      let contentType: string;
      if (attachment.sourceId === null) {
        fileName = safeFileName(attachment.fileName);
        data = Buffer.from(attachment.content ?? "", "utf8");
        contentType = contentTypeFor(fileName, "text/plain");
      } else {
        const downloaded = await source.download(attachment.sourceId);
        ({ fileName, data, contentType } = downloaded);
      }
      if (!this.existingCache.has(uploader)) {
        this.existingCache.set(uploader, uploader.existing().catch(() => []));
      }
      const known = await this.existingCache.get(uploader)!;
      let target = known.find((a) => a.name === fileName);
      if (!target) {
        target = await this.op("upload attachments", () => uploader.upload(fileName, data, contentType));
        known.push(target);
      }
      uploaded.set(key, target);
    } catch (error) {
      if (attachment.sourceId !== null && !(error instanceof OperationFailed)) {
        // The source could not deliver the file.
        log("warn", message(error), {
          key: "attachment-download",
          code: "attachment-download",
          level: "warn",
          title: "Some attachments could not be downloaded from TestRail.",
          hint: this.assets.attachmentHint ?? "Check the source connection.",
          fix: { step: "connections" },
          detail: message(error),
        });
      } else {
        const problem = this.explainFailure(error, "upload attachments");
        log("warn", `Attachment "${attachment.fileName}" was not uploaded: ${problem.title}`, problem);
      }
    }
  }

  private async scenarioSteps(
    steps: PlannedStep[],
    uploaded: Map<string, ToAttachment>,
    linkedCaseIds: string[],
    log: WriteLog,
  ): Promise<ToScenarioStep[]> {
    const attachmentSteps = (list: PlannedAttachment[]): ToScenarioStep[] =>
      list
        .map((a) => uploaded.get(attachmentKey(a)))
        .filter((a): a is ToAttachment => a !== undefined)
        .map((a) => ({ type: "attachment" as const, attachmentId: a.id }));

    const result: ToScenarioStep[] = [];
    for (const step of steps) {
      if (step.type === "shared") {
        const sharedStepId = await this.sharedStep(step.sourceId, log);
        if (sharedStepId !== null) {
          result.push({ type: "shared", sharedStepId });
        } else {
          result.push({ type: "body", body: `Shared step ${step.sourceId} could not be migrated` });
        }
        continue;
      }
      const nested: ToScenarioStep[] = [...attachmentSteps(step.attachments)];
      if (step.steps && step.steps.length > 0) {
        nested.push(...(await this.scenarioSteps(step.steps, uploaded, linkedCaseIds, log)));
      }
      if (step.data || step.dataAttachments.length > 0) {
        const dataAttachments = attachmentSteps(step.dataAttachments);
        nested.push({
          type: "body",
          body: await this.resolveLinks(step.data ?? "See attachment", linkedCaseIds),
          ...(dataAttachments.length > 0 ? { steps: dataAttachments } : {}),
        });
      }
      const expected: ToScenarioStep[] = [];
      if (step.expected) {
        expected.push({ type: "expected_body", body: await this.resolveLinks(step.expected, linkedCaseIds) });
      }
      expected.push(...attachmentSteps(step.expectedAttachments));
      result.push({
        type: "body",
        body: await this.resolveLinks(step.body || "Untitled step", linkedCaseIds),
        ...(nested.length > 0 ? { steps: nested } : {}),
        ...(expected.length > 0 ? { expectedResultSteps: expected } : {}),
      });
    }
    return result;
  }

  /** Migrates a TestRail shared step once per run; returns the Allure TestOps shared step id. */
  sharedStep(sourceId: number, log: WriteLog): Promise<number | null> {
    let pending = this.sharedSteps.get(sourceId);
    if (!pending) {
      pending = this.migrateSharedStep(sourceId, log).catch((error) => {
        const problem = this.explainFailure(error, "migrate a shared step");
        log("warn", `Shared step ${sourceId} was not migrated: ${problem.title}`, {
          ...problem,
          hint: `${problem.hint} Cases that use it get a step saying the shared step could not be migrated; turning off "Migrate shared steps" on the Options step copies its steps into each case instead.`,
          fix: problem.fix ?? { step: "options" },
        });
        return null;
      });
      this.sharedSteps.set(sourceId, pending);
    }
    return pending;
  }

  private async migrateSharedStep(sourceId: number, log: WriteLog): Promise<number> {
    const shared = await this.assets.sharedStep(sourceId);
    // Same naming as the previous migration tool, so earlier migrated shared steps are reused.
    const name = `${shared.title} [${shared.id}]`;
    const target = (await this.testops.findSharedStep(this.projectId, name)) ?? (await this.testops.createSharedStep(this.projectId, name));
    const planned = shared.steps;
    const uploader: Uploader = {
      existing: () => this.testops.sharedStepAttachments(target.id),
      upload: (fileName, data, type) => this.testops.uploadSharedStepAttachment(target.id, fileName, data, type),
    };
    const uploaded = await this.uploadAll(stepAttachments(planned), this.assets.attachments(null), uploader, log);
    await this.testops.clearSharedStepScenario(target.id);
    const steps = await this.scenarioSteps(planned, uploaded, [], log);
    if (steps.length > 0) {
      await this.testops.setSharedStepScenario(target.id, steps);
    }
    log("info", `Shared step "${name}" migrated.`);
    return target.id;
  }
}

function stepAttachments(steps: PlannedStep[]): PlannedAttachment[] {
  return steps.flatMap((step) =>
    step.type === "step"
      ? [...step.attachments, ...step.dataAttachments, ...step.expectedAttachments, ...stepAttachments(step.steps ?? [])]
      : [],
  );
}

function attachmentKey(attachment: PlannedAttachment): string {
  return attachment.sourceId ?? `generated:${attachment.fileName}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
