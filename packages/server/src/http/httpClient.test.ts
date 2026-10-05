import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpClient, HttpError } from "./httpClient.js";

describe("HttpClient against a server that is not answering from its API", () => {
  let server: Server;
  let base: string;
  const hits = new Map<string, number>();
  // Each path answers with a web page or a 500 this many times, then with JSON.
  const plan: Record<string, { times: number; answer: "webPage" | 500 }> = {
    "/page-once": { times: 1, answer: "webPage" },
    "/page-always": { times: 1000, answer: "webPage" },
    "/error-once": { times: 1, answer: 500 },
  };

  beforeAll(async () => {
    server = createServer((request, response) => {
      const path = request.url!.split("?")[0]!;
      const count = (hits.get(`${request.method} ${path}`) ?? 0) + 1;
      hits.set(`${request.method} ${path}`, count);
      const step = plan[path];
      if (step && count <= step.times) {
        if (step.answer === 500) {
          response.writeHead(500, { "content-type": "application/json" }).end('{"message":"An unexpected error occurred"}');
        } else {
          response.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><html></html>");
        }
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const client = () => new HttpClient({ baseUrl: base, retries: 2, sleep: async () => {} });

  it("repeats a request answered with a web page", async () => {
    await expect(client().json("POST", "page-once", { body: {} })).resolves.toEqual({ ok: true });
    expect(hits.get("POST /page-once")).toBe(2);
  });

  it("reports a web page answer without the page itself when repeating does not help", async () => {
    const error = (await client().get("page-always").catch((e: unknown) => e)) as HttpError;
    expect(error).toBeInstanceOf(HttpError);
    expect(error.notApi).toBe(true);
    expect(error.body).toBe("");
    expect(error.message).toContain("was answered with a web page");
  });

  it("repeats reading after an internal error but not writing", async () => {
    await expect(client().get("error-once")).resolves.toEqual({ ok: true });
    hits.clear();
    plan["/error-once"]!.times = 1;
    await expect(client().json("POST", "error-once", { body: {} })).rejects.toMatchObject({ status: 500 });
    expect(hits.get("POST /error-once")).toBe(1);
  });
});
