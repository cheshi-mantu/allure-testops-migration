import type { TestOpsClient, ToNamed } from "../testops/client.js";
import { OperationFailed } from "./problems.js";

type Logger = (level: "info" | "warn", message: string) => void;

/**
 * Looks up (and when allowed creates) Allure TestOps objects by name, with caching.
 * Concurrent lookups for the same name share one request, so parallel cases never create duplicates.
 * Missing objects are returned as null or thrown as OperationFailed; the caller reports them per case.
 */
export class TargetResolver {
  private readonly customFields = new Map<string, Promise<ToNamed>>();
  private readonly layers = new Map<string, Promise<ToNamed>>();
  private statuses: Promise<ToNamed[]> | null = null;
  private layerList: Promise<ToNamed[]> | null = null;
  private projectFields: Promise<ToNamed[]> | null = null;
  private accounts: Promise<Set<string> | null> | null = null;
  private roleList: Promise<ToNamed[]> | null = null;

  constructor(
    private readonly client: TestOpsClient,
    private readonly projectId: number,
    private readonly log: Logger,
  ) {}

  customField(name: string): Promise<ToNamed> {
    const key = name.trim();
    let pending = this.customFields.get(key);
    if (!pending) {
      pending = this.findOrCreateCustomField(key);
      this.customFields.set(key, pending);
      pending.catch(() => this.customFields.delete(key));
    }
    return pending;
  }

  private async findOrCreateCustomField(name: string): Promise<ToNamed> {
    this.projectFields ??= this.client.projectCustomFields(this.projectId).catch(() => []);
    const inProject = (await this.projectFields).find((f) => f.name === name);
    if (inProject) {
      return inProject;
    }
    try {
      const global = (await this.client.suggestCustomFields(name)).find((f) => f.name === name);
      const field = global ?? (await this.client.createCustomField(name));
      if (!global) {
        this.log("info", `Created custom field "${name}".`);
      }
      await this.client.addCustomFieldsToProject(this.projectId, [field.id]);
      return field;
    } catch (error) {
      throw new OperationFailed("create a custom field", error);
    }
  }

  /** Existing layer, or a new one; throws OperationFailed when it cannot be created. */
  layer(name: string): Promise<ToNamed> {
    const key = name.trim();
    let pending = this.layers.get(key.toLowerCase());
    if (!pending) {
      pending = this.findOrCreateLayer(key);
      this.layers.set(key.toLowerCase(), pending);
    }
    return pending;
  }

  private async findOrCreateLayer(name: string): Promise<ToNamed> {
    this.layerList ??= this.client.layers();
    const existing = (await this.layerList).find((layer) => layer.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      return existing;
    }
    try {
      const created = await this.client.createLayer(name);
      this.log("info", `Created test layer "${name}".`);
      return created;
    } catch (error) {
      throw new OperationFailed("create a test layer", error);
    }
  }

  /**
   * The user name if the user exists. When the token cannot list users the name is used as is and
   * a failed assignment is reported by the writer.
   */
  async owner(username: string): Promise<string | null> {
    this.accounts ??= this.client
      .accounts()
      .then((list) => new Set(list.map((a) => a.username)))
      .catch(() => null);
    const known = await this.accounts;
    return known === null || known.has(username) ? username : null;
  }

  /** Roles are part of the instance configuration and are not created by the migration. */
  async role(name: string): Promise<ToNamed | null> {
    this.roleList ??= this.client.roles().catch(() => []);
    return (await this.roleList).find((r) => r.name.toLowerCase() === name.trim().toLowerCase()) ?? null;
  }

  /** Statuses belong to workflows and are not created by the migration. */
  async status(name: string): Promise<ToNamed | null> {
    this.statuses ??= this.client.statuses();
    return (await this.statuses).find((s) => s.name.toLowerCase() === name.trim().toLowerCase()) ?? null;
  }
}
