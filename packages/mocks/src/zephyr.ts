import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

/**
 * Fake Zephyr Cloud REST API v2 (Zephyr, formerly Zephyr Scale, and Zephyr Essential) and the
 * subset of Jira Cloud REST v3 the migration uses, on one server: Zephyr under `/v2`, Jira under
 * `/rest`. Project CALC: nested folders, test cases with steps (HTML, test data, step custom fields,
 * step files), a call to another test case with and without parameters, plain text and BDD scripts,
 * statuses, priorities, a component, custom fields of every kind, linked issues and web links, files
 * and a picture in the objective.
 *
 * Zephyr: Bearer demo-zephyr-token. Jira: Basic demo@example.com / demo-jira-token.
 */

export interface ZephyrMockOptions {
  token?: string;
  jiraEmail?: string;
  jiraToken?: string;
  /** Largest page a list returns; Zephyr may lower `maxResults` and says so in the answer. */
  pageSize?: number;
  /** Answer the first request of each test case list with 429 and Retry-After: 0. */
  rateLimitOnce?: boolean;
}

export interface ZephyrMockState {
  requests: { method: string; url: string }[];
  downloads: string[];
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const JANE = { accountId: "5b10a2844c20165700ede21g", displayName: "Jane Doe", emailAddress: "jane@example.com" };
const SAM = { accountId: "557058:f58131cb-b67d-43c7-b30d-6b58d40bd077", displayName: "Sam Tester" };
const ISSUES: Record<string, { key: string; summary: string }> = {
  "10001": { key: "CALC-1", summary: "Login story" },
  "10002": { key: "CALC-2", summary: "Checkout story" },
};

const FOLDERS = [
  { id: 1, parentId: null, name: "Web", index: 0, folderType: "TEST_CASE" },
  { id: 2, parentId: 1, name: "Login", index: 0, folderType: "TEST_CASE" },
  { id: 3, parentId: 1, name: "Checkout", index: 1, folderType: "TEST_CASE" },
  { id: 4, parentId: null, name: "Mobile", index: 1, folderType: "TEST_CASE" },
];
const STATUSES = [
  { id: 1, name: "Draft", color: "#cccccc", default: true, archived: false },
  { id: 2, name: "Approved", color: "#00aa00", default: false, archived: false },
  { id: 3, name: "Deprecated", color: "#aa0000", default: false, archived: false },
];
const PRIORITIES = [
  { id: 11, name: "High", default: false },
  { id: 12, name: "Normal", default: true },
  { id: 13, name: "Low", default: false },
];

interface MockStep {
  id: number;
  inline?: { description?: string | null; testData?: string | null; expectedResult?: string | null; customFields?: Record<string, unknown> };
  testCase?: { testCaseKey: string; parameters?: { name: string; type: string; value: string }[] };
  files?: { id: number; name: string }[];
}

interface MockCase {
  id: number;
  key: string;
  name: string;
  folder: number | null;
  status: number;
  priority: number;
  owner: string | null;
  component: number | null;
  objective: string | null;
  precondition: string | null;
  labels: string[];
  estimatedTime: number | null;
  customFields: Record<string, unknown>;
  issues: { issueId: number; type: string }[];
  webLinks: { url: string; description: string }[];
  steps: MockStep[] | null;
  script: { type: string; text: string } | null;
  files: { id: number; name: string }[];
}

function cases(base: string): MockCase[] {
  return [
    {
      id: 101,
      key: "CALC-T1",
      name: "Login with a valid password",
      folder: 2,
      status: 2,
      priority: 11,
      owner: JANE.accountId,
      component: 10000,
      objective: `<p>Check that a <strong>registered</strong> user can log in.</p><p><img src="${base}/v2/testcases/CALC-T1/attachments/301" /></p>`,
      precondition: "<p>User <b>jane</b> exists</p>",
      labels: ["smoke", "login"],
      estimatedTime: 5_400_000,
      customFields: {
        Automation: "Automated",
        Reviewed: true,
        Notes: "<p>Line one<br>Line two</p>",
        Browsers: ["Chrome", "Firefox"],
        Reviewer: SAM.accountId,
        "Release date": "2026-05-01",
        "Story points": 3,
      },
      issues: [{ issueId: 10001, type: "COVERAGE" }],
      webLinks: [{ url: "https://example.com/spec", description: "Login spec" }],
      steps: [
        {
          id: 1001,
          inline: { description: "<p>Open the <em>login</em> page</p>", testData: "<p>url: /login</p>", expectedResult: "<p>The form is shown</p>", customFields: { Browser: "Chrome" } },
          files: [{ id: 501, name: "form.png" }],
        },
        { id: 1002, inline: { description: "Enter <code>jane</code> and the password", testData: null, expectedResult: "The dashboard opens", customFields: {} } },
      ],
      script: null,
      files: [
        { id: 301, name: "diagram.png" },
        { id: 302, name: "users.csv" },
      ],
    },
    {
      id: 102,
      key: "CALC-T2",
      name: "Checkout as a logged in user",
      folder: 3,
      status: 1,
      priority: 12,
      owner: SAM.accountId,
      component: null,
      objective: "Pay for the cart.",
      precondition: null,
      labels: ["checkout"],
      estimatedTime: null,
      customFields: { Automation: "Manual", Reviewed: false },
      issues: [
        { issueId: 10002, type: "COVERAGE" },
        { issueId: 10001, type: "RELATED" },
      ],
      webLinks: [],
      steps: [
        { id: 1101, testCase: { testCaseKey: "CALC-T1" } },
        { id: 1102, testCase: { testCaseKey: "CALC-T4", parameters: [{ name: "card", type: "MANUAL_INPUT", value: "Visa" }] } },
        { id: 1103, inline: { description: "Confirm the order", testData: null, expectedResult: "<p>The order number is shown</p>" } },
      ],
      script: null,
      files: [],
    },
    {
      id: 103,
      key: "CALC-T3",
      name: "Checkout scenario in BDD",
      folder: 4,
      status: 1,
      priority: 13,
      owner: null,
      component: null,
      objective: null,
      precondition: null,
      labels: [],
      estimatedTime: null,
      customFields: { Automation: "Manual" },
      issues: [],
      webLinks: [],
      steps: null,
      script: { type: "bdd", text: "Feature: Checkout\n  Scenario: Pay\n    Given a cart\n    When I pay\n    Then the order is placed" },
      files: [],
    },
    {
      id: 104,
      key: "CALC-T4",
      name: "Pay with a card",
      folder: 3,
      status: 2,
      priority: 12,
      owner: null,
      component: null,
      objective: null,
      precondition: null,
      labels: [],
      estimatedTime: null,
      customFields: { Automation: "Automated" },
      issues: [],
      webLinks: [],
      steps: [{ id: 1201, inline: { description: "Enter the {card} card", testData: null, expectedResult: "The {card} card is accepted" } }],
      script: null,
      files: [],
    },
    {
      id: 105,
      key: "CALC-T5",
      name: "Title check as plain text",
      folder: null,
      status: 3,
      priority: 12,
      owner: null,
      component: null,
      objective: null,
      precondition: null,
      labels: [],
      estimatedTime: null,
      customFields: { Automation: "Automated" },
      issues: [{ issueId: 99999, type: "RELATED" }],
      webLinks: [],
      steps: null,
      script: { type: "plain", text: "<p>1. Open the app</p><p>2. Check the title</p>" },
      files: [],
    },
  ];
}

function testCaseJson(base: string, c: MockCase) {
  const self = `${base}/v2/testcases/${c.key}`;
  return {
    id: c.id,
    key: c.key,
    name: c.name,
    project: { id: 1, self: `${base}/v2/projects/1` },
    createdOn: "2026-01-10T10:00:00Z",
    objective: c.objective,
    precondition: c.precondition,
    estimatedTime: c.estimatedTime,
    labels: c.labels,
    component: c.component ? { id: c.component, self: `${base}/rest/api/3/component/${c.component}` } : null,
    priority: { id: c.priority, self: `${base}/v2/priorities/${c.priority}` },
    status: { id: c.status, self: `${base}/v2/statuses/${c.status}` },
    folder: c.folder ? { id: c.folder, self: `${base}/v2/folders/${c.folder}` } : null,
    owner: c.owner ? { accountId: c.owner, self: `${base}/rest/api/3/user?accountId=${c.owner}` } : null,
    testScript: { self: `${self}/${c.script ? "testscript" : "teststeps"}` },
    customFields: c.customFields,
    links: {
      self: `${self}/links`,
      issues: c.issues.map((link, index) => ({ id: index + 1, issueId: link.issueId, type: link.type, self: `${base}/v2/links/${index + 1}` })),
      webLinks: c.webLinks.map((link, index) => ({ id: 100 + index, ...link, type: "RELATED" })),
    },
  };
}

function page<T>(request: FastifyRequest, all: T[], cap: number) {
  const query = request.query as { startAt?: string; maxResults?: string };
  const startAt = Number(query.startAt ?? 0);
  const maxResults = Math.min(Number(query.maxResults ?? 10), cap);
  const values = all.slice(startAt, startAt + maxResults);
  return { startAt, maxResults, total: all.length, isLast: startAt + maxResults >= all.length, values };
}

export function createZephyrMock(options: ZephyrMockOptions = {}): { app: FastifyInstance; state: ZephyrMockState } {
  const app = Fastify({ logger: false });
  const bearer = `Bearer ${options.token ?? "demo-zephyr-token"}`;
  const basic = `Basic ${Buffer.from(`${options.jiraEmail ?? "demo@example.com"}:${options.jiraToken ?? "demo-jira-token"}`).toString("base64")}`;
  const cap = options.pageSize ?? 2;
  const state: ZephyrMockState = { requests: [], downloads: [] };
  const limited = new Set<string>();
  let base = "";
  const data = () => cases(base);
  const find = (key: string) => data().find((c) => c.key === key.toUpperCase());

  app.addHook("onRequest", async (request, reply) => {
    state.requests.push({ method: request.method, url: request.url });
    base ||= `${request.protocol}://${request.headers.host}`;
    if (request.url.startsWith("/rest/") && request.headers.authorization !== basic) {
      return reply.status(401).send({ errorMessages: ["Client must be authenticated to access this resource."] });
    }
    if (request.url.startsWith("/v2/") && request.headers.authorization !== bearer) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
  });

  // ------------------------------------------------------------------ Zephyr
  app.get("/v2/healthcheck", async () => ({ status: "UP" }));
  app.get("/v2/projects", async (request) => page(request, [{ id: 1, jiraProjectId: 10000, key: "CALC", enabled: true }, { id: 2, jiraProjectId: 10001, key: "OLD", enabled: false }], cap));
  app.get("/v2/projects/:key", async (request, reply) => {
    const { key } = request.params as { key: string };
    return key === "CALC" || key === "1" ? { id: 1, jiraProjectId: 10000, key: "CALC", enabled: true } : reply.status(404).send({ errorCode: 404, message: `Project '${key}' not found.` });
  });
  app.get("/v2/folders", async (request) => page(request, FOLDERS, cap));
  app.get("/v2/statuses", async (request) => page(request, STATUSES.map((s) => ({ ...s, project: { id: 1 } })), cap));
  app.get("/v2/priorities", async (request) => page(request, PRIORITIES.map((p) => ({ ...p, project: { id: 1 } })), cap));
  app.get("/v2/testcases", async (request, reply) => {
    const query = request.query as { projectKey?: string; folderId?: string; startAt?: string };
    const listKey = `${query.folderId ?? ""}`;
    if (options.rateLimitOnce && !limited.has(listKey) && query.startAt === "0") {
      limited.add(listKey);
      return reply.status(429).header("Retry-After", "0").send({ error: "Rate limit exceeded" });
    }
    const all = data().filter((c) => query.projectKey === "CALC" && (!query.folderId || c.folder === Number(query.folderId)));
    return page(request, all.map((c) => testCaseJson(base, c)), cap);
  });
  app.get("/v2/testcases/:key", async (request, reply) => {
    const c = find((request.params as { key: string }).key);
    return c ? testCaseJson(base, c) : reply.status(404).send({ errorCode: 404, message: "Test case not found." });
  });
  app.get("/v2/testcases/:key/teststeps", async (request, reply) => {
    const c = find((request.params as { key: string }).key);
    if (!c) {
      return reply.status(404).send({ errorCode: 404, message: "Test case not found." });
    }
    if (!c.steps) {
      return reply.status(422).send({ errorCode: 422, message: "The test case has a test script." });
    }
    const steps = c.steps.map((step) =>
      step.testCase
        ? { id: step.id, testCase: { self: `${base}/v2/testcases/${step.testCase.testCaseKey}`, testCaseKey: step.testCase.testCaseKey, parameters: step.testCase.parameters ?? [] } }
        : { id: step.id, inline: { description: null, testData: null, expectedResult: null, customFields: {}, reflectRef: null, ...step.inline } },
    );
    return page(request, steps, cap);
  });
  app.get("/v2/testcases/:key/testscript", async (request, reply) => {
    const c = find((request.params as { key: string }).key);
    if (!c) {
      return reply.status(404).send({ errorCode: 404, message: "Test case not found." });
    }
    return c.script ? { id: c.id * 10, ...c.script } : reply.status(422).send({ errorCode: 422, message: "The test case has steps." });
  });
  app.get("/v2/testcases/:key/attachments", async (request, reply) => {
    const c = find((request.params as { key: string }).key);
    return c && c.files.length > 0 ? { attachments: c.files } : reply.status(404).send({ errorCode: 404, message: "No attachments." });
  });
  const file = (name: string, reply: FastifyReply) => (name.endsWith(".csv") ? reply.type("text/csv").send("user,role\njane,admin\n") : reply.type("application/octet-stream").send(PNG));
  app.get("/v2/testcases/:key/attachments/:id", async (request, reply) => {
    const { key, id } = request.params as { key: string; id: string };
    const found = find(key)?.files.find((f) => String(f.id) === id);
    if (!found) {
      return reply.status(404).send({ errorCode: 404, message: "Attachment not found." });
    }
    state.downloads.push(`${key}/${id}`);
    return file(found.name, reply);
  });
  const stepOf = (key: string, stepId: string) => find(key)?.steps?.find((s) => String(s.id) === stepId);
  app.get("/v2/testcases/:key/teststeps/:stepId/attachments", async (request, reply) => {
    const { key, stepId } = request.params as { key: string; stepId: string };
    const step = stepOf(key, stepId);
    return step?.files?.length ? { attachments: step.files } : reply.status(404).send({ errorCode: 404, message: "No attachments." });
  });
  app.get("/v2/testcases/:key/teststeps/:stepId/attachments/:id", async (request, reply) => {
    const { key, stepId, id } = request.params as { key: string; stepId: string; id: string };
    const found = stepOf(key, stepId)?.files?.find((f) => String(f.id) === id);
    if (!found) {
      return reply.status(404).send({ errorCode: 404, message: "Attachment not found." });
    }
    state.downloads.push(`${key}/${stepId}/${id}`);
    return file(found.name, reply);
  });

  // ------------------------------------------------------------------ Jira
  app.get("/rest/api/3/myself", async () => ({ ...JANE, displayName: "Demo User" }));
  app.get("/rest/api/3/project/search", async () => ({ values: [{ id: "10000", key: "CALC", name: "Calculator" }], isLast: true }));
  app.get("/rest/api/3/project/:key", async (request: FastifyRequest, reply: FastifyReply) => {
    const { key } = request.params as { key: string };
    return key === "CALC" ? { id: "10000", key: "CALC", name: "Calculator" } : reply.status(404).send({ errorMessages: [`No project could be found with key '${key}'.`] });
  });
  app.get("/rest/api/3/project/:key/components", async () => [{ id: "10000", name: "Frontend" }]);
  app.get("/rest/api/3/user/bulk", async (request) => {
    const raw = (request.query as { accountId?: string | string[] }).accountId ?? [];
    const ids = Array.isArray(raw) ? raw : [raw];
    return { values: [JANE, SAM].filter((u) => ids.includes(u.accountId)), isLast: true };
  });
  app.post("/rest/api/3/search/jql", async (request, reply) => {
    const body = request.body as { jql: string };
    const ids = /id in \(([^)]*)\)/.exec(body.jql)?.[1]?.split(",").map((id) => id.trim()) ?? [];
    // Like Jira, the whole query fails when one of the issues does not exist.
    const unknown = ids.find((id) => !ISSUES[id]);
    if (unknown) {
      return reply.status(400).send({ errorMessages: [`An issue with key '${unknown}' does not exist for field 'id'.`] });
    }
    return { issues: ids.map((id) => ({ id, key: ISSUES[id]!.key, fields: { summary: ISSUES[id]!.summary } })), isLast: true };
  });
  app.get("/rest/api/3/issue/:id", async (request, reply) => {
    const issue = ISSUES[(request.params as { id: string }).id];
    return issue ? { id: (request.params as { id: string }).id, key: issue.key, fields: { summary: issue.summary } } : reply.status(404).send({ errorMessages: ["Issue does not exist or you do not have permission to see it."] });
  });

  return { app, state };
}
