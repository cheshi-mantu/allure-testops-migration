import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertSafeId, readJson, writeJsonAtomic } from "./files.js";

export interface StoredFile {
  id: string;
  name: string;
  size: number;
  uploadedAt: string;
}

/** Uploaded source files, e.g. CSV exports, kept in `<data>/files/<id>/` so several profiles can reuse them. */
export class FileStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "files");
  }

  private folder(id: string): string {
    return join(this.dir, assertSafeId(id));
  }

  async save(name: string, data: Buffer): Promise<StoredFile> {
    const id = randomUUID().replace(/-/g, "").slice(0, 12);
    const info: StoredFile = {
      id,
      name: name.replace(/[\\/]/g, "_").trim() || "file.csv",
      size: data.length,
      uploadedAt: new Date().toISOString(),
    };
    await mkdir(this.folder(id), { recursive: true });
    await writeFile(join(this.folder(id), "content"), data, { mode: 0o600 });
    await writeJsonAtomic(join(this.folder(id), "meta.json"), info);
    return info;
  }

  async list(): Promise<StoredFile[]> {
    let ids: string[];
    try {
      ids = await readdir(this.dir);
    } catch {
      return [];
    }
    const files: StoredFile[] = [];
    for (const id of ids) {
      const info = await this.get(id).catch(() => null);
      if (info) {
        files.push(info);
      }
    }
    return files.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  }

  get(id: string): Promise<StoredFile | null> {
    return readJson<StoredFile>(join(this.folder(id), "meta.json"));
  }

  async read(id: string): Promise<{ info: StoredFile; data: Buffer }> {
    const info = await this.get(id);
    if (!info) {
      throw new Error("The CSV file is no longer in the file library. Upload it again on the File step.");
    }
    return { info, data: await readFile(join(this.folder(id), "content")) };
  }

  async rename(id: string, name: string): Promise<StoredFile> {
    const info = await this.get(id);
    if (!info) {
      throw new Error("File not found");
    }
    const renamed = { ...info, name: name.trim() || info.name };
    await writeJsonAtomic(join(this.folder(id), "meta.json"), renamed);
    return renamed;
  }

  async delete(id: string): Promise<void> {
    await rm(this.folder(id), { recursive: true, force: true });
  }
}
