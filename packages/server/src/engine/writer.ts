import type { PlannedAttachment, PlannedCase, PlannedStep, Profile } from "@atm/shared";
import { resolveAttachmentImages, resolveCaseLinks } from "../convert/markup.js";
import { separatedSteps } from "../convert/steps.js";
import type { TestOpsClient, ToAttachment, ToCustomFieldValue, ToScenarioStep, ToTestCasePatch } from "../testops/client.js";
import type { TestRailClient } from "../testrail/client.js";
import { AttachmentSource, contentTypeFor, safeFileName } from "./attachments.js";
import type { TargetResolver } from "./targets.js";

export type WriteLog = (level: "info" | "warn" | "error", message: string) => void;

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
  /** TestRail case id -> Allure TestOps test case id, filled as cases are migrated. */
  private readonly migrated = new Map<number, number>();
  private readonly sharedSteps = new Map<number, Promise<number | null>>();

  constructor(
    private readonly profile: Profile,
    private readonly testops: TestOpsClient,
    private readonly testrail: TestRailClient,
    private readonly targets: TargetResolver,
    private readonly projectId: number,
  ) {}

  private get tagPrefix(): string {
    return this.profile.options.migrationTagPrefix;
  }

  /** Allure TestOps URL for a TestRail case that is already migrated (in this run or before). */
  async testCaseUrlFor(caseId: number): Promise<string | null> {
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

  private async resolveLinks(text: string, linkedCaseIds: number[]): Promise<string> {
    if (!text || linkedCaseIds.length === 0) {
      return text;
    }
    const urls = new Map<number, string | null>();
    for (const id of linkedCaseIds) {
      urls.set(id, await this.testCaseUrlFor(id));
    }
    return resolveCaseLinks(text, (id) => urls.get(id) ?? null);
  }

  async writeCase(planned: PlannedCase, linkedCaseIds: number[], log: WriteLog): Promise<WriteResult> {
    const tag = `${this.tagPrefix}:${planned.sourceId}`;
    const existing = await this.testops.findTestCaseByTag(this.projectId, tag);
    const testCase = existing ?? (await this.testops.createTestCase(this.projectId, planned.name));
    this.migrated.set(planned.sourceId, testCase.id);

    // Tags first: they make the case findable on rerun even if a later step fails.
    await this.testops.setTags(testCase.id, planned.tags);

    const source = new AttachmentSource(this.testrail, planned.sourceId);
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
      const layer = await this.targets.layer(planned.layer);
      if (layer) {
        patch.testLayerId = layer.id;
      }
    }
    if (planned.status) {
      const status = await this.targets.status(planned.status);
      if (status) {
        patch.statusId = status.id;
      }
    }
    await this.testops.updateTestCase(testCase.id, patch);

    await this.writeCustomFields(testCase.id, planned.customFields);

    const issuesByIntegration = planned.issues.filter((issue) => issue.integrationId !== null);
    if (issuesByIntegration.length > 0) {
      await this.testops.setIssues(
        testCase.id,
        issuesByIntegration.map((issue) => ({ name: issue.key, integrationId: issue.integrationId! })),
      );
    }

    const owner = planned.owner ? await this.targets.owner(planned.owner) : null;
    if (owner) {
      try {
        await this.testops.setOwner(testCase.id, owner);
      } catch {
        this.targets.ownerMissing(owner);
      }
    }

    if (planned.comments.length > 0) {
      const present = new Set((await this.testops.comments(testCase.id)).map((c) => c.body.trim()));
      for (const comment of planned.comments) {
        const body = await text(comment);
        if (!present.has(body.trim())) {
          await this.testops.addComment(testCase.id, body);
        }
      }
    }

    await this.testops.clearScenario(testCase.id);
    const steps = await this.scenarioSteps(planned.scenario, uploaded, linkedCaseIds, log);
    if (steps.length > 0) {
      await this.testops.setScenario(testCase.id, steps);
    }
    return { testCaseId: testCase.id, created: existing === null };
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
    const all: PlannedAttachment[] = [...planned.attachments];
    for (const step of planned.scenario) {
      if (step.type === "step") {
        all.push(...step.attachments, ...step.dataAttachments, ...step.expectedAttachments);
      }
    }
    return all;
  }

  /** Uploads attachments not yet present; returns planned key -> uploaded attachment. */
  private async uploadAll(attachments: PlannedAttachment[], source: AttachmentSource, uploader: Uploader, log: WriteLog) {
    const uploaded = new Map<string, ToAttachment>();
    for (const attachment of attachments) {
      await this.upload(attachment, source, uploader, uploaded, log);
    }
    return uploaded;
  }

  private existingCache = new WeakMap<Uploader, Promise<ToAttachment[]>>();

  private async upload(
    attachment: PlannedAttachment,
    source: AttachmentSource,
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
        target = await uploader.upload(fileName, data, contentType);
        known.push(target);
      }
      uploaded.set(key, target);
    } catch (error) {
      log("warn", message(error));
    }
  }

  private async scenarioSteps(
    steps: PlannedStep[],
    uploaded: Map<string, ToAttachment>,
    linkedCaseIds: number[],
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
        log("warn", `Shared step ${sourceId} was not migrated: ${message(error)}`);
        return null;
      });
      this.sharedSteps.set(sourceId, pending);
    }
    return pending;
  }

  private async migrateSharedStep(sourceId: number, log: WriteLog): Promise<number> {
    const shared = await this.testrail.getSharedStep(sourceId);
    // Same naming as the previous migration tool, so earlier migrated shared steps are reused.
    const name = `${shared.title} [${shared.id}]`;
    const target = (await this.testops.findSharedStep(this.projectId, name)) ?? (await this.testops.createSharedStep(this.projectId, name));
    const planned = separatedSteps(shared.custom_steps_separated ?? [], { format: this.profile.options.textFormat }, false);
    const uploader: Uploader = {
      existing: () => this.testops.sharedStepAttachments(target.id),
      upload: (fileName, data, type) => this.testops.uploadSharedStepAttachment(target.id, fileName, data, type),
    };
    const all = planned.flatMap((step) => (step.type === "step" ? [...step.attachments, ...step.dataAttachments, ...step.expectedAttachments] : []));
    const uploaded = await this.uploadAll(all, new AttachmentSource(this.testrail, null), uploader, log);
    await this.testops.clearSharedStepScenario(target.id);
    const steps = await this.scenarioSteps(planned, uploaded, [], log);
    if (steps.length > 0) {
      await this.testops.setSharedStepScenario(target.id, steps);
    }
    log("info", `Shared step "${name}" migrated.`);
    return target.id;
  }
}

function attachmentKey(attachment: PlannedAttachment): string {
  return attachment.sourceId ?? `generated:${attachment.fileName}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
