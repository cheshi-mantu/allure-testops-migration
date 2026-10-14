import { createHash } from "node:crypto";
import type { PlannedAttachment, PlannedStep } from "@atm/shared";
import type { CaseAttachments, SharedStepContent, SourceAssets } from "../engine/assets.js";
import { contentTypeFor, isHtmlPage, safeFileName, type DownloadedAttachment } from "../engine/attachments.js";
import type { QaseClient } from "./client.js";
import type { QaseAttachment, QaseCase, QaseSharedStep, QaseStep } from "./types.js";

/**
 * Files and shared steps of a Qase project. Qase gives every file an address; cases refer to files
 * in their attachments, in the attachments of steps and as images inside text.
 */
export class QaseAssets implements SourceAssets {
  readonly sourceName = "Qase";
  readonly attachmentHint =
    "Qase gave the address of the file, but the file could not be read from it. Open the case in Qase and check that the file is still there; a file deleted from the workspace storage keeps its place in the case. Cases stay migrated; run again to add the files.";
  private readonly files = new Map<string, { url: string; name: string | null }>();
  private readonly hosts = new Set<string>();
  private readonly shared = new Map<string, QaseSharedStep>();
  private readonly sharedNumbers = new Map<string, number>();
  private readonly sharedHashes = new Map<number, string>();
  /** Turns the steps of a shared step into planned steps; set by the transform, which owns the conversion. */
  convertSteps: (steps: QaseStep[]) => PlannedStep[] = () => [];

  constructor(
    private readonly client: QaseClient,
    sharedSteps: QaseSharedStep[] = [],
  ) {
    sharedSteps.forEach((step) => this.shared.set(step.hash, step));
  }

  /** Remembers a file and returns the key cases refer to it by. */
  register(file: Pick<QaseAttachment, "url"> & Partial<QaseAttachment>): string {
    const key = file.hash && /^[A-Za-z0-9-]+$/.test(file.hash) ? file.hash : `q${createHash("sha1").update(file.url).digest("hex").slice(0, 12)}`;
    const known = this.files.get(key);
    if (!known || (!known.name && file.filename)) {
      this.files.set(key, { url: file.url, name: file.filename?.trim() || null });
    }
    try {
      this.hosts.add(new URL(file.url).host);
    } catch {
      // Not an address: the download will say so.
    }
    return key;
  }

  planned(file: QaseAttachment): PlannedAttachment {
    return { sourceId: this.register(file), fileName: file.filename };
  }

  /** Files of these cases and of their steps: their hosts tell which images in text are Qase files. */
  learn(cases: Iterable<QaseCase>): void {
    const walk = (steps: QaseStep[] | undefined) => {
      for (const step of steps ?? []) {
        step.attachments?.forEach((file) => this.register(file));
        walk(step.steps);
      }
    };
    for (const testCase of cases) {
      testCase.attachments?.forEach((file) => this.register(file));
      walk(testCase.steps);
    }
  }

  /** The key of an image address when the image is a file kept by Qase, else null. */
  imageKey(url: string): string | null {
    for (const [key, file] of this.files) {
      if (file.url === url) {
        return key;
      }
    }
    try {
      const parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol)) {
        return null;
      }
      const sameApi = parsed.origin === new URL(this.client.endpoint).origin;
      return sameApi || this.hosts.has(parsed.host) || /(^|\.)qase\.io$/i.test(parsed.hostname) ? this.register({ url }) : null;
    } catch {
      return null;
    }
  }

  attachments(): CaseAttachments {
    // Names are unique within a case: Allure TestOps finds already uploaded files by name.
    const used = new Map<string, string>();
    return {
      // Files of a case are planned by the transform, so the "Migrate attachments" option covers them all.
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
      throw new Error(`Qase file ${key} is not known.`);
    }
    const result = await this.client.download(file.url);
    if (result.data.length === 0) {
      throw new Error(`Cannot download ${file.name ?? file.url} from Qase: the answer is empty.`);
    }
    if (isHtmlPage(result) && !/\.html?$/i.test(file.name ?? "")) {
      throw new Error(`Cannot download ${file.name ?? file.url} from Qase: the answer is a web page, not the file.`);
    }
    const fromUrl = (() => {
      try {
        const last = decodeURIComponent(new URL(file.url).pathname.split("/").pop() ?? "");
        return /\.[A-Za-z0-9]{1,5}$/.test(last) ? last : null;
      } catch {
        return null;
      }
    })();
    const fileName = safeFileName(file.name ?? result.fileName ?? fromUrl ?? `attachment-${key}`);
    return { fileName, data: result.data, contentType: contentTypeFor(fileName, result.contentType) };
  }

  /** Shared steps are known by a hash in Qase; planned steps carry a number that stands for it. */
  sharedNumber(hash: string): number {
    let number = this.sharedNumbers.get(hash);
    if (number === undefined) {
      number = this.sharedNumbers.size + 1;
      this.sharedNumbers.set(hash, number);
      this.sharedHashes.set(number, hash);
    }
    return number;
  }

  sharedTitle(hash: string): string {
    return this.shared.get(hash)?.title ?? `Shared step ${hash.slice(0, 8)}`;
  }

  hasShared(hash: string): boolean {
    return this.shared.has(hash);
  }

  async sharedStep(id: number): Promise<SharedStepContent> {
    const hash = this.sharedHashes.get(id);
    const step = hash ? this.shared.get(hash) : undefined;
    if (!step) {
      throw new Error(`Shared step ${hash ?? id} could not be read from Qase.`);
    }
    // The number of a shared step differs between runs, its hash does not: the name carries the hash.
    return { id, title: step.title, name: `${step.title} [${hash!.slice(0, 8)}]`, steps: this.convertSteps(step.steps ?? []) };
  }
}
