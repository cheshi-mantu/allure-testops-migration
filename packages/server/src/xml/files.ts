import { createHash } from "node:crypto";
import type { XmlFiles as XmlFilesSettings } from "@atm/shared";
import type { CaseAttachments, SourceAssets } from "../engine/assets.js";
import { contentTypeFor, isHtmlPage, safeFileName, type DownloadedAttachment } from "../engine/attachments.js";
import { HttpClient, type RetryInfo } from "../http/httpClient.js";

/**
 * Files an XML export refers to. The export holds addresses of attachments and of images inside
 * text; with downloads on, the files are read from the system that serves them. Only addresses on
 * the configured system are downloaded, so its credentials are never sent anywhere else.
 */

/**
 * Addresses that a browser session opens but an API user cannot, with the public API address of the
 * same file. Matched by the shape of the address.
 */
const API_ADDRESSES: { page: RegExp; api: (match: RegExpExecArray) => string }[] = [
  // TestRail: index.php?/attachments/get/<id> is served to browsers, the API has get_attachment.
  { page: /index\.php\?\/attachments\/get\/([A-Za-z0-9-]+)/, api: (match) => `index.php?/api/v2/get_attachment/${match[1]}` },
];

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
};

interface KnownFile {
  url: string;
  name: string | null;
}

export class XmlFiles implements SourceAssets {
  readonly sourceName: string;
  readonly attachmentHint =
    "Check the address, user and password or API key under \"Attached files\" on the Connection step, and that this user can open the files in the source system. Use \"Test download\" there. Cases stay migrated; run again to add the files.";
  readonly downloadsFiles = true;
  private readonly base: URL | null;
  private readonly http: HttpClient | null;
  private readonly known = new Map<string, KnownFile>();

  constructor(
    private readonly settings: XmlFilesSettings,
    onRetry?: (info: RetryInfo) => void,
  ) {
    this.base = settings.download ? parseBase(settings.endpoint) : null;
    this.sourceName = this.base?.host ?? "the source system";
    this.http = this.base
      ? new HttpClient({ baseUrl: this.base.href, headers: authHeaders(settings), insecureTls: settings.insecureTls, retries: 2, ...(onRetry ? { onRetry } : {}) })
      : null;
  }

  /** Downloads are on and the address of the source system is usable. */
  get enabled(): boolean {
    return this.base !== null;
  }

  /** The origin files are downloaded from, e.g. `https://testrail.example.com`. */
  get origin(): string | null {
    return this.base?.origin ?? null;
  }

  /**
   * The absolute address of a file when it is served by the source system, else null. Relative
   * addresses, as images in text often have, are read against the address of the source system.
   */
  resolve(address: string): string | null {
    if (!this.base) {
      return null;
    }
    try {
      const url = new URL(address.trim(), this.base);
      return url.origin === this.base.origin ? url.href : null;
    } catch {
      return null;
    }
  }

  /** Remembers a file and returns the key cases refer to it by. */
  register(url: string, name: string | null): string {
    const key = `f${createHash("sha1").update(url).digest("hex").slice(0, 12)}`;
    const existing = this.known.get(key);
    if (!existing || (!existing.name && name)) {
      this.known.set(key, { url, name: name?.trim() || null });
    }
    return key;
  }

  has(key: string): boolean {
    return this.known.has(key);
  }

  /** Name to show before the file is downloaded. */
  nameOf(key: string): string {
    const file = this.known.get(key);
    return file ? (file.name ?? baseName(file.url) ?? file.url) : key;
  }

  /** An image that could not be downloaded stays a link to it. */
  missingImage(key: string): string | null {
    const file = this.known.get(key);
    return file ? `[${file.name ?? "image"}](${file.url})` : null;
  }

  get keys(): string[] {
    return [...this.known.keys()];
  }

  attachments(): CaseAttachments {
    // Names are unique within a case: Allure TestOps finds already uploaded files by name.
    const used = new Map<string, string>();
    return {
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

  async download(key: string): Promise<DownloadedAttachment> {
    const file = this.known.get(key);
    if (!file || !this.http) {
      throw new Error(`File ${key} is not known.`);
    }
    const addresses = [...new Set([apiAddress(file.url, this.base!), file.url])];
    const errors: string[] = [];
    for (const address of addresses) {
      try {
        const result = await this.http.bytes(address);
        if (result.data.length === 0) {
          errors.push("the answer is empty");
          continue;
        }
        if (isHtmlPage(result) && !/\.html?$/i.test(file.name ?? "")) {
          errors.push("the answer is a web page, usually the login page: the user or password is not accepted");
          continue;
        }
        let fileName = safeFileName(file.name ?? result.fileName ?? baseName(file.url) ?? `attachment-${key}`);
        if (!/\.[A-Za-z0-9]{1,5}$/.test(fileName)) {
          const extension = EXTENSIONS[result.contentType?.split(";")[0]?.trim() ?? ""];
          fileName = extension ? `${fileName}.${extension}` : fileName;
        }
        return { fileName, data: result.data, contentType: contentTypeFor(fileName, result.contentType) };
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    throw new Error(`Cannot download ${file.name ? `"${file.name}" from ` : ""}${file.url}: ${[...new Set(errors)].join("; ")}`);
  }

  async sharedStep(id: number): Promise<never> {
    throw new Error(`Shared step ${id} cannot be read from an XML file.`);
  }
}

function parseBase(endpoint: string): URL | null {
  const trimmed = endpoint.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return null;
  }
  try {
    return new URL(trimmed.endsWith("/") ? trimmed : `${trimmed}/`);
  } catch {
    return null;
  }
}

function authHeaders(settings: XmlFilesSettings): Record<string, string> {
  if (settings.auth === "basic" && settings.username) {
    return { Authorization: `Basic ${Buffer.from(`${settings.username}:${settings.password}`).toString("base64")}` };
  }
  if (settings.auth === "header" && settings.headerName.trim() && settings.headerValue) {
    return { [settings.headerName.trim()]: settings.headerValue };
  }
  return {};
}

function apiAddress(url: string, base: URL): string {
  for (const known of API_ADDRESSES) {
    const match = known.page.exec(url);
    if (match) {
      return new URL(known.api(match), base).href;
    }
  }
  return url;
}

/** `screenshot.png` from `https://host/files/screenshot.png?version=2`; null when the address has no file name. */
function baseName(url: string): string | null {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    return /\.[A-Za-z0-9]{1,5}$/.test(last) ? last : null;
  } catch {
    return null;
  }
}

/** Hosts of absolute addresses that are not the source system: their files stay links. */
export function otherHosts(addresses: string[], origin: string | null): string[] {
  const hosts = new Set<string>();
  for (const address of addresses) {
    try {
      const url = new URL(address);
      if (/^https?:$/.test(url.protocol) && url.origin !== origin) {
        hosts.add(url.host);
      }
    } catch {
      // Not an absolute address.
    }
  }
  return [...hosts];
}
