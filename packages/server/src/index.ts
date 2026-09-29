import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { RunManager } from "./engine/runner.js";
import { registerApi } from "./routes/api.js";
import { ProfileStore } from "./storage/profiles.js";
import { RunStore } from "./storage/runs.js";

const here = dirname(fileURLToPath(import.meta.url));

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "0.0.0.0";
const dataDir = resolve(process.env.DATA_DIR ?? join(process.cwd(), ".data"));
const webDir = resolve(process.env.WEB_DIR ?? join(here, "../../web/dist"));

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
  bodyLimit: 20 * 1024 * 1024,
});

const runs = new RunStore(dataDir);
await registerApi(app, { profiles: new ProfileStore(dataDir), runs, runner: new RunManager(runs) });

if (existsSync(webDir)) {
  await app.register(fastifyStatic, {
    root: webDir,
    // Hashed assets can be cached forever; index.html must always be fresh.
    setHeaders: (reply, path) => {
      reply.header("Cache-Control", path.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
    },
  });
  // Client side routing: unknown non-API paths serve the app.
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.status(404).send({ message: "Not found" });
    }
    return reply.header("Cache-Control", "no-cache").sendFile("index.html");
  });
} else {
  app.log.warn(`UI not found at ${webDir}; only the API is served.`);
}

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ port, host });
app.log.info(`Data directory: ${dataDir}`);
