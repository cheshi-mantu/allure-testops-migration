import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ProfileSchema, type Profile } from "@atm/shared";
import { assertSafeId, readJson, writeJsonAtomic } from "./files.js";

export class ProfileStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "profiles");
  }

  private path(id: string): string {
    return join(this.dir, `${assertSafeId(id)}.json`);
  }

  async list(): Promise<Profile[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return [];
    }
    const profiles: Profile[] = [];
    for (const file of files.filter((f) => f.endsWith(".json"))) {
      const profile = await this.get(file.slice(0, -".json".length)).catch(() => null);
      if (profile) {
        profiles.push(profile);
      }
    }
    return profiles.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<Profile | null> {
    const raw = await readJson<unknown>(this.path(id));
    return raw === null ? null : ProfileSchema.parse(raw);
  }

  async save(profile: Profile): Promise<Profile> {
    const valid = ProfileSchema.parse(profile);
    await writeJsonAtomic(this.path(valid.id), valid);
    return valid;
  }

  async delete(id: string): Promise<void> {
    await rm(this.path(id), { force: true });
  }
}
