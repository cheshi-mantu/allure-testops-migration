import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createTestRailMock } from "@atm/mocks";
import { TestRailConnectionSchema } from "@atm/shared";
import { HttpClient } from "../src/http/httpClient.js";
import { RateLimiter } from "../src/http/rateLimiter.js";
import { TestRailClient } from "../src/testrail/client.js";

/** A TestRail that allows 10 requests per second, standing in for 180 or 300 per minute. */
describe("TestRail rate limit", () => {
  const servers: { close: () => Promise<unknown> }[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  async function start() {
    const stats = { requests: 0, throttled: 0 };
    const server = createTestRailMock({ rateLimit: { requests: 10, windowMs: 1000, retryAfterSeconds: 1 }, stats });
    servers.push(server);
    await server.listen({ port: 0, host: "127.0.0.1" });
    const connection = TestRailConnectionSchema.parse({
      endpoint: `http://127.0.0.1:${(server.server.address() as AddressInfo).port}/`,
      username: "demo@example.com",
      apiKey: "demo-api-key",
    });
    return { stats, connection };
  }

  it("stays under the limit when the limiter is on", async () => {
    const { stats, connection } = await start();
    const http = new HttpClient({
      baseUrl: connection.endpoint,
      headers: { Authorization: `Basic ${Buffer.from("demo@example.com:demo-api-key").toString("base64")}` },
      rateLimiter: new RateLimiter(10, 1000),
    });
    const client = new TestRailClient(connection, http);
    const started = Date.now();
    await Promise.all(Array.from({ length: 25 }, () => client.getProject(1)));
    expect(stats).toEqual({ requests: 25, throttled: 0 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(2000);
  });

  it("still succeeds without the limiter by honouring Retry-After", async () => {
    const { stats, connection } = await start();
    const client = new TestRailClient({ ...connection, rateLimit: "off" });
    const projects = await Promise.all(Array.from({ length: 15 }, () => client.getProject(1)));
    expect(projects.every((p) => p.id === 1)).toBe(true);
    expect(stats.throttled).toBeGreaterThan(0);
  });
});
