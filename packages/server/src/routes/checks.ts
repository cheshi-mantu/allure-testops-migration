import type { ConnectionCheck, NamedId, Profile } from "@atm/shared";
import { HttpError } from "../http/httpClient.js";
import { TestOpsClient } from "../testops/client.js";
import { TestRailClient } from "../testrail/client.js";
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
