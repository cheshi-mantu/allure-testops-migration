import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

/**
 * A fake Allure TestOps REST API with in-memory state. It implements only the calls the
 * migration tool makes and exposes `GET /__state` so tests can inspect the result.
 */

interface Named {
  id: number;
  name: string;
}

interface Step {
  id: number;
  data: Record<string, unknown>;
}

interface TestCase {
  id: number;
  projectId: number;
  name: string;
  description: string;
  precondition: string;
  expectedResult: string;
  statusId: number | null;
  testLayerId: number | null;
  links: unknown[];
  tags: string[];
  cfv: { name: string; customField: { id: number; name?: string } }[];
  issues: unknown[];
  testKeys: { name: string; integrationId: number }[];
  automated?: boolean;
  examples: { id: number; parameters: { name: string; value: string }[] }[];
  members: unknown[];
  scenario: Step[];
  attachments: Named[];
}

interface SharedStep extends Named {
  projectId: number;
  scenario: Step[];
  attachments: Named[];
}

export interface TestOpsMockState {
  customFields: Named[];
  projectCustomFields: Record<number, number[]>;
  customFieldValues: Record<number, string[]>;
  layers: Named[];
  trees: (Named & { projectId: number; fields: { id: number }[] })[];
  testCases: TestCase[];
  sharedSteps: SharedStep[];
  comments: { id: number; testCaseId: number; body: string }[];
}

export interface TestOpsMockOptions {
  apiToken?: string;
  /** Delay every answer, to try progress reporting against a slow instance. */
  latencyMs?: number;
  /** Custom field values the fake refuses with 400, like a field locked to a list of values. */
  rejectedCustomFieldValues?: string[];
  /**
   * Requests that fail like an overloaded server: `times` matching requests get a 500 or the web page
   * of the application instead of API data. The list is consumed, so tests can inspect what is left.
   */
  failures?: { method: string; path: RegExp; times: number; answer: 500 | "webPage" }[];
}

function pageOf<T>(items: T[], request: FastifyRequest) {
  const query = request.query as Record<string, string | undefined>;
  const size = Number(query.size ?? 20);
  const number = Number(query.page ?? 0);
  return {
    content: items.slice(number * size, number * size + size),
    number,
    size,
    totalElements: items.length,
    totalPages: Math.max(1, Math.ceil(items.length / size)),
  };
}

export function createTestOpsMock(options: TestOpsMockOptions = {}): { app: FastifyInstance; state: TestOpsMockState } {
  const token = options.apiToken ?? "demo-api-token";
  const app = Fastify({ logger: false, bodyLimit: 50 * 1024 * 1024 });
  let nextId = 1000;
  const id = () => ++nextId;

  const projects: Named[] = [
    { id: 1, name: "Demo" },
    { id: 2, name: "Sandbox" },
  ];
  const statuses: Named[] = [
    { id: 1, name: "Draft" },
    { id: 2, name: "Active" },
    { id: 3, name: "Outdated" },
  ];
  const accounts = [
    { id: 1, username: "admin", email: "admin@example.com", firstName: "Admin", lastName: "" },
    { id: 2, username: "jane", email: "jane@example.com", firstName: "Jane", lastName: "Doe" },
    { id: 3, username: "sam", email: "sam@example.com", firstName: "Sam", lastName: "Tester" },
  ];
  const instanceIntegrations = [
    { id: 1, name: "Jira", info: { name: "Jira", type: "jira" } },
    { id: 5, name: "YouTrack", info: { name: "YouTrack", type: "youtrack" } },
  ];
  const integrations: Record<number, (Named & { disabled: boolean; info?: unknown })[]> = { 1: [{ ...instanceIntegrations[0]!, disabled: false }] };
  const state: TestOpsMockState = {
    customFields: [
      { id: 1, name: "Epic" },
      { id: 2, name: "Feature" },
      { id: 3, name: "Story" },
      { id: 4, name: "Priority" },
    ],
    projectCustomFields: { 1: [1, 2, 3] },
    customFieldValues: { 4: ["Low", "Normal", "High", "Critical"] },
    layers: [
      { id: 1, name: "UI" },
      { id: 2, name: "API" },
    ],
    trees: [],
    testCases: [],
    sharedSteps: [],
    comments: [],
  };

  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/__state")) {
      return;
    }
    if (options.latencyMs) {
      await new Promise((resolve) => setTimeout(resolve, options.latencyMs));
    }
    if (request.headers.authorization !== `Api-Token ${token}`) {
      return reply.status(401).send({ message: "Unauthorized" });
    }
    const failure = options.failures?.find((f) => f.times > 0 && f.method === request.method && f.path.test(request.url.split("?")[0]!));
    if (failure) {
      failure.times -= 1;
      return failure.answer === 500
        ? reply.status(500).send({ message: "An unexpected error occurred" })
        : reply.status(200).type("text/html").send("<!doctype html><html><head><script>window.__APP__ = {};</script></head><body></body></html>");
    }
  });

  app.addContentTypeParser("multipart/form-data", (request, payload, done) => {
    const chunks: Buffer[] = [];
    payload.on("data", (chunk: Buffer) => chunks.push(chunk));
    payload.on("end", () => {
      const text = Buffer.concat(chunks).toString("latin1");
      const names = [...text.matchAll(/filename="([^"]*)"/g)].map((m) => m[1]!);
      done(null, { names });
    });
    payload.on("error", done);
  });

  const testCase = (request: FastifyRequest) => {
    const found = state.testCases.find((tc) => tc.id === Number((request.params as { id: string }).id));
    if (!found) {
      throw Object.assign(new Error("Test case not found"), { statusCode: 404 });
    }
    return found;
  };
  const sharedStep = (request: FastifyRequest) => {
    const found = state.sharedSteps.find((s) => s.id === Number((request.params as { id: string }).id));
    if (!found) {
      throw Object.assign(new Error("Shared step not found"), { statusCode: 404 });
    }
    return found;
  };
  /**
   * A scenario as Allure TestOps lists it: every step by id, children by id, the expected result as
   * a step of its own the parent points to, files and shared steps (with their steps) by id.
   * Top level steps keep the ids they are stored with, so they can be deleted by them.
   */
  let nestedId = 9_000_000;
  const files = (list: Named[]) => Object.fromEntries(list.map((a) => [a.id, { id: a.id, name: a.name, contentType: "application/octet-stream" }]));
  const normalized = (steps: Step[], own: Named[] = []) => {
    const scenarioSteps: Record<number, Record<string, unknown>> = {};
    const sharedSteps: Record<number, Record<string, unknown>> = {};
    const sharedStepScenarioSteps: Record<number, Record<string, unknown>> = {};
    const sharedStepAttachments: Record<number, unknown> = {};
    const add = (data: Record<string, unknown>, into: Record<number, Record<string, unknown>>, fixedId?: number): number => {
      const stepId = fixedId ?? ++nestedId;
      switch (data.type) {
        case "attachment":
          into[stepId] = { id: stepId, attachmentId: data.attachmentId, children: [] };
          break;
        case "shared": {
          const shared = state.sharedSteps.find((s) => s.id === data.sharedStepId);
          into[stepId] = { id: stepId, sharedStepId: data.sharedStepId, children: [] };
          if (shared && !sharedSteps[shared.id]) {
            sharedSteps[shared.id] = { id: shared.id, name: shared.name, body: shared.name, children: shared.scenario.map((s) => add(s.data, sharedStepScenarioSteps)) };
            Object.assign(sharedStepAttachments, files(shared.attachments));
          }
          break;
        }
        default: {
          const children = ((data.steps as Record<string, unknown>[] | undefined) ?? []).map((child) => add(child, into));
          let expectedResultId: number | undefined;
          const expected = (data.expectedResultSteps as Record<string, unknown>[] | undefined) ?? [];
          if (expected.length > 0) {
            expectedResultId = ++nestedId;
            into[expectedResultId] = { id: expectedResultId, body: "Expected Result", children: expected.map((child) => add(child, into)) };
            children.push(expectedResultId);
          }
          into[stepId] = { id: stepId, body: data.body, children, ...(expectedResultId ? { expectedResultId } : {}) };
        }
      }
      return stepId;
    };
    const root = { children: steps.map((s) => add(s.data, scenarioSteps, s.id)) };
    return { root, scenarioSteps, attachments: files(own), sharedSteps, sharedStepScenarioSteps, sharedStepAttachments };
  };

  app.get("/__state", async () => state);

  app.get("/api/uaa/account/me", async () => accounts[0]);
  app.get("/api/uaa/account", async (request) => pageOf(accounts, request));

  app.get("/api/rs/role", async () => [
    { id: -1, name: "Owner" },
    { id: 2, name: "Reviewer" },
    { id: 3, name: "Tester" },
  ]);
  app.get("/api/rs/testcase/:id", async (request) => testCase(request));
  app.get("/api/rs/project", async (request) => pageOf(projects, request));
  app.get("/api/rs/project/:id", async (request, reply) => {
    const project = projects.find((p) => p.id === Number((request.params as { id: string }).id));
    return project ?? reply.status(404).send({ message: "Project not found" });
  });

  // Like current Allure TestOps: project bindings, paged, each carrying the custom field.
  app.get("/api/rs/project/:id/cf", async (request) => {
    const projectId = Number((request.params as { id: string }).id);
    const ids = state.projectCustomFields[projectId] ?? [];
    const bindings = state.customFields
      .filter((f) => ids.includes(f.id))
      .map((f) => ({ id: 50_000 + f.id, projectId, name: f.name, customField: { id: f.id, name: f.name } }));
    return pageOf(bindings, request);
  });
  app.get("/api/rs/cf/suggest", async (request) => {
    const query = ((request.query as { query?: string }).query ?? "").toLowerCase();
    return pageOf(state.customFields.filter((f) => f.name.toLowerCase().includes(query)), request);
  });
  app.post("/api/rs/cf", async (request) => {
    const { name } = request.body as { name: string };
    const field = { id: id(), name };
    state.customFields.push(field);
    return field;
  });
  app.post("/api/rs/cfproject/add-to-project", async (request) => {
    const projectId = Number((request.query as { projectId: string }).projectId);
    const { ids } = request.body as { ids: number[] };
    state.projectCustomFields[projectId] = [...new Set([...(state.projectCustomFields[projectId] ?? []), ...ids])];
    return {};
  });
  app.get("/api/rs/cfv/suggest", async (request) => {
    const { customFieldId, query } = request.query as { customFieldId: string; query?: string };
    const fieldId = Number(customFieldId);
    const needle = (query ?? "").toLowerCase();
    const matches = (state.customFieldValues[fieldId] ?? []).filter((name) => name.toLowerCase().includes(needle));
    return pageOf(matches.map((name, index) => ({ id: fieldId * 1000 + index, name })), request);
  });
  app.get("/api/rs/cfv", async (request) => {
    const fieldId = Number((request.query as { customFieldId: string }).customFieldId);
    return pageOf((state.customFieldValues[fieldId] ?? []).map((name, index) => ({ id: fieldId * 1000 + index, name })), request);
  });

  app.get("/api/rs/testlayer", async (request) => pageOf(state.layers, request));
  app.post("/api/rs/testlayer", async (request) => {
    const layer = { id: id(), name: (request.body as { name: string }).name };
    state.layers.push(layer);
    return layer;
  });
  app.get("/api/rs/status", async (request) => pageOf(statuses, request));
  app.get("/api/rs/integration/project/:id", async (request) => pageOf(integrations[Number((request.params as { id: string }).id)] ?? [], request));
  app.get("/api/rs/integration", async (request) => pageOf(instanceIntegrations, request));
  app.post("/api/rs/integration/project", async (request, reply) => {
    const { projectId, integrationId } = request.body as { projectId: number; integrationId: number };
    const integration = instanceIntegrations.find((i) => i.id === integrationId);
    if (!integration) {
      return reply.status(404).send({ message: "Integration not found" });
    }
    (integrations[projectId] ??= []).push({ ...integration, disabled: false });
    return { projectId, ...integration };
  });
  app.get("/api/rs/workflow", async (request) => pageOf([{ id: 1, name: "Default", statuses }], request));
  app.post("/api/rs/project", async (request) => {
    const project = { id: id(), name: (request.body as { name: string }).name };
    projects.push(project);
    return project;
  });

  app.get("/api/rs/tree", async (request) => {
    const projectId = Number((request.query as { projectId: string }).projectId);
    return pageOf(state.trees.filter((t) => t.projectId === projectId), request);
  });
  app.post("/api/rs/tree", async (request) => {
    const body = request.body as { name: string; projectId: number; fields: { id: number }[] };
    const tree = { id: id(), ...body };
    state.trees.push(tree);
    return tree;
  });

  app.get("/api/rs/testcase/__search", async (request) => {
    const { projectId, rql } = request.query as { projectId: string; rql: string };
    const tag = /tag\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(rql)?.[1]?.replace(/\\"/g, '"');
    const found = state.testCases.filter((tc) => tc.projectId === Number(projectId) && (tag === undefined || tc.tags.includes(tag)));
    return pageOf(found, request);
  });
  app.post("/api/rs/testcase", async (request) => {
    const { projectId, name } = request.body as { projectId: number; name: string };
    const created: TestCase = {
      id: id(),
      projectId,
      name,
      description: "",
      precondition: "",
      expectedResult: "",
      statusId: 1,
      testLayerId: null,
      links: [],
      tags: [],
      cfv: [],
      issues: [],
      testKeys: [],
      examples: [],
      members: [],
      scenario: [],
      attachments: [],
    };
    state.testCases.push(created);
    return created;
  });
  app.patch("/api/rs/testcase/:id", async (request) => {
    const tc = testCase(request);
    Object.assign(tc, request.body as Partial<TestCase>);
    return tc;
  });
  app.post("/api/rs/testcase/:id/tag", async (request) => {
    const tc = testCase(request);
    tc.tags = (request.body as { name: string }[]).map((t) => t.name);
    return tc.tags.map((name) => ({ name }));
  });
  app.get("/api/rs/testcase/:id/cfv", async (request) => testCase(request).cfv);
  app.post("/api/rs/testcase/:id/cfv", async (request, reply) => {
    const tc = testCase(request);
    const rejected = (request.body as TestCase["cfv"]).find((v) => options.rejectedCustomFieldValues?.includes(v.name));
    if (rejected) {
      return reply.status(400).send({ message: `Custom field value [${rejected.name}] is not allowed for this project` });
    }
    tc.cfv = request.body as TestCase["cfv"];
    for (const value of tc.cfv) {
      const values = (state.customFieldValues[value.customField.id] ??= []);
      if (!values.includes(value.name)) {
        values.push(value.name);
      }
    }
    return tc.cfv;
  });
  app.post("/api/rs/testcase/:id/issue", async (request) => {
    const tc = testCase(request);
    tc.issues = request.body as unknown[];
    return tc.issues;
  });
  app.get("/api/rs/testcase/:id/testkey", async (request) => {
    const tc = state.testCases.find((t) => t.id === Number((request.params as { id: string }).id));
    return tc?.testKeys ?? [];
  });
  app.post("/api/rs/testcase/:id/testkey", async (request, reply) => {
    const tc = state.testCases.find((t) => t.id === Number((request.params as { id: string }).id));
    if (!tc) {
      return reply.status(404).send({ message: "Test case not found" });
    }
    const keys = request.body as { name: string; integrationId: number }[];
    if (keys.some((k) => !(integrations[tc.projectId] ?? []).some((i) => i.id === k.integrationId))) {
      return reply.status(400).send({ message: "Integration not found in project" });
    }
    tc.testKeys = keys;
    return keys;
  });
  app.get("/api/rs/testcase/:id/example", async (request) => pageOf(testCase(request).examples, request));
  app.post("/api/rs/testcase/:id/example", async (request) => {
    const tc = testCase(request);
    tc.examples = (request.body as { name: string; value: string }[][]).map((parameters) => ({ id: id(), parameters }));
    return tc.examples;
  });
  app.post("/api/rs/testcase/:id/members", async (request, reply) => {
    const tc = testCase(request);
    const members = request.body as { name: string }[];
    if (members.some((m) => !accounts.some((a) => a.username === m.name))) {
      return reply.status(400).send({ message: "User not found" });
    }
    tc.members = members;
    return members;
  });
  app.get("/api/rs/comment", async (request) => {
    const testCaseId = Number((request.query as { testCaseId: string }).testCaseId);
    return pageOf(state.comments.filter((c) => c.testCaseId === testCaseId), request);
  });
  app.post("/api/rs/comment", async (request) => {
    const comment = { id: id(), ...(request.body as { testCaseId: number; body: string }) };
    state.comments.push(comment);
    return comment;
  });
  app.get("/api/rs/testcase/attachment", async (request) => {
    const tc = state.testCases.find((t) => t.id === Number((request.query as { testCaseId: string }).testCaseId));
    return pageOf(tc?.attachments ?? [], request);
  });
  app.post("/api/rs/testcase/attachment", async (request) => {
    const tc = state.testCases.find((t) => t.id === Number((request.query as { testCaseId: string }).testCaseId))!;
    const created = (request.body as { names: string[] }).names.map((name) => ({ id: id(), name }));
    tc.attachments.push(...created);
    return created;
  });
  app.get("/api/rs/testcase/:id/step", async (request) => normalized(testCase(request).scenario, testCase(request).attachments));
  app.get("/api/rs/testcase/attachment/:id/content", async (request, reply) => {
    const attachmentId = Number((request.params as { id: string }).id);
    const file = state.testCases.flatMap((tc) => tc.attachments).find((a) => a.id === attachmentId);
    return file ? reply.type("application/octet-stream").send(Buffer.from(`content of ${file.name}`)) : reply.status(404).send({ message: "Attachment not found" });
  });
  app.get("/api/rs/sharedstep/attachment/:id/content", async (request, reply) => {
    const attachmentId = Number((request.params as { id: string }).id);
    const file = state.sharedSteps.flatMap((s) => s.attachments).find((a) => a.id === attachmentId);
    return file ? reply.type("application/octet-stream").send(Buffer.from(`content of ${file.name}`)) : reply.status(404).send({ message: "Attachment not found" });
  });
  /** The case page in one answer, from what the fake keeps. */
  app.get("/api/rs/testcase/:id/overview", async (request) => {
    const tc = testCase(request);
    const roles: Record<number, string> = { [-1]: "Owner", 2: "Reviewer", 3: "Tester" };
    const status = statuses.find((s) => s.id === tc.statusId) ?? null;
    return {
      id: tc.id,
      projectId: tc.projectId,
      name: tc.name,
      description: tc.description,
      precondition: tc.precondition,
      expectedResult: tc.expectedResult,
      automated: tc.automated ?? false,
      status,
      workflow: { id: 1, name: "Default", statuses },
      layer: state.layers.find((l) => l.id === tc.testLayerId) ?? null,
      tags: tc.tags.map((name, index) => ({ id: index + 1, name })),
      links: tc.links,
      issues: (tc.issues as { name: string; integrationId: number }[]).map((issue) => ({ ...issue, url: `https://jira.example.com/browse/${issue.name}` })),
      testKeys: tc.testKeys,
      customFields: tc.cfv.map((value) => ({ name: value.name, customField: { id: value.customField.id, name: state.customFields.find((f) => f.id === value.customField.id)?.name } })),
      members: (tc.members as { name: string; role: { id: number } }[]).map((member) => ({ name: member.name, role: { id: member.role.id, name: roles[member.role.id] ?? "Role" } })),
      examples: tc.examples,
    };
  });
  app.delete("/api/rs/testcase/step/:id", async (request) => {
    const stepId = Number((request.params as { id: string }).id);
    for (const tc of state.testCases) {
      tc.scenario = tc.scenario.filter((s) => s.id !== stepId);
    }
    return {};
  });
  app.post("/api/rs/testcase/:id/scenario", async (request) => {
    const tc = testCase(request);
    tc.scenario = (request.body as { steps: Record<string, unknown>[] }).steps.map((data) => ({ id: id(), data }));
    return {};
  });

  app.get("/api/rs/sharedstep", async (request) => {
    const { projectId, search } = request.query as { projectId: string; search?: string };
    return pageOf(state.sharedSteps.filter((s) => s.projectId === Number(projectId) && (!search || s.name.includes(search))), request);
  });
  app.post("/api/rs/sharedstep", async (request) => {
    const { projectId, name } = request.body as { projectId: number; name: string };
    const created: SharedStep = { id: id(), projectId, name, scenario: [], attachments: [] };
    state.sharedSteps.push(created);
    return created;
  });
  app.get("/api/rs/sharedstep/:id/step", async (request) => normalized(sharedStep(request).scenario, sharedStep(request).attachments));
  app.get("/api/rs/sharedstep/:id", async (request) => {
    const step = sharedStep(request);
    return { id: step.id, name: step.name, projectId: step.projectId };
  });
  app.delete("/api/rs/sharedstep/step/:id", async (request) => {
    const stepId = Number((request.params as { id: string }).id);
    for (const step of state.sharedSteps) {
      step.scenario = step.scenario.filter((s) => s.id !== stepId);
    }
    return {};
  });
  app.post("/api/rs/sharedstep/:id/scenario", async (request) => {
    const step = sharedStep(request);
    step.scenario = (request.body as { steps: Record<string, unknown>[] }).steps.map((data) => ({ id: id(), data }));
    return {};
  });
  app.get("/api/rs/sharedstep/attachment", async (request) => {
    const step = state.sharedSteps.find((s) => s.id === Number((request.query as { sharedStepId: string }).sharedStepId));
    return pageOf(step?.attachments ?? [], request);
  });
  app.post("/api/rs/sharedstep/attachment", async (request) => {
    const step = state.sharedSteps.find((s) => s.id === Number((request.query as { sharedStepId: string }).sharedStepId))!;
    const created = (request.body as { names: string[] }).names.map((name) => ({ id: id(), name }));
    step.attachments.push(...created);
    return created;
  });

  return { app, state };
}
