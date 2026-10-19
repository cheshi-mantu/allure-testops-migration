import type { CaseAttachments, SourceAssets } from "../engine/assets.js";
import { contentTypeFor, isHtmlPage, safeFileName, type DownloadedAttachment } from "../engine/attachments.js";
import type { JiraClient } from "../jira/client.js";
import type { JiraAttachment } from "../jira/types.js";
import type { ZapiClient } from "./client.js";
import type { SquadCase } from "./types.js";

/** Step files are kept by Zephyr Squad, issue files by Jira: the prefix tells the downloader which one. */
export const SQUAD_ATTACHMENT_PREFIX = "zapi-";

/**
 * Attachments of Zephyr Squad tests: files of the Jira issue (inline images and the rest), and step
 * files kept by Zephyr Squad. Tests register here as they are read, so downloads find their files.
 */
export class SquadAssets implements SourceAssets {
  readonly sourceName = "Jira and Zephyr Squad";
  readonly attachmentHint = "Check that the Jira user can see the issue and its attachments, and that the Zephyr Squad API keys are valid.";
  private readonly cases = new Map<string, SquadCase>();
  private readonly jiraFiles = new Map<string, JiraAttachment>();
  /** Step file id -> issue id and name. */
  private readonly stepFiles = new Map<string, { issueId: string; name: string }>();

  constructor(
    private readonly zapi: ZapiClient,
    private readonly jira: JiraClient,
    private readonly projectId: string,
  ) {}

  register(cases: Iterable<SquadCase>): void {
    for (const testCase of cases) {
      this.cases.set(testCase.issue.key, testCase);
      for (const file of (testCase.issue.fields.attachment as JiraAttachment[] | undefined) ?? []) {
        this.jiraFiles.set(String(file.id), file);
      }
      for (const files of testCase.stepAttachments.values()) {
        for (const file of files) {
          this.stepFiles.set(file.id, { issueId: testCase.issue.id, name: file.name });
        }
      }
    }
  }

  attachments(caseKey: string | null): CaseAttachments {
    const testCase = caseKey ? this.cases.get(caseKey) : undefined;
    return {
      caseAttachments: async () => ((testCase?.issue.fields.attachment as JiraAttachment[] | undefined) ?? []).map((file) => ({ id: String(file.id) })),
      download: (id) => this.download(id),
    };
  }

  private async download(id: string): Promise<DownloadedAttachment> {
    if (id.startsWith(SQUAD_ATTACHMENT_PREFIX)) {
      const attachmentId = id.slice(SQUAD_ATTACHMENT_PREFIX.length);
      const file = this.stepFiles.get(attachmentId);
      if (!file) {
        throw new Error(`Zephyr Squad step file ${attachmentId} is not known.`);
      }
      const downloaded = await this.zapi.download(attachmentId, file.issueId, this.projectId);
      if (isHtmlPage(downloaded) && !/\.html?$/i.test(file.name)) {
        throw new Error(`Cannot download ${file.name} from Zephyr Squad: the answer is a web page, not the file.`);
      }
      const fileName = safeFileName(file.name || downloaded.fileName || attachmentId);
      return { fileName, data: downloaded.data, contentType: contentTypeFor(fileName, downloaded.contentType) };
    }
    const file = this.jiraFiles.get(id);
    if (!file) {
      throw new Error(`Jira attachment ${id} is not attached to the test.`);
    }
    const downloaded = await this.jira.download(file.content);
    const fileName = safeFileName(file.filename || downloaded.fileName || `attachment-${id}`);
    return { fileName, data: downloaded.data, contentType: contentTypeFor(fileName, file.mimeType ?? downloaded.contentType) };
  }

  async sharedStep(id: number): Promise<never> {
    throw new Error(`Zephyr Squad has no shared steps (asked for ${id}).`);
  }
}
