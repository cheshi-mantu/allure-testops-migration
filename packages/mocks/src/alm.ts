import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";

/**
 * Fake OpenText ALM (Quality Center): the subset of the REST API the migration reads, answering in
 * JSON as the public ALM REST API Reference (Core) describes it. Domain DEFAULT, project Banking: Test Plan folders three levels deep, tests with rich text,
 * user fields, design steps, a called test, parameters and attachments of tests and steps.
 *
 * Login: user demo / demo-password through alm-authenticate (or Basic authentication on the older
 * resource), or API key demo-client / demo-secret. Requests in a session must carry X-XSRF-TOKEN.
 */

export interface AlmMockOptions {
  username?: string;
  password?: string;
  clientId?: string;
  secret?: string;
  /** Largest page a list returns; small values exercise paging. */
  pageSize?: number;
  /** A session ends after this many project requests, to exercise logging in again. */
  sessionRequests?: number;
  /** Answer the customization of fields with 404, like ALM versions that do not give it. */
  noCustomization?: boolean;
  /** Only the older login: GET authentication-point/authenticate with Basic authentication, no alm-authenticate. */
  legacyAuth?: boolean;
}

export interface AlmMockState {
  logins: number;
  logouts: number;
  /** Project requests per session id. */
  sessions: Map<string, number>;
  downloads: string[];
}

type Fields = Record<string, string | string[] | null>;

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

/** An entity as ALM writes it in JSON; an empty value comes as `[{}]`. */
function entity(type: string, fields: Fields) {
  return {
    Type: type,
    Fields: Object.entries(fields).map(([name, value]) => ({
      Name: name,
      values: value === null || value === "" ? [{}] : (Array.isArray(value) ? value : [value]).map((v) => ({ value: v })),
    })),
  };
}

const html = (body: string) => `<html><body>\n<!-- converted -->\n<div align="left"><font face="Arial"><span style="font-size:8pt">${body}</span></font></div>\n</body></html>`;
const picture = (name: string) => `<img src="file://[IMAGE_BASE_PATH_PLACEHOLDER]${name}" border="0">`;

const FOLDERS: Fields[] = [
  { id: "2", "parent-id": "0", name: "Subject" },
  { id: "1001", "parent-id": "2", name: "Online banking" },
  { id: "1002", "parent-id": "1001", name: "Payments" },
  { id: "1003", "parent-id": "1002", name: "Cards" },
  { id: "1004", "parent-id": "1001", name: "Accounts" },
  { id: "1005", "parent-id": "2", name: "Mobile" },
];

const COMMON = { "ver-stamp": "3", "exec-status": "No Run", "creation-time": "2024-03-01", "last-modified": "2024-03-02 10:00:00", template: "N", "protocol-type": null };

const TESTS: Fields[] = [
  {
    ...COMMON,
    id: "1",
    name: "Log in with valid credentials",
    "parent-id": "1004",
    "subtype-id": "MANUAL",
    status: "Ready",
    owner: "jane",
    description: html(`Checks the <b>login</b> page.<br>&nbsp;<br>${picture("Test_1_login.png")}`),
    "dev-comments": html("<b>jane</b>, 2024-03-01: reviewed"),
    attachment: "Y",
    "user-01": "2-High",
    "user-02": "Regression;Smoke",
    "user-03": "REQ-12",
    "user-04": "rsmith",
  },
  {
    ...COMMON,
    id: "2",
    name: "Pay with a saved card",
    "parent-id": "1003",
    "subtype-id": "MANUAL",
    status: "Design",
    owner: "rsmith",
    description: html("Payment with a card stored in the profile."),
    attachment: "",
    "user-01": "3-Medium",
    "user-02": "Regression",
  },
  {
    ...COMMON,
    id: "3",
    name: "Open the payment form",
    "parent-id": "1002",
    "subtype-id": "MANUAL",
    status: "Ready",
    owner: "jane",
    description: "",
    attachment: "",
  },
  {
    ...COMMON,
    id: "4",
    name: "Old transfer flow",
    "parent-id": "1002",
    "subtype-id": "QUICKTEST_TEST",
    status: "Repair",
    owner: "bob",
    description: "Plain text description",
    attachment: "Y",
  },
  {
    ...COMMON,
    id: "5",
    name: "Mobile login",
    "parent-id": "1005",
    "subtype-id": "MANUAL",
    status: "Ready",
    owner: "jane",
    description: "",
    attachment: "",
  },
];

const STEPS: Fields[] = [
  { id: "11", "parent-id": "1", "step-order": "2", name: "Step 2", description: html("Enter <b>demo</b> / <b>secret</b>"), expected: html("The dashboard opens"), attachment: "Y", "link-test": null },
  { id: "10", "parent-id": "1", "step-order": "1", name: "Step 1", description: html("Open the login page"), expected: html("The form is shown"), attachment: "", "link-test": null },
  { id: "12", "parent-id": "1", "step-order": "3", name: "Check the menu", description: html(`Look at the menu ${picture("Step_12_menu.png")}`), expected: "", attachment: "Y", "link-test": null },
  { id: "20", "parent-id": "2", "step-order": "1", name: "Call <Open the payment form>", description: "", expected: "", attachment: "", "link-test": "3" },
  { id: "21", "parent-id": "2", "step-order": "2", name: "Step 2", description: html("Pay <<<amount>>> <<<currency>>>"), expected: html("The payment is accepted"), attachment: "", "link-test": null },
  { id: "30", "parent-id": "3", "step-order": "1", name: "Step 1", description: html("Open <i>Payments</i>"), expected: "", attachment: "", "link-test": null },
  { id: "31", "parent-id": "3", "step-order": "2", name: "Step 2", description: html("Click <b>New payment</b>"), expected: html("The form is shown"), attachment: "", "link-test": null },
];

const PARAMETERS: Fields[] = [
  { id: "1", "parent-id": "2", "parent-type": "test", name: "amount", "default-value": "100", desc: "Amount to pay" },
  { id: "2", "parent-id": "2", "parent-type": "test", name: "currency", "default-value": "<html><body>EUR</body></html>", desc: "" },
];

/** Attachments by owner: `tests/1` or `design-steps/11`. */
const ATTACHMENTS: Record<string, Fields[]> = {
  "tests/1": [
    { id: "101", name: "Test_1_login.png", "ref-type": "File", "file-size": String(PNG.length), "parent-id": "1", "parent-type": "test" },
    { id: "102", name: "spec.pdf", "ref-type": "File", "file-size": "4", "parent-id": "1", "parent-type": "test" },
  ],
  "tests/4": [{ id: "103", name: "https://wiki.example.com/transfers", "ref-type": "URL", description: "Transfer rules", "parent-id": "4", "parent-type": "test" }],
  "design-steps/11": [{ id: "104", name: "credentials.png", "ref-type": "File", "file-size": String(PNG.length), "parent-id": "11", "parent-type": "design-step" }],
  "design-steps/12": [{ id: "105", name: "Step_12_menu.png", "ref-type": "File", "file-size": String(PNG.length), "parent-id": "12", "parent-type": "design-step" }],
};

const FIELDS = [
  { Name: "id", Label: "Test ID", Type: "Number", System: true, Active: true },
  { Name: "name", Label: "Test Name", Type: "String", System: true, Active: true },
  { Name: "description", Label: "Description", Type: "Memo", System: true, Active: true },
  { Name: "dev-comments", Label: "Comments", Type: "Memo", System: true, Active: true },
  { Name: "owner", Label: "Designer", Type: "UsersList", System: true, Active: true },
  { Name: "status", Label: "Status", Type: "LookupList", System: true, Active: true },
  { Name: "subtype-id", Label: "Type", Type: "String", System: true, Active: true },
  { Name: "exec-status", Label: "Execution Status", Type: "LookupList", System: true, Active: true },
  { Name: "creation-time", Label: "Creation Date", Type: "Date", System: true, Active: true },
  { Name: "user-01", Label: "Priority", Type: "LookupList", System: false, Active: true, SupportsMultivalue: false },
  { Name: "user-02", Label: "Test Areas", Type: "LookupList", System: false, Active: true, SupportsMultivalue: true },
  { Name: "user-03", Label: "Requirement", Type: "String", System: false, Active: true },
  { Name: "user-04", Label: "Reviewer", Type: "UsersList", System: false, Active: true },
  { Name: "user-05", Label: "Retired field", Type: "String", System: false, Active: false },
];

const USERS = [
  { Name: "jane", FullName: "Jane Doe", email: "jane@example.com" },
  { Name: "rsmith", FullName: "Robert Smith", email: "sam@example.com" },
  { Name: "bob", FullName: "Bob", email: "" },
];

/** `{parent-id[1 OR 2];parent-type[test]}` to a check of an entity. */
function parseQuery(query: string | undefined): (fields: Fields) => boolean {
  if (!query) {
    return () => true;
  }
  const conditions = [...query.replace(/^\{|\}$/g, "").matchAll(/([\w-]+)\[([^\]]*)\]/g)].map((match) => ({
    field: match[1]!,
    values: match[2]!.split(/\s+OR\s+/i).map((value) => value.trim().replace(/^"|"$/g, "")),
  }));
  return (fields) => conditions.every((condition) => condition.values.includes(String(fields[condition.field] ?? "")));
}

function cookies(request: FastifyRequest): Record<string, string> {
  return Object.fromEntries(
    (request.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim().split("="))
      .filter((pair) => pair.length >= 2)
      .map(([name, ...value]) => [name!, value.join("=")]),
  );
}

export function createAlmMock(options: AlmMockOptions = {}) {
  const username = options.username ?? "demo";
  const password = options.password ?? "demo-password";
  const pageLimit = options.pageSize ?? 2000;
  const state: AlmMockState = { logins: 0, logouts: 0, sessions: new Map(), downloads: [] };
  const tokens = new Set<string>();
  /** XSRF token of each session. */
  const xsrf = new Map<string, string>();
  let counter = 0;
  const app = Fastify({ logger: false });
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => done(null, body));

  const unauthorized = (reply: FastifyReply) => reply.code(401).header("content-type", "application/json").send({ Id: "qccore.session-has-expired", Title: "Authentication failed" });

  const signIn = (reply: FastifyReply, ok: boolean, code: number) => {
    if (!ok) {
      return unauthorized(reply);
    }
    const token = `lw${++counter}`;
    tokens.add(token);
    return reply.header("set-cookie", `LWSSO_COOKIE_KEY=${token}; Path=/; HttpOnly`).code(code).send();
  };
  // Older resource, to be deprecated: GET with Basic authentication.
  app.get("/qcbin/authentication-point/authenticate", async (request, reply) => {
    const [user, pass] = Buffer.from((request.headers.authorization ?? "").replace(/^Basic\s+/i, ""), "base64").toString().split(":");
    return signIn(reply, user === username && pass === password, 200);
  });
  app.post("/qcbin/authentication-point/alm-authenticate", async (request, reply) => {
    if (options.legacyAuth) {
      return reply.code(404).send();
    }
    const raw = request.body ?? {};
    const body = (Buffer.isBuffer(raw) ? JSON.parse(raw.toString() || "{}") : raw) as { "alm-authentication"?: { user?: string; password?: string } };
    const { user, password: pass } = body["alm-authentication"] ?? {};
    return signIn(reply, user === username && pass === password, 201);
  });
  /** Opens a session: QCSession and XSRF-TOKEN cookies. */
  const openSession = () => {
    const session = `qc${++counter}`;
    state.sessions.set(session, 0);
    xsrf.set(session, `x${counter}`);
    state.logins += 1;
    return [`QCSession=${session}; Path=/; HttpOnly`, `XSRF-TOKEN=x${counter}; Path=/`, "ALM_USER=demo; Path=/"];
  };
  // An API key login opens the session at once.
  app.post("/qcbin/rest/oauth2/login", async (request, reply) => {
    const raw = request.body ?? {};
    const body = (Buffer.isBuffer(raw) ? JSON.parse(raw.toString() || "{}") : raw) as { clientId?: string; secret?: string };
    if (body.clientId !== (options.clientId ?? "demo-client") || body.secret !== (options.secret ?? "demo-secret")) {
      return unauthorized(reply);
    }
    const token = `lw${++counter}`;
    tokens.add(token);
    return reply.header("set-cookie", [`LWSSO_COOKIE_KEY=${token}; Path=/; HttpOnly`, ...openSession()]).code(200).send();
  });
  app.post("/qcbin/rest/site-session", async (request, reply) => {
    if (!tokens.has(cookies(request).LWSSO_COOKIE_KEY ?? "")) {
      return unauthorized(reply);
    }
    return reply.code(201).header("set-cookie", openSession()).send();
  });
  app.delete("/qcbin/rest/site-session", async (request, reply) => {
    if (request.headers["x-xsrf-token"] !== xsrf.get(cookies(request).QCSession ?? "")) {
      return reply.code(403).send({ Title: "Missing X-XSRF-TOKEN" });
    }
    state.sessions.delete(cookies(request).QCSession ?? "");
    state.logouts += 1;
    return reply.header("set-cookie", "QCSession=; Max-Age=0; Path=/").code(200).send();
  });
  // Since ALM 24.1 only POST logs out.
  app.post("/qcbin/authentication-point/logout", async (request, reply) => {
    tokens.delete(cookies(request).LWSSO_COOKIE_KEY ?? "");
    return reply.header("set-cookie", "LWSSO_COOKIE_KEY=; Max-Age=0; Path=/").code(200).send();
  });

  /** Requests to the API need the session; it ends after `sessionRequests` requests when set. */
  const session = (request: FastifyRequest, reply: FastifyReply): boolean => {
    const id = cookies(request).QCSession ?? "";
    const count = state.sessions.get(id);
    if (count !== undefined && request.headers["x-xsrf-token"] !== xsrf.get(id)) {
      void reply.code(403).send({ Title: "Missing X-XSRF-TOKEN" });
      return false;
    }
    if (count === undefined || (options.sessionRequests !== undefined && count >= options.sessionRequests)) {
      state.sessions.delete(id);
      void unauthorized(reply);
      return false;
    }
    state.sessions.set(id, count + 1);
    return true;
  };

  app.get("/qcbin/rest/domains", async (request, reply) => {
    if (!session(request, reply)) {
      return reply;
    }
    return { Domains: { Domain: [{ Name: "DEFAULT", Projects: { Project: [{ Name: "Banking" }, { Name: "Empty" }] } }, { Name: "OTHER", Projects: { Project: { Name: "Legacy" } } }] } };
  });

  type ProjectRequest = FastifyRequest<{ Params: { domain: string; project: string; "*": string }; Querystring: Record<string, string | undefined> }>;
  app.get("/qcbin/rest/domains/:domain/projects/:project/*", async (request: ProjectRequest, reply) => {
    if (!session(request, reply)) {
      return reply;
    }
    const { domain, project } = request.params;
    const path = request.params["*"];
    if (domain !== "DEFAULT" || !["Banking", "Empty"].includes(project)) {
      return reply.code(404).send({ Id: "qccore.project-not-found", Title: `Project ${domain}/${project} not found` });
    }
    const empty = project === "Empty";
    const page = (type: string, rows: Fields[]) => {
      const matching = rows.filter(parseQuery(request.query.query));
      const size = Math.min(Number(request.query["page-size"] ?? 100), pageLimit);
      const start = Math.max(1, Number(request.query["start-index"] ?? 1));
      return { entities: matching.slice(start - 1, start - 1 + size).map((fields) => entity(type, fields)), TotalResults: matching.length };
    };
    if (path === "test-folders") {
      return page("test-folder", empty ? FOLDERS.slice(0, 1) : FOLDERS);
    }
    if (path === "tests") {
      return page("test", empty ? [] : [...TESTS].sort((a, b) => Number(a.id) - Number(b.id)));
    }
    if (path === "design-steps") {
      return page("design-step", empty ? [] : STEPS);
    }
    if (path === "test-parameters") {
      return page("test-parameter", empty ? [] : PARAMETERS);
    }
    if (path === "customization/entities/test/fields") {
      return options.noCustomization ? reply.code(404).send({ Title: "Not found" }) : { Fields: { Field: FIELDS } };
    }
    if (path === "customization/users") {
      return { users: USERS };
    }
    const one = /^tests\/(\d+)$/.exec(path);
    if (one) {
      const test = TESTS.find((t) => t.id === one[1]);
      return test ? entity("test", test) : reply.code(404).send({ Title: "Entity not found" });
    }
    const list = /^(tests|design-steps)\/(\d+)\/attachments$/.exec(path);
    if (list) {
      return page("attachment", ATTACHMENTS[`${list[1]}/${list[2]}`] ?? []);
    }
    const file = /^(tests|design-steps)\/(\d+)\/attachments\/(.+)$/.exec(path);
    if (file) {
      const name = decodeURIComponent(file[3]!);
      const known = (ATTACHMENTS[`${file[1]}/${file[2]}`] ?? []).find((a) => a.name === name && a["ref-type"] === "File");
      if (!known || request.headers.accept !== "application/octet-stream") {
        return reply.code(404).send({ Title: "Attachment not found" });
      }
      state.downloads.push(`${file[1]}/${file[2]}/${name}`);
      return reply.header("content-type", "application/octet-stream").send(name.endsWith(".pdf") ? Buffer.from("%PDF") : PNG);
    }
    return reply.code(404).send({ Title: `Unknown resource ${path}` });
  });

  return { app, state };
}
