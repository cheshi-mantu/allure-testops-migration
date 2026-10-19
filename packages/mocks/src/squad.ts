import { createHash, createHmac } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

/**
 * Fake old Zephyr Squad on Jira Cloud: the subset of Jira REST v3 the migration uses under `/rest`,
 * and the Zephyr Squad API (ZAPI) under `/connect`, on one server. Project CALC with tests that are
 * Jira issues of type Test: steps in Jira wiki markup, step files named in the step list or found by
 * search, a long step list answered in pages, Jira fields, comments, links and attachments.
 *
 * Jira: Basic demo@example.com / demo-jira-token. ZAPI: access key demo-access-key and secret key
 * demo-secret-key; every request must carry `zapiAccessKey` and a JWT signed with the secret key for
 * the account of the Jira user, with the query string hash of that very request.
 */

export interface SquadMockOptions {
  jiraEmail?: string;
  jiraToken?: string;
  accessKey?: string;
  secretKey?: string;
}

export interface SquadMockState {
  requests: { method: string; url: string }[];
  /** Why ZAPI requests were rejected, for tests. */
  rejected: string[];
  downloads: string[];
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const JANE = { accountId: "5b10a2844c20165700ede21g", displayName: "Jane Doe", emailAddress: "jane@example.com" };
const SAM = { accountId: "557058:f58131cb-b67d-43c7-b30d-6b58d40bd077", displayName: "Sam Tester" };

const FIELDS = [
  { id: "summary", name: "Summary", custom: false, schema: { type: "string", system: "summary" } },
  { id: "description", name: "Description", custom: false, schema: { type: "string", system: "description" } },
  { id: "labels", name: "Labels", custom: false, schema: { type: "array", items: "string", system: "labels" } },
  { id: "priority", name: "Priority", custom: false, schema: { type: "priority", system: "priority" } },
  { id: "components", name: "Components", custom: false, schema: { type: "array", items: "component", system: "components" } },
  { id: "assignee", name: "Assignee", custom: false, schema: { type: "user", system: "assignee" } },
  { id: "reporter", name: "Reporter", custom: false, schema: { type: "user", system: "reporter" } },
  { id: "status", name: "Status", custom: false, schema: { type: "status", system: "status" } },
  { id: "issuetype", name: "Issue Type", custom: false, schema: { type: "issuetype", system: "issuetype" } },
  { id: "project", name: "Project", custom: false, schema: { type: "project", system: "project" } },
  { id: "attachment", name: "Attachment", custom: false, schema: { type: "array", items: "attachment", system: "attachment" } },
  { id: "comment", name: "Comment", custom: false, schema: { type: "comments-page", system: "comment" } },
  { id: "issuelinks", name: "Linked Issues", custom: false, schema: { type: "array", items: "issuelinks", system: "issuelinks" } },
  { id: "customfield_10100", name: "Automation", custom: true, schema: { type: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:select" } },
  { id: "customfield_10200", name: "Zephyr Teststep", custom: true, schema: { type: "any", custom: "com.thed.zephyr.je:zephyr-je-customfield-teststep" } },
];

interface MockStep {
  id: string;
  orderId: number;
  step: string;
  data: string;
  result: string;
  /** Files named in the step list. */
  attachments?: { id: string; name: string; fileExtension: string }[];
  /** Files only the attachment search gives. */
  searchable?: { id: string; name: string; fileExtension: string }[];
}

interface MockIssue {
  id: string;
  key: string;
  summary: string;
  issueType: string;
  fields: Record<string, unknown>;
  rendered: Record<string, unknown>;
  steps: MockStep[];
  /** The step list as a page of an object with `testSteps` and `totalCount`, not a plain list. */
  paged?: boolean;
}

function issues(base: string): MockIssue[] {
  return [
    {
      id: "10001",
      key: "CALC-1",
      summary: "Log in with a valid password",
      issueType: "Test",
      fields: {
        description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Checks the login form." }] }] },
        labels: ["smoke", "login"],
        priority: { name: "High" },
        components: [{ name: "Auth" }],
        assignee: JANE,
        reporter: SAM,
        status: { name: "To Do" },
        customfield_10100: { value: "Manual" },
        customfield_10200: "steps are kept by Zephyr Squad",
        attachment: [{ id: "20001", filename: "login.png", mimeType: "image/png", content: `${base}/rest/api/3/attachment/content/20001` }],
        comment: { comments: [{ id: "1", body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Reviewed" }] }] } }] },
        issuelinks: [{ type: { name: "Test", inward: "is tested by", outward: "tests" }, outwardIssue: { key: "CALC-50", fields: { summary: "Login story" } } }],
      },
      rendered: {
        description: `<p>Checks the <b>login</b> form.</p><p><span class="image-wrap"><img src="${base}/rest/api/3/attachment/content/20001" /></span></p>`,
        comment: { comments: [{ body: "<p>Reviewed by <b>QA</b></p>" }] },
      },
      steps: [
        { id: "0001-a", orderId: 1, step: "Open the *login* page", data: "url: {{/login}}", result: "The form is shown", attachments: [] },
        { id: "0001-b", orderId: 2, step: "Enter _jane_ and the password", data: "", result: "The dashboard opens", attachments: [{ id: "att-1", name: "dashboard.png", fileExtension: "png" }] },
        { id: "0001-c", orderId: 3, step: "", data: "", result: "The name is shown in the header", attachments: [] },
      ],
    },
    {
      id: "10002",
      key: "CALC-2",
      summary: "Pay by card",
      issueType: "Test",
      fields: { labels: ["checkout"], priority: { name: "Medium" }, assignee: SAM, customfield_10100: { value: "Automated" }, attachment: [], issuelinks: [] },
      rendered: {},
      paged: true,
      steps: [
        { id: "0002-a", orderId: 1, step: "Add a phone to the cart", data: "", result: "" },
        { id: "0002-b", orderId: 2, step: "Pay with the card", data: "||Card||CVC||\n|4111 1111 1111 1111|123|", result: "The order is placed", searchable: [{ id: "att-2", name: "cards.csv", fileExtension: "csv" }] },
        { id: "0002-c", orderId: 3, step: "Open *My orders*", data: "", result: "The order is listed" },
      ],
    },
    {
      id: "10003",
      key: "CALC-3",
      summary: "A test without steps",
      issueType: "Test",
      fields: { labels: [], attachment: [], issuelinks: [] },
      rendered: {},
      steps: [],
    },
    {
      id: "10004",
      key: "CALC-4",
      summary: "Not a test",
      issueType: "Task",
      fields: { labels: [], attachment: [], issuelinks: [] },
      rendered: {},
      steps: [],
    },
  ];
}

/** Matches the JQL the migration writes: project, issue type, key list, key, a label filter. */
function matches(issue: MockIssue, jql: string): boolean {
  const value = (pattern: RegExp) => pattern.exec(jql)?.[1];
  const project = value(/project\s*=\s*"?([\w-]+)"?/i);
  if (project && !issue.key.startsWith(`${project}-`)) {
    return false;
  }
  const type = value(/issuetype\s*=\s*"([^"]+)"/i);
  if (type && issue.issueType !== type) {
    return false;
  }
  const keys = value(/key in \(([^)]*)\)/i)?.split(",").map((k) => k.trim().replace(/"/g, ""));
  if (keys && !keys.includes(issue.key)) {
    return false;
  }
  const key = value(/key\s*=\s*"([^"]+)"/i);
  if (key && issue.key !== key) {
    return false;
  }
  const label = value(/labels\s*=\s*"?([\w-]+)"?/i);
  return !label || ((issue.fields.labels as string[] | undefined) ?? []).includes(label);
}

const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The query string hash of a request below `/connect`, written independently of the client. */
function qsh(method: string, rawUrl: string): string {
  const url = new URL(rawUrl, "http://mock");
  const path = url.pathname.replace(/^\/connect/, "") || "/";
  const params = [...url.searchParams.entries()].filter(([name]) => name !== "jwt");
  const names = [...new Set(params.map(([name]) => name))].sort((a, b) => (encode(a) < encode(b) ? -1 : 1));
  const query = names.map((name) => `${encode(name)}=${params.filter(([n]) => n === name).map(([, v]) => encode(v)).sort().join(",")}`).join("&");
  return createHash("sha256").update(`${method}&${path}&${query}`).digest("hex");
}

export function createSquadMock(options: SquadMockOptions = {}): { app: FastifyInstance; state: SquadMockState } {
  const app = Fastify({ logger: false });
  const basic = `Basic ${Buffer.from(`${options.jiraEmail ?? "demo@example.com"}:${options.jiraToken ?? "demo-jira-token"}`).toString("base64")}`;
  const accessKey = options.accessKey ?? "demo-access-key";
  const secretKey = options.secretKey ?? "demo-secret-key";
  const state: SquadMockState = { requests: [], rejected: [], downloads: [] };
  let base = "";
  const data = () => issues(base);
  const byId = (id: string) => data().find((issue) => issue.id === id);

  /** Why a ZAPI request is not allowed, or null. */
  const rejection = (request: FastifyRequest): string | null => {
    if (request.headers.zapiaccesskey !== accessKey) {
      return "zapiAccessKey header missing or wrong";
    }
    const auth = String(request.headers.authorization ?? "");
    const token = /^JWT (.+)$/.exec(auth)?.[1];
    if (!token) {
      return "no JWT";
    }
    const [header, payload, signature] = token.split(".");
    if (!header || !payload || !signature) {
      return "malformed JWT";
    }
    if (createHmac("sha256", secretKey).update(`${header}.${payload}`).digest("base64url") !== signature) {
      return "bad signature";
    }
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as { iss?: string; sub?: string; qsh?: string; exp?: number };
    if (claims.iss !== accessKey) {
      return "iss is not the access key";
    }
    if (claims.sub !== JANE.accountId) {
      return "sub is not the account of the user the keys belong to";
    }
    if (!claims.exp || claims.exp * 1000 < Date.now()) {
      return "expired";
    }
    if (claims.qsh !== qsh(request.method, request.url)) {
      return "qsh does not match the request";
    }
    return null;
  };

  app.addHook("onRequest", async (request, reply) => {
    state.requests.push({ method: request.method, url: request.url });
    base ||= `${request.protocol}://${request.headers.host}`;
    if (request.url.startsWith("/rest/") && request.headers.authorization !== basic) {
      return reply.status(401).send({ errorMessages: ["Client must be authenticated to access this resource."] });
    }
    if (request.url.startsWith("/connect/")) {
      const why = rejection(request);
      if (why) {
        state.rejected.push(why);
        return reply.status(401).send({ clientMessage: "Authentication failed", errorCode: 101, errorType: "ERROR" });
      }
    }
  });

  // ------------------------------------------------------------------ ZAPI
  app.get("/connect/public/rest/api/1.0/serverinfo", async () => ({ addonServerInfo: { version: "mock", name: "zephyr-connect" }, jiraServerInfo: { version: "1001.0.0" } }));
  app.get("/connect/public/rest/api/2.0/teststep/:issueId", async (request, reply) => {
    const issue = byId((request.params as { issueId: string }).issueId);
    const query = request.query as { projectId?: string; offsetOpt?: string };
    if (!issue || query.projectId !== "10000") {
      return reply.status(400).send({ clientMessage: "Issue or project not found", errorCode: 151 });
    }
    const steps = issue.steps.map(({ searchable: _searchable, ...step }) => ({ ...step, issueId: Number(issue.id), createdBy: JANE.accountId, createdOn: 1_700_000_000_000 }));
    if (!issue.paged) {
      return steps;
    }
    const offset = Number(query.offsetOpt ?? 0);
    return { testSteps: steps.slice(offset, offset + 2), totalCount: steps.length };
  });
  app.get("/connect/public/rest/api/1.0/attachment/search/teststep", async (request) => {
    const { entityId, issueId } = request.query as { entityId?: string; issueId?: string };
    const step = byId(issueId ?? "")?.steps.find((s) => s.id === entityId);
    return (step?.searchable ?? step?.attachments ?? []).map((file) => ({ ...file, entityId, entityType: "teststep", size: 68 }));
  });
  app.get("/connect/public/rest/api/1.0/attachment/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { issueId } = request.query as { issueId?: string };
    const file = byId(issueId ?? "")?.steps.flatMap((s) => [...(s.attachments ?? []), ...(s.searchable ?? [])]).find((f) => f.id === id);
    if (!file) {
      return reply.status(404).send({ clientMessage: "Attachment not found" });
    }
    state.downloads.push(id);
    return file.name.endsWith(".csv") ? reply.type("text/csv").send("card,cvc\n4111,123\n") : reply.type("image/png").send(PNG);
  });

  // ------------------------------------------------------------------ Jira
  app.get("/rest/api/3/myself", async () => ({ ...JANE, displayName: "Jane Doe" }));
  app.get("/rest/api/3/project/search", async () => ({ values: [{ id: "10000", key: "CALC", name: "Calculator" }], isLast: true }));
  app.get("/rest/api/3/project/:key", async (request: FastifyRequest, reply: FastifyReply) => {
    const { key } = request.params as { key: string };
    return key === "CALC" ? { id: "10000", key: "CALC", name: "Calculator" } : reply.status(404).send({ errorMessages: [`No project could be found with key '${key}'.`] });
  });
  app.get("/rest/api/3/field", async () => FIELDS);
  app.post("/rest/api/3/search/approximate-count", async (request) => ({ count: data().filter((issue) => matches(issue, (request.body as { jql: string }).jql)).length }));
  app.post("/rest/api/3/search/jql", async (request) => {
    const body = request.body as { jql: string; maxResults?: number; nextPageToken?: string | null };
    const found = data().filter((issue) => matches(issue, body.jql)).sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
    const offset = Number(body.nextPageToken ?? 0);
    const size = Math.min(body.maxResults ?? 50, 2);
    const page = found.slice(offset, offset + size);
    const last = offset + size >= found.length;
    return {
      issues: page.map((issue) => ({
        id: issue.id,
        key: issue.key,
        fields: { summary: issue.summary, issuetype: { name: issue.issueType }, project: { id: "10000", key: "CALC" }, ...issue.fields },
        renderedFields: issue.rendered,
      })),
      ...(last ? { isLast: true } : { isLast: false, nextPageToken: String(offset + size) }),
    };
  });
  app.get("/rest/api/3/attachment/content/:id", async (_request, reply) => reply.type("image/png").send(PNG));

  return { app, state };
}
