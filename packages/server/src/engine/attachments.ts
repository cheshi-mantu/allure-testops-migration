import type { TestRailClient } from "../testrail/client.js";
import type { TrAttachment } from "../testrail/types.js";

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/json": "json",
  "application/zip": "zip",
  "video/mp4": "mp4",
};

const TYPES: Record<string, string> = Object.fromEntries(Object.entries(EXTENSIONS).map(([type, ext]) => [ext, type]));

export function contentTypeFor(fileName: string, fallback: string | null = null): string {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  return TYPES[extension] ?? (fallback?.split(";")[0]?.trim() || "application/octet-stream");
}

export function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").trim();
  return cleaned || "attachment";
}

export interface DownloadedAttachment {
  fileName: string;
  contentType: string;
  data: Buffer;
}

/**
 * Downloads TestRail attachments for one case. Inline references may use either the attachment id
 * or the older numeric `data_id`, and some TestRail versions only serve inline images to a browser
 * session, so several ways are tried in order.
 */
export class AttachmentSource {
  private listed: TrAttachment[] | null = null;

  constructor(
    private readonly client: TestRailClient,
    private readonly caseId: number | null,
  ) {}

  async caseAttachments(): Promise<TrAttachment[]> {
    if (this.listed === null) {
      this.listed = this.caseId === null ? [] : await this.client.getCaseAttachments(this.caseId).catch(() => []);
    }
    return this.listed;
  }

  private async metadata(id: string): Promise<TrAttachment | undefined> {
    return (await this.caseAttachments()).find((a) => String(a.id) === id || (a.data_id !== null && a.data_id !== undefined && String(a.data_id) === id));
  }

  async download(id: string): Promise<DownloadedAttachment> {
    const meta = await this.metadata(id);
    const candidates = [...new Set([id, meta ? String(meta.id) : id])];
    const errors: string[] = [];
    for (const candidate of candidates) {
      try {
        const result = await this.client.getAttachment(candidate);
        if (result.data.length > 0 && !isHtmlPage(result)) {
          return this.describe(id, meta, result);
        }
        errors.push("empty response");
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (this.client.hasSessionCookie) {
      try {
        const result = await this.client.getAttachmentAsBrowser(id);
        if (result.data.length > 0 && !isHtmlPage(result)) {
          return this.describe(id, meta, result);
        }
        errors.push("the session cookie seems expired (TestRail returned a web page)");
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    } else {
      errors.push("a TestRail session cookie may be needed for inline images on this TestRail version");
    }
    throw new Error(`Cannot download TestRail attachment ${id}: ${errors.join("; ")}`);
  }

  private describe(id: string, meta: TrAttachment | undefined, result: { data: Buffer; contentType: string | null }): DownloadedAttachment {
    const original = meta?.filename || meta?.name;
    let fileName = original ? safeFileName(original) : `attachment-${id}`;
    if (!/\.[A-Za-z0-9]{1,5}$/.test(fileName)) {
      const extension = EXTENSIONS[result.contentType?.split(";")[0]?.trim() ?? ""];
      if (extension) {
        fileName = `${fileName}.${extension}`;
      }
    }
    // Prefix with the canonical id so reruns find the same file and different files never collide.
    const canonical = meta ? String(meta.id) : id;
    fileName = fileName.startsWith(`${canonical}-`) ? fileName : `${canonical}-${fileName}`;
    return { fileName, contentType: contentTypeFor(fileName, result.contentType), data: result.data };
  }
}

function isHtmlPage(result: { data: Buffer; contentType: string | null }): boolean {
  return (result.contentType ?? "").includes("text/html") && result.data.subarray(0, 200).toString("utf8").toLowerCase().includes("<html");
}
