import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  maskSecrets,
  newProfile,
  PROFILE_FORMAT_VERSION,
  ProfileSchema,
  restoreSecrets,
  SOURCES,
  type CsvFilePreview,
  type PlannedCase,
  type StoredFileInfo,
  type Profile,
  type ProfileListItem,
} from "@atm/shared";
import { transformCase } from "../convert/transform.js";
import type { RunManager } from "../engine/runner.js";
import type { ProfileStore } from "../storage/profiles.js";
import type { RunStore } from "../storage/runs.js";
import { TestOpsClient } from "../testops/client.js";
import { TestRailClient } from "../testrail/client.js";
import { discoverTestOps } from "../testops/discovery.js";
import { discoverTestRail, loadTestRailContext } from "../testrail/discovery.js";
import { groupCases } from "../csv/cases.js";
import { analyseColumns, discoverCsv, loadCsv } from "../csv/discovery.js";
import { prepareSource } from "../engine/sources.js";
import type { FileStore } from "../storage/fileStore.js";
import { checkTestOps, checkTestRail } from "./checks.js";

export interface ApiDeps {
  files: FileStore;
  profiles: ProfileStore;
  runs: RunStore;
  runner: RunManager;
}

class NotFound extends Error {}

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

function newId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

export async function registerApi(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const { profiles, runs, runner, files } = deps;

  app.addContentTypeParser(["application/octet-stream", "text/csv", "application/vnd.ms-excel"], { parseAs: "buffer", bodyLimit: MAX_UPLOAD_BYTES }, (_request, body, done) =>
    done(null, body),
  );

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof NotFound) {
      return reply.status(404).send({ message: error.message });
    }
    if (error instanceof z.ZodError) {
      return reply.status(400).send({ message: "Invalid data", issues: error.issues });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.status(status).send({ message: (error as Error).message });
    }
    app.log.error(error);
    // Errors from remote systems are safe to show: they never contain credentials.
    return reply.status(502).send({ message: error instanceof Error ? error.message : String(error) });
  });

  const load = async (id: string): Promise<Profile> => {
    const profile = await profiles.get(id);
    if (!profile) {
      throw new NotFound("Profile not found");
    }
    return profile;
  };

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/profiles", async (): Promise<ProfileListItem[]> => {
    const all = await profiles.list();
    const fileNames = new Map((await files.list()).map((f) => [f.id, f.name]));
    return Promise.all(
      all.map(async (profile) => ({
        id: profile.id,
        name: profile.name,
        source: profile.source,
        fileName: profile.csv.fileId ? (fileNames.get(profile.csv.fileId) ?? null) : null,
        updatedAt: profile.updatedAt,
        testrailEndpoint: profile.testrail.connection.endpoint,
        testopsEndpoint: profile.testops.connection.endpoint,
        lastRun: (await runs.list(profile.id))[0] ?? null,
      })),
    );
  });

  app.post("/api/profiles", async (request) => {
    const { name, source } = z.object({ name: z.string().trim().min(1), source: z.enum(SOURCES).default("testrail") }).parse(request.body);
    return maskSecrets(await profiles.save(newProfile(newId(), name, new Date(), source)));
  });

  app.get<{ Params: { id: string } }>("/api/profiles/:id", async (request) => maskSecrets(await load(request.params.id)));

  app.put<{ Params: { id: string } }>("/api/profiles/:id", async (request) => {
    const stored = await load(request.params.id);
    const incoming = restoreSecrets(ProfileSchema.parse(request.body), stored);
    const saved = await profiles.save({ ...incoming, id: stored.id, createdAt: stored.createdAt, updatedAt: new Date().toISOString() });
    return maskSecrets(saved);
  });

  app.delete<{ Params: { id: string } }>("/api/profiles/:id", async (request, reply) => {
    if (runner.activeRun(request.params.id)) {
      return reply.status(409).send({ message: "Stop the running migration first." });
    }
    await profiles.delete(request.params.id);
    await runs.deleteProfileRuns(request.params.id);
    return reply.status(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/profiles/:id/duplicate", async (request) => {
    const source = await load(request.params.id);
    const now = new Date().toISOString();
    return maskSecrets(await profiles.save({ ...source, id: newId(), name: `${source.name} (copy)`, createdAt: now, updatedAt: now }));
  });

  app.get<{ Params: { id: string }; Querystring: { includeSecrets?: string } }>("/api/profiles/:id/export", async (request, reply) => {
    const profile = await load(request.params.id);
    const includeSecrets = request.query.includeSecrets === "true";
    const exported = includeSecrets ? profile : maskSecrets(profile, "strip");
    const fileName = `${profile.name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "profile"}.migration.json`;
    return reply
      .header("Content-Type", "application/json; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${fileName}"`)
      .send(JSON.stringify({ ...exported, exportedAt: new Date().toISOString() }, null, 2));
  });

  app.post("/api/profiles/import", async (request) => {
    const body = z.object({ profile: z.unknown(), name: z.string().optional() }).parse(request.body);
    const raw = body.profile as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object") {
      throw Object.assign(new Error("The file is not a migration profile."), { statusCode: 400 });
    }
    if (raw.formatVersion !== undefined && raw.formatVersion !== PROFILE_FORMAT_VERSION) {
      throw Object.assign(new Error(`Unsupported profile format version ${String(raw.formatVersion)}.`), { statusCode: 400 });
    }
    const now = new Date().toISOString();
    const parsed = ProfileSchema.parse({
      ...raw,
      id: newId(),
      name: body.name?.trim() || (typeof raw.name === "string" && raw.name) || "Imported profile",
      createdAt: now,
      updatedAt: now,
    });
    // A masked value in an export means "secret not included".
    return maskSecrets(await profiles.save(restoreSecrets(parsed, maskSecrets(parsed, "strip"))));
  });

  // ------------------------------------------------------------ connections and discovery

  app.post<{ Params: { id: string } }>("/api/profiles/:id/testrail/check", async (request) => checkTestRail(await load(request.params.id)));
  app.post<{ Params: { id: string } }>("/api/profiles/:id/testops/check", async (request) => checkTestOps(await load(request.params.id)));

  app.get<{ Params: { id: string } }>("/api/profiles/:id/testrail/suites", async (request) => {
    const profile = await load(request.params.id);
    const projectId = profile.testrail.scope.projectId;
    if (!projectId) {
      return { suiteMode: 1, suites: [] };
    }
    const client = new TestRailClient(profile.testrail.connection);
    const [project, suites] = await Promise.all([client.getProject(projectId), client.getSuites(projectId)]);
    return { suiteMode: project.suite_mode, suites: suites.map((s) => ({ id: s.id, name: s.name })) };
  });

  const discoverSource = async (profile: Profile) => (profile.source === "csv" ? discoverCsv(profile, files) : discoverTestRail(profile));
  app.post<{ Params: { id: string } }>("/api/profiles/:id/source/discover", async (request) => discoverSource(await load(request.params.id)));
  app.post<{ Params: { id: string } }>("/api/profiles/:id/testrail/discover", async (request) => discoverSource(await load(request.params.id)));

  // ------------------------------------------------------------ file library

  const filesWithUsage = async (): Promise<StoredFileInfo[]> => {
    const [list, all] = await Promise.all([files.list(), profiles.list()]);
    return list.map((file) => ({
      ...file,
      usedBy: all.filter((p) => p.source === "csv" && p.csv.fileId === file.id).map((p) => ({ id: p.id, name: p.name })),
    }));
  };

  app.get("/api/files", async () => filesWithUsage());

  app.post<{ Querystring: { name?: string } }>(
    "/api/files",
    { bodyLimit: MAX_UPLOAD_BYTES },
    async (request) => {
      const data = request.body;
      if (!Buffer.isBuffer(data) || data.length === 0) {
        throw Object.assign(new Error("The file is empty."), { statusCode: 400 });
      }
      return files.save(request.query.name ?? "file.csv", data);
    },
  );

  app.delete<{ Params: { fileId: string } }>("/api/files/:fileId", async (request, reply) => {
    const usedBy = (await filesWithUsage()).find((f) => f.id === request.params.fileId)?.usedBy ?? [];
    if (usedBy.length > 0) {
      return reply.status(409).send({ message: `The file is used by ${usedBy.map((p) => `"${p.name}"`).join(", ")}.` });
    }
    await files.delete(request.params.fileId);
    return reply.status(204).send();
  });

  app.get<{ Params: { id: string } }>("/api/profiles/:id/csv/preview", async (request): Promise<CsvFilePreview> => {
    const profile = await load(request.params.id);
    const { table } = await loadCsv(profile, files);
    const grouped = groupCases(table, analyseColumns(profile, table).effective);
    return {
      delimiter: table.delimiter,
      encoding: table.encoding,
      columns: table.columns,
      rows: table.rows.slice(0, 20).map((row) => table.columns.map((c) => row[c] ?? "")),
      rowCount: table.rows.length,
      caseCount: grouped.cases.length,
      multiRow: grouped.multiRow,
      warnings: table.warnings,
    };
  });
  app.post<{ Params: { id: string } }>("/api/profiles/:id/testops/discover", async (request) => discoverTestOps(await load(request.params.id)));

  app.get<{ Params: { id: string }; Querystring: { name?: string } }>("/api/profiles/:id/testops/cf-values", async (request) => {
    const profile = await load(request.params.id);
    const name = request.query.name?.trim();
    if (!name) {
      return [];
    }
    const client = new TestOpsClient(profile.testops.connection);
    const field = (await client.suggestCustomFields(name)).find((f) => f.name === name);
    if (!field) {
      return [];
    }
    return (await client.customFieldValues(field.id)).map((value) => value.name).sort((a, b) => a.localeCompare(b));
  });

  app.post<{ Params: { id: string } }>("/api/profiles/:id/preview", async (request): Promise<PlannedCase & { linkedCaseIds: string[] }> => {
    const { caseId: rawId } = z.object({ caseId: z.coerce.string().trim().min(1) }).parse(request.body);
    const profile = await load(request.params.id);
    if (profile.source === "csv") {
      const source = await prepareSource(profile, { files }, () => undefined);
      const cases = await source.readCases(() => undefined, () => false);
      const wanted = rawId.toLowerCase();
      const testCase = cases.find((c) => c.key.toLowerCase() === wanted) ?? cases.find((c) => c.title.toLowerCase() === wanted);
      if (!testCase) {
        throw Object.assign(new Error(`No case "${rawId}" in the file.`), { statusCode: 404 });
      }
      const { planned, linkedCaseIds } = source.transform(testCase);
      return { ...planned, linkedCaseIds };
    }
    const caseId = Number(rawId.replace(/^C/i, ""));
    if (!Number.isInteger(caseId) || caseId <= 0) {
      throw Object.assign(new Error(`"${rawId}" is not a TestRail case id.`), { statusCode: 400 });
    }
    const context = await loadTestRailContext(profile);
    const testCase = await context.client.getCase(caseId);
    const { planned, linkedCaseIds } = transformCase(testCase, {
      catalog: context.catalog,
      profile,
      endpoint: context.client.endpoint,
      project: context.project,
      suites: new Map(context.suites.map((s) => [s.id, s])),
      sections: context.sections,
    });
    if (!context.sections.has(testCase.suite_id)) {
      planned.notes.push("This case belongs to a suite that is not selected for migration.");
    }
    for (const step of planned.scenario) {
      if (step.type === "shared") {
        step.name = await context.client.getSharedStep(step.sourceId).then((s) => s.title).catch(() => `Shared step ${step.sourceId}`);
      }
    }
    return { ...planned, linkedCaseIds };
  });

  // ------------------------------------------------------------ runs

  app.get<{ Params: { id: string } }>("/api/profiles/:id/runs", async (request) => {
    await load(request.params.id);
    const list = await runs.list(request.params.id);
    const active = runner.activeRun(request.params.id);
    // The active run's file may lag behind; show its live summary.
    return active ? [active.summary, ...list.filter((r) => r.id !== active.summary.id)] : list;
  });

  app.post<{ Params: { id: string } }>("/api/profiles/:id/runs", async (request, reply) => {
    const { dryRun } = z.object({ dryRun: z.boolean().default(false) }).parse(request.body ?? {});
    const profile = await load(request.params.id);
    try {
      return runner.start(profile, dryRun);
    } catch (error) {
      return reply.status(409).send({ message: (error as Error).message });
    }
  });

  app.post<{ Params: { id: string } }>("/api/profiles/:id/runs/cancel", async (request) => ({ cancelled: runner.cancel(request.params.id) }));

  app.get<{ Params: { id: string; runId: string }; Querystring: { after?: string } }>("/api/profiles/:id/runs/:runId/log", async (request) =>
    runs.log(request.params.id, request.params.runId, Number(request.query.after ?? 0)),
  );

  app.get<{ Params: { id: string; runId: string } }>("/api/profiles/:id/runs/:runId/events", async (request, reply) => {
    const { id, runId } = request.params;
    streamRun(reply, deps, id, runId);
  });
}

/** Server-sent events: past log first, then live updates until the run ends. */
function streamRun(reply: FastifyReply, deps: ApiDeps, profileId: string, runId: string) {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (event: string, data: unknown) => raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const run = deps.runner.activeRun(profileId);
  if (!run || run.summary.id !== runId) {
    void (async () => {
      const summary = await deps.runs.get(profileId, runId);
      for (const entry of await deps.runs.log(profileId, runId)) {
        send("log", entry);
      }
      send("summary", summary);
      send("end", {});
      raw.end();
    })();
    return;
  }
  let lastSeq = 0;
  let replaying = true;
  const buffered: Parameters<Parameters<typeof run.subscribe>[0]>[0][] = [];
  const handle = (event: Parameters<Parameters<typeof run.subscribe>[0]>[0]) => {
    if (event.type === "log") {
      if (event.entry.seq > lastSeq) {
        lastSeq = event.entry.seq;
        send("log", event.entry);
      }
    } else {
      send("summary", event.summary);
      if (event.summary.status !== "running") {
        send("end", {});
        unsubscribe();
        clearInterval(keepAlive);
        raw.end();
      }
    }
  };
  const unsubscribe = run.subscribe((event) => (replaying ? buffered.push(event) : handle(event)));
  const keepAlive = setInterval(() => raw.write(": keep-alive\n\n"), 15_000);
  raw.on("close", () => {
    unsubscribe();
    clearInterval(keepAlive);
  });
  void (async () => {
    await run.flush();
    for (const entry of await deps.runs.log(profileId, runId)) {
      if (entry.seq > lastSeq) {
        lastSeq = entry.seq;
        send("log", entry);
      }
    }
    replaying = false;
    buffered.forEach(handle);
    if (run.summary.status === "running") {
      send("summary", run.summary);
    }
  })();
}
