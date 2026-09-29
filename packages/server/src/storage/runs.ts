import { appendFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { RunLogEntry, RunSummary } from "@atm/shared";
import { assertSafeId, readJson, writeJsonAtomic } from "./files.js";

/** Run summaries and logs: `<data>/runs/<profileId>/<runId>.json` and `.log.ndjson`. */
export class RunStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "runs");
  }

  private profileDir(profileId: string): string {
    return join(this.dir, assertSafeId(profileId));
  }

  async save(summary: RunSummary): Promise<void> {
    await writeJsonAtomic(join(this.profileDir(summary.profileId), `${assertSafeId(summary.id)}.json`), summary);
  }

  async appendLog(profileId: string, runId: string, entries: RunLogEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    const dir = this.profileDir(profileId);
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, `${assertSafeId(runId)}.log.ndjson`), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }

  async list(profileId: string): Promise<RunSummary[]> {
    let files: string[];
    try {
      files = await readdir(this.profileDir(profileId));
    } catch {
      return [];
    }
    const runs: RunSummary[] = [];
    for (const file of files.filter((f) => f.endsWith(".json"))) {
      const run = await readJson<RunSummary>(join(this.profileDir(profileId), file)).catch(() => null);
      if (run) {
        runs.push(run);
      }
    }
    return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async get(profileId: string, runId: string): Promise<RunSummary | null> {
    return readJson<RunSummary>(join(this.profileDir(profileId), `${assertSafeId(runId)}.json`));
  }

  async log(profileId: string, runId: string, afterSeq = 0, limit = 5000): Promise<RunLogEntry[]> {
    try {
      const text = await readFile(join(this.profileDir(profileId), `${assertSafeId(runId)}.log.ndjson`), "utf8");
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RunLogEntry)
        .filter((entry) => entry.seq > afterSeq)
        .slice(-limit);
    } catch {
      return [];
    }
  }

  async deleteProfileRuns(profileId: string): Promise<void> {
    await rm(this.profileDir(profileId), { recursive: true, force: true });
  }
}
