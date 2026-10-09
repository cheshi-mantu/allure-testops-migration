import type { FieldTarget, FixLink, Profile, RunProblem } from "@atm/shared";
import { HttpError } from "../http/httpClient.js";

/** A problem as reported by the code that finds it; the collector counts it and keeps the affected cases. */
export interface ProblemInput {
  key: string;
  code: string;
  level: "warn" | "error";
  title: string;
  hint: string;
  fix?: FixLink;
  detail?: string;
}

const CASES_PER_PROBLEM = 500;
const PROBLEM_LIMIT = 200;

export class ProblemCollector {
  private readonly problems = new Map<string, RunProblem>();

  report(problem: ProblemInput, caseLabel?: string): RunProblem {
    let entry = this.problems.get(problem.key);
    if (!entry) {
      if (this.problems.size >= PROBLEM_LIMIT) {
        entry = this.problems.get("too-many") ?? {
          key: "too-many",
          code: "too-many",
          level: "warn",
          title: "Many different problems were found; only the first ones are listed.",
          hint: "Fix the listed problems and run again, or download the log for the full list.",
          count: 0,
          cases: [],
        };
        this.problems.set("too-many", entry);
      } else {
        entry = { ...problem, count: 0, cases: [] };
        this.problems.set(problem.key, entry);
      }
    }
    entry.count += 1;
    if (caseLabel && entry.cases.length < CASES_PER_PROBLEM && !entry.cases.includes(caseLabel)) {
      entry.cases.push(caseLabel);
    }
    return entry;
  }

  list(): RunProblem[] {
    return [...this.problems.values()].sort((a, b) => Number(b.level === "error") - Number(a.level === "error") || b.count - a.count);
  }
}

/** The first source field mapped to a target, for "fix it here" links. */
export function fieldFor(profile: Profile, match: (target: FieldTarget) => boolean): string | undefined {
  return profile.fields.find((m) => match(m.target))?.source;
}

/** What the migration was doing when Allure TestOps answered with an error. */
export type Operation =
  | "find the test case"
  | "create the test case"
  | "update the test case"
  | "set tags"
  | "set custom fields"
  | "set issues"
  | "set test keys"
  | "set members"
  | "add comments"
  | "upload attachments"
  | "set the scenario"
  | "migrate a shared step"
  | "create a custom field"
  | "create a test layer"
  | "create the tree"
  | "read the project";

export class OperationFailed extends Error {
  constructor(
    readonly operation: Operation,
    readonly reason: unknown,
  ) {
    super(`Could not ${operation}: ${reason instanceof Error ? reason.message : String(reason)}`);
    this.name = "OperationFailed";
  }
}

export interface Explanation {
  /** Short, human readable cause. */
  title: string;
  hint: string;
  fix?: FixLink;
  /** Server message, verbatim. */
  detail?: string;
  /** Groups the same failure over many cases. */
  key: string;
}

/**
 * Failures on the server side that often pass: internal errors, overload, a web page instead of API data,
 * timeouts and lost connections. The same request may work a little later.
 */
export function isTransient(error: unknown): boolean {
  const cause = error instanceof OperationFailed ? error.reason : error;
  if (cause instanceof HttpError) {
    return cause.notApi || cause.status === 0 || cause.status === 429 || cause.status >= 500;
  }
  return cause instanceof Error && (cause.name === "TimeoutError" || /timed out|timeout/i.test(cause.message));
}

/** The message Allure TestOps (or TestRail) put into an error response, if any. */
export function serverMessage(error: unknown): string | undefined {
  if (!(error instanceof HttpError) || !error.body) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(error.body) as Record<string, unknown>;
    const text = parsed.message ?? parsed.error ?? parsed.errorMessage ?? parsed.detail;
    if (typeof text === "string" && text.trim()) {
      return text.trim().slice(0, 500);
    }
    const errors = parsed.errors ?? parsed.fieldErrors;
    if (Array.isArray(errors) && errors.length > 0) {
      return JSON.stringify(errors).slice(0, 500);
    }
  } catch {
    // Not JSON: an HTML error page from a proxy, for example.
  }
  const plain = error.body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return plain ? plain.slice(0, 300) : undefined;
}

export interface ExplainContext {
  profile: Profile;
  service: Service;
}

export type Service = "Allure TestOps" | "TestRail" | "Jira" | "Xray";

const CREDENTIAL_HINTS: Record<Service, string> = {
  TestRail: "The user email or API key is wrong, or the API key was deleted. Create a new API key in TestRail (My Settings, API Keys) and enter it on the Connections step.",
  "Allure TestOps": "The API token is wrong, expired or was revoked. Create a new token in Allure TestOps (your profile, API tokens) and enter it on the Connections step.",
  Jira: "The email or API token is wrong, or the token was revoked. Create an API token for the Atlassian account (id.atlassian.com, Security, API tokens) and enter it on the Connections step.",
  Xray: "The Xray API key (client id and secret) is wrong or was revoked, or the region does not match the Jira site. Create an API key in Jira (Apps, Xray, API Keys) and enter it on the Connections step.",
};

/**
 * Turns a failed request into what a user needs to fix it: what went wrong in their terms, why, and
 * which setting to change. The raw server message is kept as `detail` for support.
 */
export function explain(error: unknown, operation: Operation, context: ExplainContext): Explanation {
  const { profile, service } = context;
  const cause = error instanceof OperationFailed ? error.reason : error;
  const detail = serverMessage(cause) ?? (cause instanceof Error ? cause.message : String(cause));
  const status = cause instanceof HttpError ? cause.status : -1;
  const project = profile.testops.scope.projectId;
  const connections: FixLink = { step: "connections" };
  const key = (suffix: string) => `failed:${operation}:${suffix}`;
  const fieldMatching = (match: (target: FieldTarget) => boolean): FixLink => ({ step: "fields", field: fieldFor(profile, match) });

  if (cause instanceof HttpError && cause.notApi) {
    return {
      key: "server:not-api",
      title: `${service} answered with a web page instead of API data.`,
      hint: `The request did not reach the ${service} API: the server or a proxy in front of it could not route it, which happens when the server is overloaded or restarting. Such cases are tried again at the end of the run. If they still fail, lower "Cases migrated in parallel" on the Options step and run again: migrated cases are updated, not duplicated. If it keeps happening, send the downloaded log to the ${service} administrator.`,
      fix: { step: "options" },
      detail,
    };
  }
  if (status === 0) {
    const tls = /tls|certificate/i.test(detail);
    return {
      key: key("network"),
      title: `${service} could not be reached.`,
      hint: tls
        ? `The server's TLS certificate is not trusted. If the server uses a self-signed or company certificate, turn on "Skip TLS certificate verification" for ${service} on the Connections step.`
        : `Check the ${service} URL on the Connections step and that the machine running this tool can reach it (VPN, proxy, firewall).`,
      fix: connections,
      detail,
    };
  }
  if (status === 401) {
    return {
      key: key("401"),
      title: `${service} rejected the credentials.`,
      hint: CREDENTIAL_HINTS[service],
      fix: connections,
      detail,
    };
  }
  if (status === 403) {
    return {
      key: key("403"),
      title: `The ${service} user is not allowed to ${operation}.`,
      hint:
        service === "TestRail"
          ? "Check that the TestRail API is enabled (Administration, Site Settings, API) and that the user can read the project."
          : service === "Jira" || service === "Xray"
            ? "The Jira user must be able to browse the project, its issues and attachments. Ask a Jira administrator for the Browse projects permission in this project."
            : `Use the token of a user who can edit test cases in project #${project}, or ask a project administrator to grant that permission.${operation === "create a custom field" || operation === "create the tree" ? " Creating custom fields and trees needs project or instance administrator rights." : ""}`,
      fix: connections,
      detail,
    };
  }
  if (status === 429) {
    return {
      key: key("429"),
      title: `${service} limited the number of requests.`,
      hint: `Lower "Cases migrated in parallel" on the Options step${service === "TestRail" ? " or the TestRail API rate limit on the Connections step" : ""}, then run again. Migrated cases are updated, not duplicated.`,
      fix: { step: "options" },
      detail,
    };
  }
  if (status >= 500 || (status === -1 && /timed out|timeout/i.test(detail))) {
    return {
      key: key("server"),
      title: status >= 500 ? `${service} failed with an internal error (${status}).` : `${service} did not answer in time.`,
      hint: `This is a problem on the ${service} side, often under load. Such cases are tried again at the end of the run. If they still fail, lower "Cases migrated in parallel" on the Options step and run again: migrated cases are updated, not duplicated. If it repeats, send the downloaded log to the ${service} administrator.`,
      fix: { step: "options" },
      detail,
    };
  }
  if (status === 413) {
    return {
      key: key("413"),
      title: "A file is larger than the upload limit of Allure TestOps.",
      hint: "Ask the Allure TestOps administrator to raise the upload size limit, or turn off attachment migration on the Options step.",
      fix: { step: "options" },
      detail,
    };
  }
  // 400, 404, 409, 422 and anything else: the answer depends on what was being done.
  switch (operation) {
    case "set custom fields":
      return {
        key: key(`${status}:${detail.slice(0, 80)}`),
        title: "Allure TestOps rejected custom field values.",
        hint: "A custom field can be locked to a fixed list of values or allow only one value in this project. Allow the values in the project settings of Allure TestOps, or translate the source values to allowed ones in the value mapping of the field.",
        fix: { step: "fields" },
        detail,
      };
    case "set the scenario":
      return {
        key: key(`${status}:${detail.slice(0, 80)}`),
        title: "Allure TestOps rejected the scenario.",
        hint:
          profile.source === "csv"
            ? "Check how the scenario column is split into steps (Columns step, the column mapped to the scenario) and look at the case on the Preview step."
            : "Look at the case on the Preview step; very long steps or unusual content may be rejected.",
        fix: fieldMatching((t) => t.kind === "scenario"),
        detail,
      };
    case "set issues":
      return {
        key: key(`${status}:${detail.slice(0, 80)}`),
        title: "Allure TestOps did not accept the issue links.",
        hint: "Check that the issue tracker integration chosen for the issues field is enabled in the project, and that the values are issue keys such as ABC-123 (set a separator when a cell holds several).",
        fix: fieldMatching((t) => t.kind === "issue"),
        detail,
      };
    case "set test keys":
      return {
        key: key(`${status}:${detail.slice(0, 80)}`),
        title: "Allure TestOps did not accept the test keys.",
        hint: "The integration chosen for test keys on the Options step must be enabled in the project and support test keys (a test management system integration). Choose another one, or turn test keys off.",
        fix: { step: "options" },
        detail,
      };
    case "set members":
      return {
        key: key(`${status}:${detail.slice(0, 80)}`),
        title: "Allure TestOps did not accept the owner or members.",
        hint: "Every owner and member must be an existing Allure TestOps user. Map source users to Allure TestOps user names in the value mapping.",
        fix: fieldMatching((t) => t.kind === "owner" || t.kind === "role"),
        detail,
      };
    case "update the test case":
    case "find the test case":
      if (status === 404) {
        return {
          key: key("404"),
          title: "The test case no longer exists in Allure TestOps.",
          hint: "It was probably deleted while the migration ran. Run the migration again to recreate it.",
          detail,
        };
      }
      break;
    case "read the project":
      if (status === 404) {
        return {
          key: key("404"),
          title: `Project #${project} was not found in Allure TestOps.`,
          hint: "The project was deleted or the token's user cannot see it. Choose the project again on the Project step.",
          fix: { step: "scope" },
          detail,
        };
      }
      break;
    default:
      break;
  }
  return {
    key: key(`${status}:${detail.slice(0, 80)}`),
    title: `${service} refused to ${operation}${status > 0 ? ` (${status})` : ""}.`,
    hint: `The message from ${service} below says why. Look at the affected case on the Preview step; if the message is unclear, download the log and send it to support.`,
    detail,
  };
}

/** An error this tool recognises, with its own explanation (no server involved). */
export class KnownProblem extends Error {
  constructor(readonly explanation: Explanation) {
    super(explanation.title);
    this.name = "KnownProblem";
  }
}

/** Service that produced an HTTP error, from the request URL. */
export function serviceOf(error: unknown, profile: Profile): Service {
  const cause = error instanceof OperationFailed ? error.reason : error;
  if (cause instanceof HttpError) {
    const startsWith = (base: string) => Boolean(base) && cause.url.startsWith(base.replace(/\/+$/, ""));
    if (profile.source === "testrail" && startsWith(profile.testrail.connection.endpoint)) {
      return "TestRail";
    }
    if (profile.source === "xray" && !startsWith(profile.testops.connection.endpoint)) {
      if (/getxray\.app|\/api\/v\d+\/(?:graphql|authenticate|attachments?)/.test(cause.url)) {
        return "Xray";
      }
      if (startsWith(profile.xray.connection.jiraUrl)) {
        return "Jira";
      }
    }
  }
  return "Allure TestOps";
}
