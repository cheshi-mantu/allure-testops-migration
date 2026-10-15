import type { ConnectionCheck, NamedId, Profile } from "@atm/shared";
import { HttpError } from "../http/httpClient.js";
import { TestOpsClient } from "../testops/client.js";
import { TestRailClient } from "../testrail/client.js";
import { AlmClient } from "../alm/client.js";
import { QaseClient } from "../qase/client.js";
import { JiraClient, XrayClient } from "../xray/client.js";

export interface CheckResult extends ConnectionCheck {
  /** `key` for Jira projects. */
  projects: (NamedId & { key?: string })[];
}

function explain(error: unknown, service: string): string {
  if (error instanceof HttpError) {
    if (error.status === 401) {
      return `${service} rejected the credentials. Check the user name and API key/token.`;
    }
    if (error.status === 403) {
      return `${service} denied access. ${service === "TestRail" ? "Make sure the API is enabled (Administration → Site Settings → API)." : "Check the token's permissions."}`;
    }
    if (error.status === 404) {
      return `${service} was not found at this address. Check the URL.`;
    }
    if (error.notApi) {
      return `${service} answered with a web page instead of API data. Check the URL: it must be the address of ${service} itself.`;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export async function checkTestRail(profile: Profile): Promise<CheckResult> {
  const connection = profile.testrail.connection;
  if (!connection.endpoint || !connection.username || !connection.apiKey) {
    return { ok: false, message: "Enter the TestRail URL, user name and API key.", projects: [] };
  }
  try {
    const projects = await new TestRailClient(connection).getProjects();
    return {
      ok: true,
      message: `Connected. ${projects.length} project(s) available.`,
      projects: projects.map((p) => ({ id: p.id, name: p.name })),
    };
  } catch (error) {
    return { ok: false, message: explain(error, "TestRail"), projects: [] };
  }
}

/** ALM login; returns the projects the user can open, with their domains as keys. */
export async function checkAlm(profile: Profile): Promise<CheckResult> {
  const connection = profile.alm.connection;
  const credentials = connection.auth === "apiKey" ? connection.clientId && connection.secret : connection.username && connection.password;
  if (!connection.endpoint.trim() || !credentials) {
    return { ok: false, message: connection.auth === "apiKey" ? "Enter the ALM address, the client id and the secret." : "Enter the ALM address, the user name and the password.", projects: [] };
  }
  // Every step of the check, for the detailed log the user can copy and send.
  const lines: string[] = [];
  const started = Date.now();
  const trace = (message: string) => lines.push(`+${((Date.now() - started) / 1000).toFixed(2)}s ${message}`);
  const client = new AlmClient(connection, { trace });
  const details = () => (profile.alm.detailedLog ? lines.join("\n") : undefined);
  const failed = (message: string): CheckResult => ({ ok: false, message, projects: [], ...(details() ? { details: details() } : {}) });
  try {
    const domains = await client.domains();
    const projects = domains.flatMap((domain) => domain.projects.map((project) => ({ key: domain.name, name: project })));
    trace(`Domains and projects: ${domains.map((domain) => `${domain.name} (${domain.projects.length})`).join(", ") || "none"}.`);
    await client.logout();
    return {
      ok: true,
      message: `Connected to ALM. ${projects.length} project(s) in ${domains.length} domain(s) available.`,
      projects: projects.map((project, index) => ({ id: index + 1, ...project })),
      ...(details() ? { details: details() } : {}),
    };
  } catch (error) {
    await client.logout();
    if (error instanceof HttpError && error.status === 404) {
      return failed("ALM was not found at this address. Enter the address people open ALM at, e.g. https://alm.example.com/qcbin.");
    }
    if (error instanceof HttpError && error.status === 401 && connection.auth === "apiKey" && /oauth2/.test(error.url)) {
      return failed("ALM rejected the API key. Check the client id and secret; API keys need ALM 12.60 or later.");
    }
    return failed(explain(error, "ALM"));
  }
}

/** Qase API token; returns the projects it can see, with their codes as keys. */
export async function checkQase(profile: Profile): Promise<CheckResult> {
  const connection = profile.qase.connection;
  if (!connection.apiToken) {
    return { ok: false, message: "Enter the Qase API token.", projects: [] };
  }
  try {
    const projects = await new QaseClient(connection).projects();
    return {
      ok: true,
      message: `Connected to Qase. ${projects.length} project(s) available.`,
      projects: projects.map((p, index) => ({ id: index + 1, key: p.code, name: `${p.title} (${p.code})` })).sort((a, b) => a.name.localeCompare(b.name)),
    };
  } catch (error) {
    return { ok: false, message: explain(error, "Qase"), projects: [] };
  }
}

/** Xray API key and Jira account; returns the Jira projects the account can see. */
export async function checkXray(profile: Profile): Promise<CheckResult> {
  const connection = profile.xray.connection;
  if (!connection.jiraUrl || !connection.jiraEmail || !connection.jiraApiToken) {
    return { ok: false, message: "Enter the Jira site, the email and the API token.", projects: [] };
  }
  if (!connection.clientId || !connection.clientSecret) {
    return { ok: false, message: "Enter the Xray API key: client id and client secret.", projects: [] };
  }
  const jira = new JiraClient(connection);
  let user: string;
  let projects: { id: string; key: string; name: string }[];
  try {
    const me = await jira.myself();
    user = me.displayName ?? me.emailAddress ?? connection.jiraEmail;
    projects = await jira.projects();
  } catch (error) {
    return { ok: false, message: explain(error, "Jira"), projects: [] };
  }
  try {
    await new XrayClient(connection).authenticate();
  } catch (error) {
    const hint =
      error instanceof HttpError && (error.status === 401 || error.status === 400)
        ? "Xray rejected the API key. Check the client id and secret, and that the Xray region matches the Jira site."
        : explain(error, "Xray");
    return { ok: false, message: `Jira works (as ${user}), but ${hint}`, projects: [] };
  }
  return {
    ok: true,
    message: `Connected to Jira as ${user} and to Xray. ${projects.length} project(s) available.`,
    details: user,
    projects: projects
      .map((p) => ({ id: Number(p.id), key: p.key, name: `${p.name} (${p.key})` }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export async function checkTestOps(profile: Profile): Promise<CheckResult> {
  const connection = profile.testops.connection;
  if (!connection.endpoint || !connection.apiToken) {
    return { ok: false, message: "Enter the Allure TestOps URL and API token.", projects: [] };
  }
  const client = new TestOpsClient(connection);
  try {
    const projects = await client.projects();
    const me = await client.me().catch(() => null);
    return {
      ok: true,
      message: `Connected${me?.username ? ` as ${me.username}` : ""}. ${projects.length} project(s) available.`,
      details: me?.username,
      projects: projects.map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name)),
    };
  } catch (error) {
    return { ok: false, message: explain(error, "Allure TestOps"), projects: [] };
  }
}
