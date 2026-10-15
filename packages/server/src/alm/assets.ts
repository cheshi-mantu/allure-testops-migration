import { createHash } from "node:crypto";
import type { PlannedAttachment, PlannedStep } from "@atm/shared";
import type { CaseAttachments, SharedStepContent, SourceAssets } from "../engine/assets.js";
import { contentTypeFor, isHtmlPage, safeFileName, type DownloadedAttachment } from "../engine/attachments.js";
import { HttpError } from "../http/httpClient.js";
import type { AlmClient } from "./client.js";
import { one, type AlmRecord, type AlmTest } from "./types.js";

/** What an attachment belongs to: a test or a design step (with the test of the step). */
export interface AlmOwner {
  kind: "tests" | "design-steps";
  id: number;
  testId: number;
}

/** Files of ALM tests and design steps, and the tests other tests call. */
export class AlmAssets implements SourceAssets {
  readonly sourceName = "ALM";
  readonly attachmentHint =
    "ALM did not give the file. Open the test in ALM and check that the attachment is still there; a picture in a description or step is kept as an attachment of that test or step. Cases stay migrated; run again to add the files.";
  private readonly files = new Map<string, { owner: AlmOwner; name: string }>();
  /** Turns a called test into planned steps; set by the transform, which owns the conversion. */
  convertSteps: (test: AlmTest) => PlannedStep[] = () => [];

  constructor(
    private readonly client: AlmClient,
    private readonly domain: string,
    private readonly project: string,
    private readonly called: Map<number, AlmTest>,
  ) {}

  /** Remembers a file and returns the key cases refer to it by. */
  register(owner: AlmOwner, name: string): string {
    const key = `a${createHash("sha1").update(`${owner.kind}/${owner.id}/${name}`).digest("hex").slice(0, 12)}`;
    if (!this.files.has(key)) {
      this.files.set(key, { owner, name });
    }
    return key;
  }

  planned(owner: AlmOwner, file: AlmRecord): PlannedAttachment {
    const name = one(file, "name") ?? `attachment-${one(file, "id")}`;
    return { sourceId: this.register(owner, name), fileName: name };
  }

  fileName(key: string): string | null {
    return this.files.get(key)?.name ?? null;
  }

  attachments(): CaseAttachments {
    // Names are unique within a case: Allure TestOps finds already uploaded files by name.
    const used = new Map<string, string>();
    return {
      // Files of a test are planned by the transform, so the "Migrate attachments" option covers them all.
      caseAttachments: async () => [],
      download: async (key) => {
        const file = await this.download(key);
        let fileName = file.fileName;
        for (let copy = 2; used.has(fileName) && used.get(fileName) !== key; copy += 1) {
          fileName = file.fileName.replace(/(\.[A-Za-z0-9]{1,5})?$/, (extension) => `-${copy}${extension}`);
        }
        used.set(fileName, key);
        return { ...file, fileName };
      },
    };
  }

  private async download(key: string): Promise<DownloadedAttachment> {
    const file = this.files.get(key);
    if (!file) {
      throw new Error(`ALM file ${key} is not known.`);
    }
    const { owner, name } = file;
    let result;
    try {
      result = await this.client.attachmentContent(this.domain, this.project, owner.kind, owner.id, name);
    } catch (error) {
      // A picture in a step may have been pasted into the test instead.
      if (!(owner.kind === "design-steps" && error instanceof HttpError && error.status === 404)) {
        throw error;
      }
      result = await this.client.attachmentContent(this.domain, this.project, "tests", owner.testId, name);
    }
    if (isHtmlPage(result) && !/\.html?$/i.test(name)) {
      throw new Error(`Cannot download ${name} from ALM: the answer is a web page, not the file.`);
    }
    const fileName = safeFileName(name);
    return { fileName, data: result.data, contentType: contentTypeFor(fileName, result.contentType) };
  }

  async sharedStep(id: number): Promise<SharedStepContent> {
    const test = this.called.get(id);
    if (!test) {
      throw new Error(`Test ${id} called by a step could not be read from ALM.`);
    }
    const title = one(test.test, "name") ?? `Test ${id}`;
    return { id, title, name: `${title} [${id}]`, steps: this.convertSteps(test) };
  }
}
