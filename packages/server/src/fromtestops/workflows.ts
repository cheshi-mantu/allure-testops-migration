import type { TestOpsClient, ToStatus, ToWorkflow } from "../testops/client.js";

/** Colour of a status the source does not give one for. */
const DEFAULT_COLOR = "#9e9e9e";

type Log = (level: "info" | "warn", message: string) => void;

/**
 * Workflows and statuses of the source in the target: a workflow missing in the target is created
 * with the statuses of the source (by name and colour), a status missing in a workflow of the same
 * name is created or found and added to it. Statuses and workflows are found by name, ignoring case.
 * On a dry run nothing is written; what would be created is logged.
 */
export class WorkflowCloner {
  private sourceList: Promise<ToWorkflow[]> | null = null;
  private targetList: Promise<ToWorkflow[]> | null = null;
  private targetStatuses: Promise<ToStatus[]> | null = null;
  private readonly ensured = new Map<string, Promise<ToWorkflow | null>>();

  constructor(
    private readonly source: TestOpsClient,
    private readonly target: TestOpsClient,
    private readonly dryRun: boolean,
    private readonly log: Log,
  ) {}

  /** The workflow of the target with this name, holding every status its source namesake has; null when it cannot be had. */
  ensure(name: string): Promise<ToWorkflow | null> {
    const key = name.trim().toLowerCase();
    let pending = this.ensured.get(key);
    if (!pending) {
      pending = this.make(name.trim()).catch((error: unknown) => {
        this.log("warn", `Workflow "${name}" could not be created or completed in the target: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      this.ensured.set(key, pending);
    }
    return pending;
  }

  private async statusesOf(client: TestOpsClient, workflow: ToWorkflow): Promise<ToStatus[]> {
    return workflow.statuses?.length ? workflow.statuses : client.allStatuses(workflow.id);
  }

  /** A status of the target with this name, created when the target has none. */
  private async status(wanted: ToStatus): Promise<ToStatus> {
    this.targetStatuses ??= this.target.allStatuses();
    const known = (await this.targetStatuses).find((s) => s.name.toLowerCase() === wanted.name.toLowerCase());
    if (known) {
      return known;
    }
    const created = await this.target.createStatus(wanted.name, wanted.color || DEFAULT_COLOR);
    (await this.targetStatuses).push(created);
    this.log("info", `Created status "${created.name}".`);
    return created;
  }

  private async make(name: string): Promise<ToWorkflow | null> {
    const same = (workflow: ToWorkflow) => workflow.name.toLowerCase() === name.toLowerCase();
    this.sourceList ??= this.source.workflows();
    this.targetList ??= this.target.workflows();
    const sourceWorkflow = (await this.sourceList).find(same);
    const targetWorkflow = (await this.targetList).find(same);
    if (!sourceWorkflow) {
      return targetWorkflow ? { ...targetWorkflow, statuses: await this.statusesOf(this.target, targetWorkflow) } : null;
    }
    const wanted = await this.statusesOf(this.source, sourceWorkflow);
    if (!targetWorkflow) {
      if (this.dryRun) {
        this.log("info", `Workflow "${name}" will be created with the statuses ${wanted.map((s) => `"${s.name}"`).join(", ")}.`);
        return { id: -1, name, statuses: wanted };
      }
      const statuses = [];
      for (const status of wanted) {
        statuses.push(await this.status(status));
      }
      const created = await this.target.createWorkflow(name, statuses.map((s) => s.id));
      (await this.targetList).push(created);
      this.log("info", `Created workflow "${name}" with the statuses ${statuses.map((s) => `"${s.name}"`).join(", ")}.`);
      return { ...created, statuses };
    }
    const present = await this.statusesOf(this.target, targetWorkflow);
    const missing = wanted.filter((status) => !present.some((p) => p.name.toLowerCase() === status.name.toLowerCase()));
    if (missing.length === 0) {
      return { ...targetWorkflow, statuses: present };
    }
    if (this.dryRun) {
      this.log("info", `Workflow "${name}" will get the statuses ${missing.map((s) => `"${s.name}"`).join(", ")}.`);
      return { ...targetWorkflow, statuses: [...present, ...missing] };
    }
    const added = [];
    for (const status of missing) {
      added.push(await this.status(status));
    }
    const statuses = [...present, ...added];
    await this.target.setWorkflowStatuses(targetWorkflow.id, statuses.map((s) => s.id));
    this.log("info", `Added the statuses ${added.map((s) => `"${s.name}"`).join(", ")} to workflow "${name}".`);
    return { ...targetWorkflow, statuses };
  }
}
