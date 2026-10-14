import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createQaseMock, createTestRailMock } from "@atm/mocks";
import { QASE_RATE_LIMITS, QaseConnectionSchema, TestRailConnectionSchema } from "@atm/shared";
import { HttpClient } from "../src/http/httpClient.js";
import { RateLimiter } from "../src/http/rateLimiter.js";
import { QaseClient, qaseRequestsPerWindow } from "../src/qase/client.js";
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

/** A Qase that allows 5 requests per second, standing in for the limits of its plans. */
describe("Qase rate limit", () => {
  it("paces itself by the plan: under the limit per minute and per 10 seconds", () => {
    for (const [plan, perMinute] of Object.entries(QASE_RATE_LIMITS)) {
      const perWindow = qaseRequestsPerWindow({ rateLimit: plan as keyof typeof QASE_RATE_LIMITS });
      expect(perWindow).toBeLessThan(perMinute / 6);
      expect(perWindow * 6).toBeLessThan(perMinute);
    }
    expect(qaseRequestsPerWindow({ rateLimit: "free" })).toBe(20);
  });

  it("waits as long as Qase asks when it answers 429, and loses nothing", async () => {
    const stats = { requests: 0, throttled: 0 };
    const qase = createQaseMock({ rateLimit: { requests: 5, windowMs: 1000, retryAfterSeconds: 1 }, stats });
    await qase.app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const retries: string[] = [];
      const client = new QaseClient(
        QaseConnectionSchema.parse({ endpoint: `http://127.0.0.1:${(qase.app.server.address() as AddressInfo).port}`, apiToken: "demo-qase-token", rateLimit: "enterprise" }),
        (info) => retries.push(info.reason),
      );
      const projects = await Promise.all(Array.from({ length: 12 }, () => client.project("DEMO")));
      expect(projects.every((project) => project.code === "DEMO")).toBe(true);
      expect(stats.throttled).toBeGreaterThan(0);
      expect(retries.some((reason) => reason.includes("429"))).toBe(true);
    } finally {
      await qase.app.close();
    }
  });
});
