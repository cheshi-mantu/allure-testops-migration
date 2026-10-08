import type { CaseAttachments, SourceAssets } from "../engine/assets.js";
import { contentTypeFor, safeFileName, type DownloadedAttachment } from "../engine/attachments.js";
import type { JiraClient, XrayClient } from "./client.js";
import { calledTestContent, XRAY_ATTACHMENT_PREFIX, type XrayContext } from "./transform.js";
import type { JiraAttachment, XrayAttachment, XrayCase } from "./types.js";

/**
 * Attachments of Xray tests: files of the Jira issue (inline images and the rest), and step files
 * kept by Xray. Cases register here as they are read, so downloads find their links.
 */
export class XrayAssets implements SourceAssets {
  readonly sourceName = "Jira and Xray";
  readonly attachmentHint = "Check that the Jira user can see the issue and its attachments, and that the Xray API key is valid.";
  private readonly cases = new Map<string, XrayCase>();
  private readonly jiraFiles = new Map<string, JiraAttachment>();
  private readonly xrayFiles = new Map<string, XrayAttachment>();

  constructor(
    private readonly xray: XrayClient,
    private readonly jira: JiraClient,
    private readonly context: XrayContext,
  ) {}

  register(cases: Iterable<XrayCase>): void {
    for (const testCase of cases) {
      this.cases.set(testCase.issue.key, testCase);
      for (const file of (testCase.issue.fields.attachment as JiraAttachment[] | undefined) ?? []) {
        this.jiraFiles.set(String(file.id), file);
      }
      for (const step of testCase.test.steps ?? []) {
        for (const file of step.attachments ?? []) {
          this.xrayFiles.set(file.id, file);
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
    if (id.startsWith(XRAY_ATTACHMENT_PREFIX)) {
      const file = this.xrayFiles.get(id.slice(XRAY_ATTACHMENT_PREFIX.length));
      if (!file) {
        throw new Error(`Xray step attachment ${id} is not known.`);
      }
      // Files Xray keeps in Jira are served by Jira with the Jira credentials, the others by the Xray API.
      const jiraHosted = file.storedInJira || !/\/api\/v\d+\/attachments?\//.test(file.downloadLink);
      const downloaded = jiraHosted ? await this.jira.download(file.downloadLink) : await this.xray.download(file.downloadLink);
      const fileName = safeFileName(file.filename || downloaded.fileName || id);
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

  async sharedStep(id: number) {
    const called = this.context.called.get(String(id));
    if (!called) {
      throw new Error(`Called test ${id} could not be read.`);
    }
    this.register([called]);
    return calledTestContent(called, this.context);
  }
}
