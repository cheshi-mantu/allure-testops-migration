import type { TestOpsClient, ToNamed } from "../testops/client.js";

type Logger = (level: "info" | "warn", message: string) => void;

/**
 * Looks up (and when allowed creates) Allure TestOps objects by name, with caching.
 * Concurrent lookups for the same name share one request, so parallel cases never create duplicates.
 */
export class TargetResolver {
  private readonly customFields = new Map<string, Promise<ToNamed>>();
  private readonly layers = new Map<string, Promise<ToNamed | null>>();
  private statuses: Promise<ToNamed[]> | null = null;
  private layerList: Promise<ToNamed[]> | null = null;
  private projectFields: Promise<ToNamed[]> | null = null;
  private readonly warned = new Set<string>();

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
    const global = (await this.client.suggestCustomFields(name)).find((f) => f.name === name);
    const field = global ?? (await this.client.createCustomField(name));
    if (!global) {
      this.log("info", `Created custom field "${name}".`);
    }
    await this.client.addCustomFieldsToProject(this.projectId, [field.id]);
    return field;
  }

  layer(name: string): Promise<ToNamed | null> {
    const key = name.trim();
    let pending = this.layers.get(key.toLowerCase());
    if (!pending) {
      pending = this.findOrCreateLayer(key);
      this.layers.set(key.toLowerCase(), pending);
    }
    return pending;
  }

  private async findOrCreateLayer(name: string): Promise<ToNamed | null> {
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
      this.warnOnce(`layer:${name}`, `Cannot create test layer "${name}": ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private accounts: Promise<Set<string> | null> | null = null;
  private readonly missingOwners = new Map<string, number>();

  /**
   * Checks that an owner exists before assigning it. When the token cannot list users the name is
   * used as is and a failed assignment is reported by the writer.
   */
  async owner(username: string): Promise<string | null> {
    this.accounts ??= this.client
      .accounts()
      .then((list) => new Set(list.map((a) => a.username)))
      .catch(() => null);
    const known = await this.accounts;
    if (known === null || known.has(username)) {
      return username;
    }
    this.ownerMissing(username);
    return null;
  }

  ownerMissing(username: string) {
    this.missingOwners.set(username, (this.missingOwners.get(username) ?? 0) + 1);
  }

  /** One line per unknown owner instead of a warning per case. */
  reportMissingOwners() {
    for (const [username, count] of this.missingOwners) {
      this.log("warn", `Owner "${username}" is not an Allure TestOps user; ${count} case(s) were left without an owner. Map the TestRail user to an existing user in the field mapping.`);
    }
  }

  /** Statuses belong to workflows and are not created by the migration. */
  async status(name: string): Promise<ToNamed | null> {
    this.statuses ??= this.client.statuses();
    const status = (await this.statuses).find((s) => s.name.toLowerCase() === name.trim().toLowerCase()) ?? null;
    if (!status) {
      this.warnOnce(`status:${name}`, `Status "${name}" does not exist in Allure TestOps; the default status is kept.`);
    }
    return status;
  }

  private warnOnce(key: string, message: string) {
    if (!this.warned.has(key)) {
      this.warned.add(key);
      this.log("warn", message);
    }
  }
}
