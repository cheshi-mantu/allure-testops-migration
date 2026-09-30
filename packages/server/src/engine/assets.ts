import type { PlannedStep, Profile } from "@atm/shared";
import { separatedSteps } from "../convert/steps.js";
import type { TestRailClient } from "../testrail/client.js";
import { AttachmentSource, type DownloadedAttachment } from "./attachments.js";

/** Attachments of one source case. */
export interface CaseAttachments {
  /** All attachments of the case, also those not referenced in its text. */
  caseAttachments(): Promise<{ id: string | number }[]>;
  download(id: string): Promise<DownloadedAttachment>;
}

export interface SharedStepContent {
  id: number;
  title: string;
  steps: PlannedStep[];
}

/** What the writer needs from the source besides the planned case. */
export interface SourceAssets {
  attachments(caseKey: string | null): CaseAttachments;
  sharedStep(id: number): Promise<SharedStepContent>;
}

export function testRailAssets(client: TestRailClient, profile: Profile): SourceAssets {
  return {
    attachments: (caseKey) => new AttachmentSource(client, caseKey === null ? null : Number(caseKey)),
    sharedStep: async (id) => {
      const shared = await client.getSharedStep(id);
      return {
        id: shared.id,
        title: shared.title,
        steps: separatedSteps(shared.custom_steps_separated ?? [], { format: profile.options.textFormat }, false),
      };
    },
  };
}

/** CSV files carry text only. */
export const noAssets: SourceAssets = {
  attachments: () => ({
    caseAttachments: async () => [],
    download: async (id) => {
      throw new Error(`Attachment ${id} cannot be read from a CSV file.`);
    },
  }),
  sharedStep: async (id) => {
    throw new Error(`Shared step ${id} cannot be read from a CSV file.`);
  },
};
