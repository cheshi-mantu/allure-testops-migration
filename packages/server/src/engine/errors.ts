import type { PlannedNote } from "@atm/shared";

/** A source record that cannot become a test case, e.g. a CSV row without a name. It is skipped, not failed. */
export class CaseSkipped extends Error {
  constructor(
    message: string,
    /** Why and how to fix it, in the same shape as case notes. */
    readonly note: PlannedNote,
  ) {
    super(message);
    this.name = "CaseSkipped";
  }
}
