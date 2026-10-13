import type { PlannedStep, Profile } from "@atm/shared";
import { separatedSteps } from "../convert/steps.js";
import type { TestRailClient } from "../testrail/client.js";
import type { TrSharedStep, TrStep } from "../testrail/types.js";
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
  /** Where attachments come from, for messages. TestRail when not set. */
  sourceName?: string;
  attachments(caseKey: string | null): CaseAttachments;
  sharedStep(id: number): Promise<SharedStepContent>;
  /** How to fix attachment downloads that fail. */
  attachmentHint?: string;
  /** Text left in place of an inline image that could not be migrated, e.g. a link to the file. */
  missingImage?(sourceId: string): string | null;
  /** Whether files of the source are downloaded; the "Migrate attachments" option when not set. */
  downloadsFiles?: boolean;
}

/** Steps of a shared step; the field is `custom_steps_separated` unless the instance renamed it. */
function sharedStepSteps(shared: TrSharedStep): TrStep[] {
  if (Array.isArray(shared.custom_steps_separated)) {
    return shared.custom_steps_separated;
  }
  const renamed = Object.entries(shared).find(([key, value]) => key.endsWith("steps_separated") && Array.isArray(value));
  return (renamed?.[1] as TrStep[] | undefined) ?? [];
}

export function testRailAssets(client: TestRailClient, profile: Profile): SourceAssets {
  return {
    attachmentHint:
      "Inline images of some TestRail versions are only served to a logged-in browser. Copy the tr_session cookie from a browser logged in to TestRail into \"Session cookie\" (Connections, advanced settings) and run again; attachments already migrated are not uploaded twice.",
    attachments: (caseKey) => new AttachmentSource(client, caseKey === null ? null : Number(caseKey)),
    sharedStep: async (id) => {
      const shared = await client.getSharedStep(id);
      return {
        id: shared.id,
        title: shared.title,
        steps: separatedSteps(sharedStepSteps(shared), { format: profile.options.textFormat }, false),
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
