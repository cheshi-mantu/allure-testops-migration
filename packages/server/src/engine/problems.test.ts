import { describe, expect, it } from "vitest";
import { newProfile } from "@atm/shared";
import { HttpError } from "../http/httpClient.js";
import { explain, isTransient, OperationFailed, ProblemCollector, serverMessage } from "./problems.js";

const profile = newProfile("p", "p", new Date(), "csv");
profile.testops.scope.projectId = 7;
profile.fields = [
  { source: "Steps", target: { kind: "scenario" }, values: {}, separator: "" },
  { source: "Jira", target: { kind: "issue", integrationId: 3 }, values: {}, separator: "," },
];
const http = (status: number, body = "") => new HttpError(`failed with ${status}`, status, "https://testops.example/api/rs/testcase/1/cfv", body);
const context = { profile, service: "Allure TestOps" as const };

describe("explain", () => {
  it("sends credential problems to the Connections step", () => {
    const e = explain(new OperationFailed("create the test case", http(401)), "create the test case", context);
    expect(e.title).toBe("Allure TestOps rejected the credentials.");
    expect(e.hint).toMatch(/new token/);
    expect(e.fix).toEqual({ step: "connections" });
  });

  it("names the missing permission and the project", () => {
    const e = explain(http(403), "create the test case", context);
    expect(e.title).toBe("The Allure TestOps user is not allowed to create the test case.");
    expect(e.hint).toMatch(/project #7/);
  });

  it("explains refused custom field values and keeps the server message", () => {
    const e = explain(http(400, JSON.stringify({ message: "Custom field value [X] is not allowed" })), "set custom fields", context);
    expect(e.title).toBe("Allure TestOps rejected custom field values.");
    expect(e.hint).toMatch(/value mapping/);
    expect(e.detail).toBe("Custom field value [X] is not allowed");
    expect(e.fix).toEqual({ step: "fields" });
  });

  it("points scenario and issue problems at the mapped column", () => {
    expect(explain(http(400), "set the scenario", context).fix).toEqual({ step: "fields", field: "Steps" });
    expect(explain(http(400), "set issues", context).fix).toEqual({ step: "fields", field: "Jira" });
  });

  it("tells network and TLS problems apart", () => {
    expect(explain(new HttpError("x", 0, "u", ""), "read the project", context).hint).toMatch(/URL/);
    expect(explain(new Error("the TLS certificate is not trusted"), "read the project", { ...context }).title).toBeDefined();
    const tls = explain(new HttpError("Cannot reach: the TLS certificate is not trusted", 0, "u", ""), "read the project", context);
    expect(tls.hint).toMatch(/Skip TLS certificate verification/);
  });

  it("suggests fewer parallel cases when rate limited or overloaded", () => {
    expect(explain(http(429), "set tags", context).fix).toEqual({ step: "options" });
    expect(explain(http(503), "set tags", context).fix).toEqual({ step: "options" });
  });

  it("explains a web page answer the same way for every operation, not as a refused value", () => {
    const page = new HttpError("POST https://testops.example/api/rs/testcase/1/cfv was answered with a web page (200) instead of API data", 200, "u", "", true);
    const e = explain(new OperationFailed("set custom fields", page), "set custom fields", context);
    expect(e.title).toBe("Allure TestOps answered with a web page instead of API data.");
    expect(e.key).toBe(explain(page, "find the test case", context).key);
    expect(e.hint).toMatch(/tried again at the end of the run/);
    expect(e.detail).not.toMatch(/<|window/);
  });

  it("tells server side failures from refused requests", () => {
    expect(isTransient(new OperationFailed("create the test case", http(500)))).toBe(true);
    expect(isTransient(new HttpError("x", 200, "u", "", true))).toBe(true);
    expect(isTransient(new HttpError("x", 0, "u", ""))).toBe(true);
    expect(isTransient(http(400))).toBe(false);
    expect(isTransient(http(403))).toBe(false);
  });

  it("reads messages from JSON and HTML error pages", () => {
    expect(serverMessage(http(400, '{"errors":[{"field":"name","message":"too long"}]}'))).toBe('[{"field":"name","message":"too long"}]');
    expect(serverMessage(http(502, "<html><body><h1>Bad Gateway</h1></body></html>"))).toBe("Bad Gateway");
  });
});

describe("ProblemCollector", () => {
  it("counts a problem once per occurrence and lists errors first", () => {
    const problems = new ProblemCollector();
    const warn = { key: "user:ann", code: "user-missing", level: "warn" as const, title: "t", hint: "h" };
    problems.report(warn, "Line 2");
    problems.report(warn, "Line 3");
    problems.report(warn, "Line 3");
    problems.report({ ...warn, key: "failed", code: "failed", level: "error" }, "Line 9");
    const list = problems.list();
    expect(list.map((p) => [p.key, p.count, p.cases])).toEqual([
      ["failed", 1, ["Line 9"]],
      ["user:ann", 3, ["Line 2", "Line 3"]],
    ]);
  });
});
