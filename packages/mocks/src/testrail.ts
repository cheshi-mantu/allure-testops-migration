import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import * as data from "./testrailData.js";

export interface TestRailMockOptions {
  username?: string;
  apiKey?: string;
  /** When true, list endpoints return plain arrays like TestRail before 6.7. */
  legacyPagination?: boolean;
  /** Inline images only load with this session cookie, like TestRail 7.x with the new attachment storage. */
  sessionCookie?: string;
}

/** A fake TestRail API v2 serving the synthetic data set. */
export function createTestRailMock(options: TestRailMockOptions = {}): FastifyInstance {
  const username = options.username ?? "demo@example.com";
  const apiKey = options.apiKey ?? "demo-api-key";
  const expected = `Basic ${Buffer.from(`${username}:${apiKey}`).toString("base64")}`;
  const app = Fastify({ logger: false });

  const page = (reply: FastifyReply, key: string, items: unknown[], params: URLSearchParams) => {
    if (options.legacyPagination) {
      return reply.send(items);
    }
    const limit = Math.min(Number(params.get("limit") ?? 250), 250);
    const offset = Number(params.get("offset") ?? 0);
    const slice = items.slice(offset, offset + limit);
    const next = offset + limit < items.length ? `/api/v2/${key}&limit=${limit}&offset=${offset + limit}` : null;
    return reply.send({ offset, limit, size: slice.length, _links: { next, prev: null }, [key]: slice });
  };

  app.get("/index.php", async (request, reply) => {
    const query = request.raw.url!.split("?").slice(1).join("?");
    const [path = "", ...rest] = query.split("&");
    const params = new URLSearchParams(rest.join("&"));

    const attachmentPage = /^\/attachments\/get\/([\w-]+)/.exec(path);
    if (attachmentPage) {
      const cookie = request.headers.cookie ?? "";
      if (options.sessionCookie && !cookie.includes(options.sessionCookie)) {
        return reply.type("text/html").send("<html><body>Login</body></html>");
      }
      return reply.type("image/png").send(data.PNG_1PX);
    }

    if (request.headers.authorization !== expected) {
      return reply.status(401).send({ error: "Authentication failed: invalid or missing user/password or session cookie." });
    }
    const match = /^\/api\/v2\/(\w+)(?:\/([\w-]+))?$/.exec(path);
    if (!match) {
      return reply.status(400).send({ error: `Unknown method ${path}` });
    }
    const [, method, rawId] = match;
    const id = rawId === undefined ? NaN : Number(rawId);
    const suiteId = Number(params.get("suite_id"));

    switch (method) {
      case "get_projects":
        return page(reply, "projects", [data.project], params);
      case "get_project":
        return id === data.project.id ? data.project : reply.status(400).send({ error: "Field :project_id is not a valid or accessible project." });
      case "get_suites":
        return data.suites;
      case "get_suite":
        return data.suites.find((s) => s.id === id) ?? reply.status(400).send({ error: "Field :suite_id is not a valid test suite." });
      case "get_sections":
        return page(reply, "sections", data.sections.filter((s) => s.suite_id === suiteId), params);
      case "get_cases": {
        const deleted = params.get("is_deleted") === "1";
        return page(reply, "cases", data.cases.filter((c) => c.suite_id === suiteId && (deleted ? c.is_deleted === 1 : c.is_deleted === 0)), params);
      }
      case "get_case":
        return data.cases.find((c) => c.id === id) ?? reply.status(400).send({ error: "Field :case_id is not a valid test case." });
      case "get_case_fields":
        return data.caseFields;
      case "get_priorities":
        return data.priorities;
      case "get_case_types":
        return data.caseTypes;
      case "get_case_statuses":
        return reply.status(403).send({ error: "This feature requires TestRail Enterprise." });
      case "get_templates":
        return data.templates;
      case "get_users":
        return page(reply, "users", data.users, params);
      case "get_milestones":
        return page(reply, "milestones", data.milestones, params);
      case "get_shared_step":
        return data.sharedSteps.find((s) => s.id === id) ?? reply.status(400).send({ error: "Field :shared_step_id is not valid." });
      case "get_attachments_for_case":
        return page(reply, "attachments", data.attachments.filter((a) => a.entity_id === String(id)), params);
      case "get_attachment": {
        const attachment = data.attachments.find((a) => a.id === rawId);
        // With the new storage the API does not know the numeric inline ids; only the browser URL serves them.
        if (!attachment) {
          return reply.status(400).send({ error: "Field :attachment_id is not a valid attachment." });
        }
        return reply.type("image/png").send(data.PNG_1PX);
      }
      default:
        return reply.status(400).send({ error: `Unknown method ${method}` });
    }
  });
  return app;
}
