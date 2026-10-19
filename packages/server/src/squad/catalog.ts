import { JiraCatalog, type JiraCatalogField, type JiraValue } from "../jira/catalog.js";
import type { JiraField } from "../jira/types.js";
import { wikiToPlain } from "../jira/wiki.js";
import type { SquadCase } from "./types.js";

const SQUAD_FIELDS: JiraCatalogField[] = [
  { systemName: "squad:steps", label: "Test steps (Zephyr Squad)", kind: "steps", system: true, closed: false, suggested: { kind: "scenario" }, always: true },
];

/**
 * Everything the tool knows about the attributes of Zephyr Squad tests: the steps Zephyr Squad keeps,
 * and the Jira fields, issue links and comments of the issue (see {@link JiraCatalog}).
 */
export class SquadCatalog extends JiraCatalog<SquadCase> {
  constructor(jiraFields: JiraField[], linkDirectionsSeen: string[] = []) {
    super(jiraFields, linkDirectionsSeen, SQUAD_FIELDS);
  }

  protected appValue(testCase: SquadCase, systemName: string): JiraValue | null {
    if (systemName !== "squad:steps") {
      return null;
    }
    const first = testCase.steps[0];
    return first ? { ids: [], labels: [`${testCase.steps.length} step(s): ${wikiToPlain(first.step ?? first.result ?? "").split("\n")[0]}`] } : { ids: [], labels: [] };
  }

  protected appText(_testCase: SquadCase, systemName: string): string | null {
    return systemName === "squad:steps" ? "" : null;
  }
}
