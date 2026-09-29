import type { ConnectionCheck, NamedId, Profile } from "@atm/shared";
import { HttpError } from "../http/httpClient.js";
import { TestOpsClient } from "../testops/client.js";
import { TestRailClient } from "../testrail/client.js";

export interface CheckResult extends ConnectionCheck {
  projects: NamedId[];
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
