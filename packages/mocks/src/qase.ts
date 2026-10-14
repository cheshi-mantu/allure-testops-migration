import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

/**
 * Fake Qase: the subset of the REST API v1 the migration and dev/qase-seed.ts use, with a synthetic
 * project DEMO holding suites three levels deep, classic and Gherkin cases, shared steps, nested
 * steps, parameters, custom fields of several types, a milestone and attachments.
 *
 * API token: demo-qase-token, in the `Token` header. Lists return at most `pageSize` entities.
 */

export interface QaseMockOptions {
  token?: string;
  /** Largest page a list returns; small values exercise paging. Default 100, as in Qase. */
  pageSize?: number;
  /** Answer 429 with Retry-After when more than `requests` API calls arrive within `windowMs`, like Qase. */
  rateLimit?: { requests: number; windowMs: number; retryAfterSeconds?: number };
  /** Filled in by the mock: API requests seen and requests rejected with 429. */
  stats?: { requests: number; throttled: number };
}

interface Step {
  hash?: string;
  shared_step_hash?: string | null;
  shared_step_nested_hash?: string | null;
  position?: number;
  action?: string;
  expected_result?: string | null;
  data?: string | null;
  attachments?: unknown[];
  steps?: Step[];
}

type Case = Record<string, unknown> & { id: number; title: string; steps?: Step[] };

export interface QaseMockState {
  projects: { title: string; code: string }[];
  suites: Record<string, Record<string, unknown>[]>;
  cases: Record<string, Case[]>;
  sharedSteps: Record<string, { hash: string; title: string; steps: Step[] }[]>;
  milestones: Record<string, { id: number; title: string }[]>;
  customFields: Record<string, unknown>[];
  attachments: { hash: string; filename: string; mime: string; size: number; url: string }[];
  /** Requests for files: the address and whether the API token came with it. */
  downloads: { url: string; withToken: boolean }[];
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

export const QASE_SYSTEM_FIELDS = [
  { title: "Priority", slug: "priority", options: [[0, "Not set", "undefined"], [1, "High", "high"], [2, "Medium", "medium"], [3, "Low", "low"]] },
  { title: "Severity", slug: "severity", options: [[0, "Not set", "undefined"], [1, "Blocker", "blocker"], [2, "Critical", "critical"], [3, "Major", "major"], [4, "Normal", "normal"], [5, "Minor", "minor"], [6, "Trivial", "trivial"]] },
  { title: "Type", slug: "type", options: [[1, "Other", "other"], [8, "Functional", "functional"], [2, "Smoke", "smoke"], [3, "Regression", "regression"], [4, "Security", "security"], [5, "Usability", "usability"], [6, "Performance", "performance"], [7, "Acceptance", "acceptance"]] },
  { title: "Behavior", slug: "behavior", options: [[1, "Not set", "undefined"], [2, "Positive", "positive"], [3, "Negative", "negative"], [4, "Destructive", "destructive"]] },
  { title: "Description", slug: "description" },
  { title: "Pre-conditions", slug: "preconditions" },
  { title: "Post-conditions", slug: "postconditions" },
  { title: "Status", slug: "status", options: [[0, "Actual", "actual"], [1, "Draft", "draft"], [2, "Deprecated", "deprecated"]] },
  { title: "Automation status (deprecated)", slug: "automation", options: [[0, "Manual", "is-not-automated"], [1, "To be automated", "to-be-automated"], [2, "Automated", "automated"]] },
  { title: "Automation status", slug: "isManual", options: [[0, "Manual", "manual"], [1, "Automated", "automated"]] },
  { title: "To be automated", slug: "isToBeAutomated" },
  { title: "Layer", slug: "layer", options: [[0, "Not set", "unknown"], [1, "E2E", "e2e"], [2, "API", "api"], [3, "Unit", "unit"]] },
  { title: "Is flaky", slug: "is_flaky", options: [[0, "No", "no"], [1, "Yes", "yes"]] },
].map((field) => ({
  title: field.title,
  slug: field.slug,
  default_value: "0",
  is_required: false,
  entity: 0,
  type: 0,
  ...(field.options ? { options: field.options.map(([id, title, slug]) => ({ id, title, slug, is_default: false, read_only: false })) } : {}),
}));

/** The synthetic project. `base` is the address files are served from. */
function demo(base: string): Omit<QaseMockState, "downloads"> {
  const file = (hash: string, filename: string, mime: string) => ({ hash, filename, mime, size: PNG.length, url: `${base}/files/${hash}/${filename}` });
  const screenshot = file("a1", "screenshot.png", "image/png");
  const data = file("a2", "users.csv", "text/csv");
  const inline = file("a3", "diagram.png", "image/png");
  const shared = {
    hash: "sh1",
    title: "Log in as a customer",
    steps: [
      { hash: "s1", action: "Open the login page", expected_result: "The form is shown", data: "URL: /login" },
      { hash: "s2", action: "Enter the credentials", expected_result: "The dashboard opens", data: "", steps: [{ hash: "s3", action: "Type the email" }, { hash: "s4", action: "Type the password" }] },
    ],
  };
  const expanded = shared.steps.map((step, index) => ({ ...step, hash: "c-shared", position: index + 1, shared_step_hash: shared.hash, shared_step_nested_hash: step.hash }));
  const base_ = { severity: 4, priority: 0, type: 1, layer: 0, is_flaky: 0, behavior: 1, automation: 0, isManual: true, isToBeAutomated: false, status: 0, member_id: 1, author_id: 501 };
  const stamp = { created_at: "2026-01-10T10:00:00+00:00", updated_at: "2026-01-11T10:00:00+00:00" };
  return {
    projects: [
      { title: "Demo shop", code: "DEMO" },
      { title: "Empty project", code: "EMPTY" },
    ],
    suites: {
      DEMO: [
        { id: 1, title: "Web", description: "Everything in the browser.", position: 1, cases_count: 1 },
        { id: 2, title: "Auth", position: 1, parent_id: 1, cases_count: 1 },
        { id: 3, title: "Password", position: 1, parent_id: 2, cases_count: 2 },
        { id: 4, title: "API", position: 2, cases_count: 1 },
      ],
      EMPTY: [],
    },
    cases: {
      DEMO: [
        {
          ...base_,
          ...stamp,
          id: 1,
          title: "Reset a forgotten password",
          description: `Checks the **reset** flow.\n\n| Field | Value |\n| --- | --- |\n| Email | jane@example.com |\n\n![diagram](${inline.url})`,
          preconditions: "The user `jane@example.com` exists.",
          postconditions: "Remove the reset token.",
          severity: 2,
          priority: 1,
          type: 4,
          layer: 1,
          behavior: 2,
          is_flaky: 1,
          status: 1,
          automation: 1,
          isToBeAutomated: true,
          milestone_id: 1,
          suite_id: 3,
          custom_fields: [
            { id: 4, value: "1" },
            { id: 3, value: "2" },
            { id: 2, value: "1" },
            { id: 2, value: "3" },
            { id: 1, value: "2" },
            { id: 5, value: "build-100" },
            { id: 6, value: "https://docs.example.com/specs/auth" },
            { id: 7, value: "Review after the **redesign**." },
          ],
          attachments: [data],
          steps_type: "classic",
          steps: [
            ...expanded,
            { hash: "c1", position: 3, action: "Click **Forgot password?**", expected_result: "The reset form is shown", data: "Email: jane@example.com", attachments: [screenshot] },
            { hash: "c2", position: 4, action: "Submit the form", steps: [{ hash: "c3", position: 1, action: "Type the email", expected_result: "No validation error" }, { hash: "c4", position: 2, action: "Press Enter" }] },
            { hash: "c5", position: 5, action: "Open the mailbox" },
          ],
          parameters: [
            { type: "single", item: { title: "browser", values: ["chrome", "firefox"] } },
            { type: "group", items: [{ title: "user", values: ["admin", "guest"] }, { title: "locale", values: ["en", "de"] }] },
          ],
          tags: [{ title: "smoke", internal_id: 1 }, { title: "auth", internal_id: 2 }],
          external_issues: [{ type: "jira-cloud", issues: [{ id: "SHOP-12", link: "https://jira.example.com/browse/SHOP-12" }] }],
        },
        {
          ...base_,
          ...stamp,
          id: 2,
          title: "Password rules",
          suite_id: 3,
          automation: 2,
          isManual: false,
          steps_type: "gherkin",
          steps: [{ action: 'Given I am on the sign-up page\nWhen I enter the password "<password>"\nThen I see "<message>"\n\nExamples:\n  | password | message |\n  | short | At least 8 characters |' }],
          tags: [{ title: "bdd", internal_id: 3 }],
        },
        { ...base_, ...stamp, id: 3, title: "Session expires after 30 minutes", suite_id: 2, priority: 2, steps_type: "classic", steps: [{ hash: "c6", position: 1, action: "Log in and wait 30 minutes" }, { hash: "c7", position: 2, action: "Open any page", expected_result: "The login page is shown" }] },
        { ...base_, ...stamp, id: 4, title: "Home page loads", suite_id: 1, type: 2, member_id: 2, author_id: 502, description: "Smoke check." },
        { ...base_, ...stamp, id: 5, title: "Orders API returns the list", suite_id: 4, layer: 2, automation: 2, isManual: false, status: 2, steps_type: "classic", steps: [{ hash: "c8", position: 1, action: "GET /orders", expected_result: "200 with a list" }] },
        { ...base_, ...stamp, id: 6, title: "A case outside of suites", steps_type: "classic", steps: [...expanded] },
      ],
      EMPTY: [],
    },
    sharedSteps: { DEMO: [shared], EMPTY: [] },
    milestones: { DEMO: [{ id: 1, title: "Release 1.0" }], EMPTY: [] },
    customFields: [
      { id: 1, title: "Browser", entity: "case", type: "selectbox", value: '[{"id": 1, "title": "Chrome"}, {"id": 2, "title": "Firefox"}]', is_enabled_for_all_projects: false, projects_codes: ["DEMO"] },
      { id: 2, title: "Platforms", entity: "case", type: "Multiselect", value: '[{"id": 1, "title": "Web"}, {"id": 2, "title": "iOS"}, {"id": 3, "title": "Android"}]', is_enabled_for_all_projects: true, projects_codes: [] },
      { id: 3, title: "Reviewer", entity: "case", type: "User", is_enabled_for_all_projects: true, projects_codes: [] },
      { id: 4, title: "Needs review", entity: "case", type: "Checkbox", is_enabled_for_all_projects: true, projects_codes: [] },
      { id: 5, title: "Build", entity: "case", type: "String", is_enabled_for_all_projects: true, projects_codes: [] },
      { id: 6, title: "Spec", entity: "case", type: "Url", is_enabled_for_all_projects: true, projects_codes: [] },
      { id: 7, title: "Notes", entity: "case", type: "Text", is_enabled_for_all_projects: true, projects_codes: [] },
      { id: 8, title: "Other project only", entity: "case", type: "String", is_enabled_for_all_projects: false, projects_codes: ["OTHER"] },
    ],
    attachments: [screenshot, data, inline],
  };
}

const USERS = [
  { id: 1, name: "Jane Doe", email: "jane@example.com", title: "QA", status: 1 },
  { id: 2, name: "Sam Tester", email: "sam@example.com", title: "QA", status: 1 },
];
const AUTHORS = [
  { id: 1, author_id: 501, entity_type: "user", entity_id: 1, email: "jane@example.com", name: "Jane Doe", is_active: true },
  { id: 2, author_id: 502, entity_type: "user", entity_id: 2, email: "sam@example.com", name: "Sam Tester", is_active: true },
];

export function createQaseMock(options: QaseMockOptions = {}): { app: FastifyInstance; state: QaseMockState } {
  const token = options.token ?? "demo-qase-token";
  const maxPage = options.pageSize ?? 100;
  const app = Fastify({ logger: false });
  let state: QaseMockState | null = null;
  const stamps: number[] = [];
  let nextId = 1000;
  const id = () => nextId++;

  app.addContentTypeParser("multipart/form-data", (_request, payload, done) => {
    const chunks: Buffer[] = [];
    payload.on("data", (chunk: Buffer) => chunks.push(chunk));
    payload.on("end", () => {
      const text = Buffer.concat(chunks).toString("latin1");
      done(null, { names: [...text.matchAll(/filename="([^"]*)"/g)].map((m) => m[1]!) });
    });
  });

  /**
   * Qase serves files from another host than the API. Here it is the same server under its other
   * local name, which is another origin for the client.
   */
  const filesBase = (request: FastifyRequest) => {
    const host = request.host.startsWith("127.0.0.1") ? request.host.replace("127.0.0.1", "localhost") : request.host.replace(/^localhost/, "127.0.0.1");
    return `${request.protocol}://${host}`;
  };
  /** The data set is built on the first request, when the address files are served from is known. */
  const data = (request: FastifyRequest): QaseMockState => {
    state ??= { ...demo(filesBase(request)), downloads: [] };
    return state;
  };
  const holder = {
    app,
    get state(): QaseMockState {
      if (!state) {
        throw new Error("The Qase mock has not served a request yet.");
      }
      return state;
    },
  };

  const ok = (result: unknown) => ({ status: true, result });
  const page = <T>(items: T[], request: FastifyRequest) => {
    const query = request.query as { limit?: string; offset?: string };
    const limit = Math.min(Number(query.limit ?? 10), maxPage);
    const offset = Number(query.offset ?? 0);
    const entities = items.slice(offset, offset + limit);
    return ok({ total: items.length, filtered: items.length, count: entities.length, entities });
  };
  const code = (request: FastifyRequest) => (request.params as { code: string }).code;

  app.addHook("onRequest", async (request, reply) => {
    data(request);
    if (request.url.startsWith("/files/")) {
      return;
    }
    if (request.headers.token !== token) {
      return reply.status(401).send({ status: false, errorMessage: "Unauthenticated." });
    }
    if (options.stats) {
      options.stats.requests += 1;
    }
    const limit = options.rateLimit;
    if (limit) {
      const now = Date.now();
      while (stamps.length > 0 && stamps[0]! <= now - limit.windowMs) {
        stamps.shift();
      }
      if (stamps.length >= limit.requests) {
        if (options.stats) {
          options.stats.throttled += 1;
        }
        return reply
          .status(429)
          .header("Retry-After", String(limit.retryAfterSeconds ?? 1))
          .send({ status: false, errorMessage: "Too Many Requests" });
      }
      stamps.push(now);
    }
    const project = /^\/v1\/(?:suite|case|shared_step|milestone|attachment)\/([^/?]+)/.exec(request.url)?.[1];
    if (project && !state!.projects.some((p) => p.code === project)) {
      return reply.status(404).send({ status: false, errorMessage: "Project not found" });
    }
  });

  // Files live on another address than the API in Qase: here on another path, served without the token.
  app.get("/files/:hash/:name", async (request, reply) => {
    const { hash } = request.params as { hash: string };
    data(request).downloads.push({ url: request.url, withToken: request.headers.token !== undefined });
    const file = state!.attachments.find((a) => a.hash === hash);
    if (!file) {
      return reply.status(404).send("Not found");
    }
    return reply.type(file.mime).send(file.mime === "text/csv" ? Buffer.from("login,password\njane,secret\n") : PNG);
  });

  app.get("/v1/project", async (request) =>
    page(
      state!.projects.map((p) => ({ ...p, counts: { cases: state!.cases[p.code]?.length ?? 0, suites: state!.suites[p.code]?.length ?? 0 } })),
      request,
    ),
  );
  app.get("/v1/project/:code", async (request, reply) => {
    const project = state!.projects.find((p) => p.code === code(request));
    return project
      ? ok({ ...project, counts: { cases: state!.cases[project.code]?.length ?? 0, suites: state!.suites[project.code]?.length ?? 0 } })
      : reply.status(404).send({ status: false, errorMessage: "Project not found" });
  });
  app.post("/v1/project", async (request) => {
    const body = request.body as { title: string; code: string };
    state!.projects.push({ title: body.title, code: body.code });
    Object.assign(state!.suites, { [body.code]: [] });
    Object.assign(state!.cases, { [body.code]: [] });
    Object.assign(state!.sharedSteps, { [body.code]: [] });
    Object.assign(state!.milestones, { [body.code]: [] });
    return ok({ code: body.code });
  });

  app.get("/v1/system_field", async () => ok(QASE_SYSTEM_FIELDS));
  app.get("/v1/user", async (request) => page(USERS, request));
  app.get("/v1/author", async (request) => page(AUTHORS, request));

  app.get("/v1/custom_field", async (request) => page(state!.customFields, request));
  app.post("/v1/custom_field", async (request) => {
    const body = request.body as { title: string; type: number; value?: unknown; projects_codes?: string[]; is_enabled_for_all_projects?: boolean };
    const types = ["number", "string", "text", "selectbox", "checkbox", "radio", "multiselect", "url", "user", "datetime"];
    const field = { id: id(), title: body.title, entity: "case", type: types[body.type], value: body.value ? JSON.stringify(body.value) : undefined, is_enabled_for_all_projects: body.is_enabled_for_all_projects ?? false, projects_codes: body.projects_codes ?? [] };
    state!.customFields.push(field);
    return ok({ id: field.id });
  });
  app.patch("/v1/custom_field/:id", async (request) => {
    const fieldId = Number((request.params as { id: string }).id);
    const field = state!.customFields.find((f) => f.id === fieldId);
    if (field) {
      field.projects_codes = (request.body as { projects_codes?: string[] }).projects_codes ?? field.projects_codes;
    }
    return ok({ id: fieldId });
  });
  app.delete("/v1/custom_field/:id", async (request) => {
    const fieldId = Number((request.params as { id: string }).id);
    state!.customFields = state!.customFields.filter((f) => f.id !== fieldId);
    return ok({ id: fieldId });
  });

  app.get("/v1/suite/:code", async (request) => page(state!.suites[code(request)]!, request));
  app.post("/v1/suite/:code", async (request) => {
    const suite = { id: id(), position: 1, cases_count: 0, ...(request.body as Record<string, unknown>) };
    state!.suites[code(request)]!.push(suite);
    return ok({ id: suite.id });
  });
  app.delete("/v1/suite/:code/:id", async (request) => {
    const suiteId = Number((request.params as { id: string }).id);
    state!.suites[code(request)] = state!.suites[code(request)]!.filter((s) => s.id !== suiteId);
    return ok({ id: suiteId });
  });

  app.get("/v1/milestone/:code", async (request) => page(state!.milestones[code(request)]!, request));
  app.post("/v1/milestone/:code", async (request) => {
    const milestone = { id: id(), title: (request.body as { title: string }).title };
    state!.milestones[code(request)]!.push(milestone);
    return ok({ id: milestone.id });
  });
  app.delete("/v1/milestone/:code/:id", async (request) => {
    const milestoneId = Number((request.params as { id: string }).id);
    state!.milestones[code(request)] = state!.milestones[code(request)]!.filter((m) => m.id !== milestoneId);
    return ok({ id: milestoneId });
  });

  app.get("/v1/shared_step/:code", async (request) => page(state!.sharedSteps[code(request)]!, request));
  app.post("/v1/shared_step/:code", async (request) => {
    const body = request.body as { title: string; steps: Step[] };
    const hash = `sh${id()}`;
    const hashed = (steps: Step[]): Step[] => steps.map((step) => ({ ...step, hash: `s${id()}`, ...(step.steps ? { steps: hashed(step.steps) } : {}) }));
    state!.sharedSteps[code(request)]!.push({ hash, title: body.title, steps: hashed(body.steps ?? []) });
    return ok({ hash });
  });
  app.delete("/v1/shared_step/:code/:hash", async (request) => {
    const { hash } = request.params as { hash: string };
    state!.sharedSteps[code(request)] = state!.sharedSteps[code(request)]!.filter((s) => s.hash !== hash);
    return ok({ hash });
  });

  app.post("/v1/attachment/:code", async (request) => {
    const created = (request.body as { names: string[] }).names.map((filename) => {
      const hash = `up${id()}`;
      const file = { hash, filename, mime: filename.endsWith(".csv") ? "text/csv" : "image/png", size: PNG.length, url: `${filesBase(request)}/files/${hash}/${filename}` };
      state!.attachments.push(file);
      return { ...file, extension: filename.split(".").pop(), team: "demo" };
    });
    return ok(created);
  });

  /** A case as Qase stores it: enum defaults, tags as objects, shared steps expanded, hashes turned into files. */
  const stored = (project: string, body: Record<string, unknown>): Case => {
    if (typeof body.isManual === "boolean" || typeof body.isToBeAutomated === "boolean") {
      throw Object.assign(new Error("The selected field value is invalid. Allowed values: 0, 1."), { statusCode: 422 });
    }
    const files = (hashes: unknown) => ((hashes as string[] | undefined) ?? []).map((hash) => state!.attachments.find((a) => a.hash === hash)).filter(Boolean);
    const gherkin = body.steps_type === "gherkin";
    const steps = (list: (Step & { shared?: string; value?: string })[] | undefined): Step[] =>
      (list ?? []).flatMap((step): Step[] => {
        if (step.shared) {
          const shared = state!.sharedSteps[project]!.find((s) => s.hash === step.shared);
          return (shared?.steps ?? []).map((s) => ({ ...s, hash: "c-shared", shared_step_hash: step.shared!, shared_step_nested_hash: s.hash }));
        }
        if (gherkin) {
          if (/^\s*(Feature|Scenario)/m.test(step.value ?? "")) {
            throw Object.assign(new Error("Unable to create test case. Internal error."), { statusCode: 500 });
          }
          return [{ action: step.value ?? "" }];
        }
        const attachments = files(step.attachments);
        return [{ hash: `c${id()}`, action: step.action ?? "", ...(step.expected_result ? { expected_result: step.expected_result } : {}), ...(step.data ? { data: step.data } : {}), ...(attachments.length ? { attachments } : {}), ...(step.steps ? { steps: steps(step.steps) } : {}) }];
      });
    const { custom_field: custom, tags, parameters, steps: rawSteps, attachments, ...rest } = body;
    const manual = rest.isManual === undefined ? true : rest.isManual === 1;
    const attached = files(attachments);
    return {
      severity: 4,
      priority: 0,
      type: 1,
      layer: 0,
      is_flaky: 0,
      behavior: 1,
      status: 0,
      member_id: 1,
      author_id: 501,
      created_at: "2026-02-01T10:00:00+00:00",
      updated_at: "2026-02-01T10:00:00+00:00",
      ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined && value !== null && value !== "")),
      id: id(),
      title: String(body.title),
      isManual: manual,
      isToBeAutomated: manual && rest.isToBeAutomated === 1,
      automation: manual ? (rest.isToBeAutomated === 1 ? 1 : 0) : 2,
      ...(custom ? { custom_fields: Object.entries(custom as Record<string, string>).flatMap(([fieldId, value]) => value.split(",").map((v) => ({ id: Number(fieldId), value: v }))) } : {}),
      ...(tags ? { tags: (tags as string[]).map((title, index) => ({ title, internal_id: index + 1 })) } : {}),
      ...(parameters
        ? {
            parameters: (parameters as ({ title?: string; values?: string[]; items?: unknown[] })[]).map((p) =>
              p.items ? { type: "group", items: p.items } : { type: "single", item: { title: p.title, values: p.values } },
            ),
          }
        : {}),
      ...(rawSteps ? { steps_type: gherkin ? "gherkin" : "classic", steps: steps(rawSteps as Step[]) } : {}),
      ...(attached.length ? { attachments: attached } : {}),
    };
  };

  app.get("/v1/case/:code", async (request) => page(state!.cases[code(request)]!, request));
  app.get("/v1/case/:code/:id", async (request, reply) => {
    const found = state!.cases[code(request)]!.find((c) => c.id === Number((request.params as { id: string }).id));
    return found ? ok(found) : reply.status(404).send({ status: false, errorMessage: "TestCase not found" });
  });
  app.post("/v1/case/:code", async (request) => {
    const created = stored(code(request), request.body as Record<string, unknown>);
    state!.cases[code(request)]!.push(created);
    return ok({ id: created.id });
  });
  app.post("/v1/case/:code/bulk", async (request) => {
    const created = (request.body as { cases: Record<string, unknown>[] }).cases.map((body) => stored(code(request), body));
    state!.cases[code(request)]!.push(...created);
    return ok({ ids: created.map((c) => c.id) });
  });
  app.delete("/v1/case/:code/:id", async (request) => {
    const caseId = Number((request.params as { id: string }).id);
    state!.cases[code(request)] = state!.cases[code(request)]!.filter((c) => c.id !== caseId);
    return ok({ id: caseId });
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    void reply.status(error.statusCode ?? 500).send({ status: false, errorMessage: error.message });
  });

  return holder;
}
