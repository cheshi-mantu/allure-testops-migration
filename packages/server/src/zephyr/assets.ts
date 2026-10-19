import { createHash } from "node:crypto";
import type { PlannedAttachment, PlannedStep } from "@atm/shared";
import type { CaseAttachments, SharedStepContent, SourceAssets } from "../engine/assets.js";
import { contentTypeFor, isHtmlPage, safeFileName, type DownloadedAttachment } from "../engine/attachments.js";
import type { ZephyrClient } from "./client.js";
import type { ZephyrAttachment, ZephyrCase } from "./types.js";

/** Where a file is read from: a file of a test case or of a step, or a picture at a Zephyr API address. */
type ZephyrFile = { kind: "case"; caseKey: string; stepId: string | null; id: string; name: string } | { kind: "url"; url: string; name: string };

/** Files of Zephyr test cases and steps, pictures in their text, and the test cases steps call. */
export class ZephyrAssets implements SourceAssets {
  readonly sourceName = "Zephyr";
  readonly attachmentHint =
    "Zephyr did not give the file. Check that the file is still attached to the test case in Zephyr and that the API token is valid. Cases stay migrated; run again to add the files.";
  private readonly files = new Map<string, ZephyrFile>();
  /** Turns a called test case into planned steps; set by the context, which owns the conversion. */
  convertSteps: (item: ZephyrCase) => PlannedStep[] = () => [];

  constructor(
    private readonly client: ZephyrClient,
    /** Test cases called by steps, by key. */
    private readonly called: Map<string, ZephyrCase>,
  ) {}

  private register(file: ZephyrFile): string {
    const identity = file.kind === "url" ? `url/${file.url}` : `${file.caseKey}/${file.stepId ?? ""}/${file.id}`;
    const key = `z${createHash("sha1").update(identity).digest("hex").slice(0, 12)}`;
    if (!this.files.has(key)) {
      this.files.set(key, file);
    }
    return key;
  }

  /** A file of a test case (`stepId` null) or of one of its steps. */
  planned(caseKey: string, stepId: string | null, file: ZephyrAttachment): PlannedAttachment {
    const name = file.name || `attachment-${file.id}`;
    return { sourceId: this.register({ kind: "case", caseKey, stepId, id: String(file.id), name }), fileName: name };
  }

  /** A picture at an address of the Zephyr API, read with the token. */
  picture(url: string): string {
    const name = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? "image");
    return this.register({ kind: "url", url, name: /\.[a-z0-9]{2,5}$/i.test(name) ? name : `${name}.png` });
  }

  fileName(key: string): string | null {
    return this.files.get(key)?.name ?? null;
  }

  /** Whether an address belongs to the Zephyr API, so the token may be sent there. */
  isApiAddress(url: string): boolean {
    try {
      return new URL(url).origin === new URL(this.client.endpoint).origin;
    } catch {
      return false;
    }
  }

  attachments(): CaseAttachments {
    // Names are unique within a case: Allure TestOps finds already uploaded files by name.
    const used = new Map<string, string>();
    return {
      // Files of a test case are planned by the transform, so the "Migrate attachments" option covers them all.
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
      throw new Error(`Zephyr file ${key} is not known.`);
    }
    const result = file.kind === "url" ? await this.client.fetchUrl(file.url) : await this.client.download(file.caseKey, file.stepId, file.id);
    if (isHtmlPage(result) && !/\.html?$/i.test(file.name)) {
      throw new Error(`Cannot download ${file.name} from Zephyr: the answer is a web page, not the file.`);
    }
    const fileName = safeFileName(file.name || result.fileName || key);
    return { fileName, data: result.data, contentType: contentTypeFor(fileName, result.contentType) };
  }

  async sharedStep(id: number): Promise<SharedStepContent> {
    const item = [...this.called.values()].find((candidate) => candidate.testCase.id === id);
    if (!item) {
      throw new Error(`Test case ${id} called by a step could not be read from Zephyr.`);
    }
    const title = `${item.testCase.key} ${item.testCase.name}`.trim();
    return { id, title, name: title, steps: this.convertSteps(item) };
  }
}
