/** A source record that cannot become a test case, e.g. a CSV row without a name. It is skipped, not failed. */
export class CaseSkipped extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaseSkipped";
  }
}
