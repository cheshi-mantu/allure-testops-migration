/** Zephyr Squad API (ZAPI) payloads, only the parts the migration uses. */
import type { JiraIssue } from "../jira/types.js";

export interface SquadAttachment {
  id: string;
  name: string;
  fileExtension?: string;
  size?: number;
}

export interface SquadStep {
  /** E.g. `0001479232086830-fa312653ffffd5ee-0001`. */
  id: string;
  orderId?: number;
  /** Jira wiki markup. */
  step?: string | null;
  data?: string | null;
  result?: string | null;
  /** Files of the step, when the step list names them. */
  attachments?: SquadAttachment[] | null;
}

/** One test: the Jira issue and its steps. */
export interface SquadCase {
  issue: JiraIssue;
  steps: SquadStep[];
  /** Step id -> files of the step. */
  stepAttachments: Map<string, SquadAttachment[]>;
}
