import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

/**
 * Fake Jira Cloud and Xray Cloud on one server: the subset of Jira REST v3 and of the Xray GraphQL
 * API the migration uses, with a synthetic project CALC holding Manual, Cucumber and Generic tests,
 * a called test, preconditions, test sets and plans, folders, comments, links and attachments.
 *
 * Jira: Basic auth demo@example.com / demo-jira-token. Xray: API key demo-client-id / demo-client-secret.
 */

export interface XrayMockOptions {
  jiraEmail?: string;
  jiraToken?: string;
  clientId?: string;
  clientSecret?: string;
}

interface MockTest {
  id: string;
  key: string;
  summary: string;
  issueType: string;
  fields: Record<string, unknown>;
  rendered: Record<string, unknown>;
  xray: Record<string, unknown> | null;
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const user = (accountId: string, displayName: string, emailAddress?: string) => ({ accountId, displayName, ...(emailAddress ? { emailAddress } : {}) });
const JANE = user("acc-jane", "Jane Doe", "jane@example.com");
const SAM = user("acc-sam", "Sam Tester");

const FIELDS = [
  { id: "summary", name: "Summary", custom: false, schema: { type: "string", system: "summary" } },
  { id: "description", name: "Description", custom: false, schema: { type: "string", system: "description" } },
  { id: "environment", name: "Environment", custom: false, schema: { type: "string", system: "environment" } },
  { id: "labels", name: "Labels", custom: false, schema: { type: "array", items: "string", system: "labels" } },
  { id: "priority", name: "Priority", custom: false, schema: { type: "priority", system: "priority" } },
  { id: "components", name: "Components", custom: false, schema: { type: "array", items: "component", system: "components" } },
  { id: "fixVersions", name: "Fix versions", custom: false, schema: { type: "array", items: "version", system: "fixVersions" } },
  { id: "assignee", name: "Assignee", custom: false, schema: { type: "user", system: "assignee" } },
  { id: "reporter", name: "Reporter", custom: false, schema: { type: "user", system: "reporter" } },
  { id: "status", name: "Status", custom: false, schema: { type: "status", system: "status" } },
  { id: "created", name: "Created", custom: false, schema: { type: "datetime", system: "created" } },
  { id: "issuetype", name: "Issue Type", custom: false, schema: { type: "issuetype", system: "issuetype" } },
  { id: "project", name: "Project", custom: false, schema: { type: "project", system: "project" } },
  { id: "attachment", name: "Attachment", custom: false, schema: { type: "array", items: "attachment", system: "attachment" } },
  { id: "comment", name: "Comment", custom: false, schema: { type: "comments-page", system: "comment" } },
  { id: "issuelinks", name: "Linked Issues", custom: false, schema: { type: "array", items: "issuelinks", system: "issuelinks" } },
  { id: "customfield_10100", name: "Automation status", custom: true, schema: { type: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:select" } },
  { id: "customfield_10101", name: "Notes", custom: true, schema: { type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:textarea" } },
  { id: "customfield_10102", name: "Rank", custom: true, schema: { type: "any", custom: "com.pyxis.greenhopper.jira:gh-lexo-rank" } },
  { id: "customfield_10103", name: "Spec", custom: true, schema: { type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:url" } },
];

function tests(base: string): MockTest[] {
  const requirement = (key: string, summary: string) => ({ type: { name: "Test", inward: "is tested by", outward: "tests" }, outwardIssue: { key, fields: { summary } } });
  const xrayFile = (id: string, filename: string) => ({ id, filename, storedInJira: false, downloadLink: `${base}/api/v2/attachments/${id}` });
  const linked = (issueId: string, key: string, summary: string) => ({ issueId, jira: { key, summary } });
  return [
    {
      id: "10001",
      key: "CALC-1",
      summary: "Login with valid credentials",
      issueType: "Test",
      fields: {
        description: { type: "doc", version: 1, content: [] },
        labels: ["smoke", "login"],
        priority: { id: "2", name: "High" },
        components: [{ id: "1", name: "Auth" }],
        fixVersions: [{ id: "1", name: "2.0" }],
        assignee: JANE,
        reporter: SAM,
        status: { name: "To Do" },
        created: "2026-01-10T10:00:00.000+0000",
        customfield_10100: { id: "1", value: "Manual" },
        customfield_10101: { type: "doc", version: 1, content: [] },
        customfield_10102: "0|i0000:",
        customfield_10103: "https://wiki.example.com/login",
        attachment: [
          { id: "20001", filename: "login-form.png", mimeType: "image/png", size: PNG.length, content: `${base}/rest/api/3/attachment/content/20001` },
          { id: "20002", filename: "accounts.csv", mimeType: "text/csv", size: 10, content: `${base}/rest/api/3/attachment/content/20002` },
        ],
        comment: { comments: [{ id: "1", author: SAM, body: { type: "doc", version: 1, content: [] } }] },
        issuelinks: [requirement("CALC-100", "Users can log in"), { type: { name: "Blocks", inward: "is blocked by", outward: "blocks" }, inwardIssue: { key: "CALC-101" } }],
      },
      rendered: {
        description: `<p>Checks the <b>login</b> form.</p><p><span class="image-wrap"><img src="/rest/api/3/attachment/content/20001" alt="login-form.png"></span></p>`,
        customfield_10101: "<p>Run on <em>staging</em> first.</p>",
        comment: { comments: [{ body: "<p>Reviewed, looks good.</p>" }] },
      },
      xray: {
        testType: { name: "Manual", kind: "Steps" },
        steps: [
          { id: "s1", action: "Open the *login* page", data: "URL: {{/login}}", result: "The form is shown", attachments: [], customFields: [], callTestIssueId: null },
          {
            id: "s2",
            action: "Enter valid credentials !creds.png|thumbnail!",
            data: "||User||Password||\n|jane|secret|",
            result: "Fields are filled",
            attachments: [xrayFile("att-1", "creds.png")],
            customFields: [{ id: "cf1", name: "Data set", value: "users-1" }],
            callTestIssueId: null,
          },
          { id: "s3", action: "Press _Log in_", data: "", result: "* The dashboard opens\n* The user name is shown", attachments: [], customFields: [], callTestIssueId: null },
        ],
        unstructured: null,
        gherkin: null,
        scenarioType: null,
        folder: { name: "Login", path: "/Web/Auth/Login" },
        preconditions: { total: 1, results: [{ issueId: "10010", definition: "*User* jane exists", preconditionType: { name: "Manual", kind: "Steps" }, jira: { key: "CALC-10", summary: "User exists" } }] },
        testSets: { total: 1, results: [linked("10020", "CALC-20", "Smoke")] },
        testPlans: { total: 1, results: [linked("10030", "CALC-30", "Release 2.0")] },
      },
    },
    {
      id: "10002",
      key: "CALC-2",
      summary: "Log out",
      issueType: "Test",
      fields: { labels: ["bdd"], priority: { id: "3", name: "Medium" }, assignee: SAM, reporter: SAM, status: { name: "Done" }, issuelinks: [requirement("CALC-100", "Users can log in")] },
      rendered: {},
      xray: {
        testType: { name: "Cucumber", kind: "Gherkin" },
        steps: [],
        unstructured: null,
        gherkin: "Scenario: Log out\n  Given I am logged in\n  When I press \"Log out\"\n  Then I see the login page",
        scenarioType: "scenario",
        folder: { name: "Auth", path: "/Web/Auth" },
        preconditions: { total: 0, results: [] },
        testSets: { total: 0, results: [] },
        testPlans: { total: 0, results: [] },
      },
    },
    {
      id: "10003",
      key: "CALC-3",
      summary: "Login API contract",
      issueType: "Test",
      fields: { labels: [], priority: { id: "3", name: "Medium" }, status: { name: "To Do" }, components: [{ id: "2", name: "API" }] },
      rendered: {},
      xray: {
        testType: { name: "Generic", kind: "Unstructured" },
        steps: [],
        unstructured: "com.example.api.LoginContractTest",
        gherkin: null,
        scenarioType: null,
        folder: { name: "API", path: "/API" },
        preconditions: { total: 0, results: [] },
        testSets: { total: 0, results: [] },
        testPlans: { total: 0, results: [] },
      },
    },
    {
      id: "10004",
      key: "CALC-4",
      summary: "Checkout after login",
      issueType: "Test",
      fields: { labels: ["checkout"], priority: { id: "2", name: "High" }, status: { name: "To Do" } },
      rendered: {},
      xray: {
        testType: { name: "Manual", kind: "Steps" },
        steps: [
          { id: "s4", action: "", data: "", result: "", attachments: [], customFields: [], callTestIssueId: "10005" },
          { id: "s5", action: "Pay with a card", data: "", result: "The order is placed", attachments: [], customFields: [], callTestIssueId: null },
        ],
        unstructured: null,
        gherkin: null,
        scenarioType: null,
        folder: { name: "Shop", path: "/Web/Shop" },
        preconditions: { total: 0, results: [] },
        testSets: { total: 0, results: [] },
        testPlans: { total: 0, results: [] },
      },
    },
    {
      id: "10005",
      key: "CALC-5",
      summary: "Open the app",
      issueType: "Test",
      fields: { labels: [], priority: { id: "4", name: "Low" }, status: { name: "Done" } },
      rendered: {},
      xray: {
        testType: { name: "Manual", kind: "Steps" },
        steps: [
          { id: "s6", action: "Start the app", data: "", result: "The start page is shown", attachments: [], customFields: [], callTestIssueId: null },
          { id: "s7", action: "Accept cookies", data: "", result: "", attachments: [], customFields: [], callTestIssueId: null },
        ],
        unstructured: null,
        gherkin: null,
        scenarioType: null,
        folder: { name: "Common", path: "/Common" },
        preconditions: { total: 0, results: [] },
        testSets: { total: 0, results: [] },
        testPlans: { total: 0, results: [] },
      },
    },
    {
      id: "10100",
      key: "CALC-100",
      summary: "Users can log in",
      issueType: "Story",
      fields: { labels: [], status: { name: "Done" } },
      rendered: {},
      xray: null,
    },
  ];
}

/** Matches the JQL this tool writes: project, issue type, key lists, ids and simple label filters. */
function matches(test: MockTest, jql: string): boolean {
  const where = jql.replace(/\s+ORDER BY.*$/i, "");
  const value = (pattern: RegExp) => pattern.exec(where)?.[1];
  const list = (pattern: RegExp) =>
    pattern
      .exec(where)?.[1]
      ?.split(",")
      .map((v) => v.trim().replace(/^"|"$/g, ""));
  const project = value(/project\s*=\s*"?([A-Z0-9_]+)"?/i);
  if (project && !test.key.startsWith(`${project}-`)) {
    return false;
  }
  const issueType = value(/issuetype\s*=\s*"([^"]+)"/i);
  if (issueType && test.issueType !== issueType) {
    return false;
  }
  const keys = list(/key\s+in\s*\(([^)]*)\)/i);
  if (keys && !keys.includes(test.key)) {
    return false;
  }
  const key = value(/key\s*=\s*"([^"]+)"/i);
  if (key && test.key !== key) {
    return false;
  }
  const ids = list(/\bid\s+in\s*\(([^)]*)\)/i);
  if (ids && !ids.includes(test.id)) {
    return false;
  }
  const label = value(/labels\s*=\s*"?([\w-]+)"?/i);
  if (label && !((test.fields.labels as string[] | undefined) ?? []).includes(label)) {
    return false;
  }
  return true;
}

export function createXrayMock(options: XrayMockOptions = {}): { app: FastifyInstance; requests: { method: string; url: string }[] } {
  const app = Fastify({ logger: false });
  const basic = `Basic ${Buffer.from(`${options.jiraEmail ?? "demo@example.com"}:${options.jiraToken ?? "demo-jira-token"}`).toString("base64")}`;
  const token = "fake-xray-token";
  const requests: { method: string; url: string }[] = [];
  let base = "";
  const data = () => tests(base);

  app.addHook("onRequest", async (request, reply) => {
    requests.push({ method: request.method, url: request.url });
    base ||= `${request.protocol}://${request.headers.host}`;
    if (request.url.startsWith("/rest/") && request.headers.authorization !== basic) {
      return reply.status(401).send({ errorMessages: ["Client must be authenticated to access this resource."] });
    }
    if ((request.url.startsWith("/api/v2/graphql") || request.url.startsWith("/api/v2/attachments")) && request.headers.authorization !== `Bearer ${token}`) {
      return reply.status(401).send({ error: "Authentication failed. Invalid token." });
    }
  });

  // ------------------------------------------------------------------ Xray
  app.post("/api/v2/authenticate", async (request, reply) => {
    const body = request.body as { client_id?: string; client_secret?: string };
    if (body.client_id !== (options.clientId ?? "demo-client-id") || body.client_secret !== (options.clientSecret ?? "demo-client-secret")) {
      return reply.status(401).send({ error: "Authentication failed. Invalid client credentials!" });
    }
    return reply.type("application/json").send(JSON.stringify(token));
  });

  app.post("/api/v2/graphql", async (request: FastifyRequest) => {
    const { query, variables } = request.body as { query: string; variables?: Record<string, unknown> };
    const all = data().filter((t) => t.xray);
    if (/getTests\(\s*projectId/.test(query)) {
      const inProject = all.filter((t) => t.key.startsWith("CALC-"));
      return { data: { getTests: { total: inProject.length, results: inProject.slice(0, 1).map((t) => ({ issueId: t.id, jira: { issuetype: { name: t.issueType } } })) } } };
    }
    const ids = (variables?.issueIds as string[] | undefined) ?? [];
    const results = all
      .filter((t) => ids.includes(t.id))
      .map((t) => ({ issueId: t.id, projectId: "10000", ...t.xray, jira: { key: t.key, summary: t.summary }, lastModified: "2026-01-10T10:00:00Z" }));
    return { data: { getTests: { total: results.length, results } } };
  });

  app.get("/api/v2/attachments/:id", async (_request, reply) => reply.type("image/png").send(PNG));

  // ------------------------------------------------------------------ Jira
  app.get("/rest/api/3/myself", async () => ({ ...JANE, displayName: "Demo User" }));
  app.get("/rest/api/3/project/search", async () => ({ values: [{ id: "10000", key: "CALC", name: "Calculator" }], isLast: true }));
  app.get("/rest/api/3/project/:key", async (request: FastifyRequest, reply: FastifyReply) => {
    const { key } = request.params as { key: string };
    return key === "CALC" || key === "10000" ? { id: "10000", key: "CALC", name: "Calculator" } : reply.status(404).send({ errorMessages: ["No project could be found with key '" + key + "'."] });
  });
  app.get("/rest/api/3/field", async () => FIELDS);
  app.post("/rest/api/3/search/jql", async (request) => {
    const body = request.body as { jql: string; maxResults?: number; nextPageToken?: string | null };
    const found = data().filter((t) => matches(t, body.jql)).sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
    const offset = Number(body.nextPageToken ?? 0);
    const size = Math.min(body.maxResults ?? 50, 2);
    const page = found.slice(offset, offset + size);
    const last = offset + size >= found.length;
    return {
      issues: page.map((t) => ({
        id: t.id,
        key: t.key,
        fields: { summary: t.summary, issuetype: { name: t.issueType }, project: { key: "CALC" }, ...t.fields },
        renderedFields: t.rendered,
      })),
      ...(last ? { isLast: true } : { isLast: false, nextPageToken: String(offset + size) }),
    };
  });
  app.get("/rest/api/3/attachment/content/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    return id === "20002" ? reply.type("text/csv").send("user,role\njane,admin\n") : reply.type("image/png").send(PNG);
  });

  return { app, requests };
}
