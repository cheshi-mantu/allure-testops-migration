import type { Profile, TestOpsDiscovery } from "@atm/shared";
import { TestOpsClient } from "./client.js";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function requireTestOpsProject(profile: Profile): number {
  const projectId = profile.testops.scope.projectId;
  if (!projectId) {
    throw new Error("Choose an Allure TestOps project first.");
  }
  return projectId;
}

/** Reference data of the target project the mapping screens offer as choices. */
export async function discoverTestOps(profile: Profile, client = new TestOpsClient(profile.testops.connection)): Promise<TestOpsDiscovery> {
  const projectId = requireTestOpsProject(profile);
  const warnings: string[] = [];
  const attempt = async <T>(what: string, load: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await load();
    } catch (error) {
      warnings.push(`Could not read ${what}: ${describeError(error)}`);
      return fallback;
    }
  };

  const project = await client.project(projectId);
  const [projectFields, globalFields, layers, statuses, integrations, trees] = await Promise.all([
    attempt("project custom fields", () => client.projectCustomFields(projectId), []),
    attempt("custom fields", () => client.suggestCustomFields(""), []),
    attempt("test layers", () => client.layers(), []),
    attempt("statuses", () => client.statuses(), []),
    attempt("issue tracker integrations", () => client.integrations(projectId), []),
    attempt("trees", () => client.trees(projectId), []),
  ]);
  const roles = await attempt("roles", () => client.roles(), []);
  let users: TestOpsDiscovery["users"] = null;
  try {
    users = (await client.accounts()).map((a) => ({
      username: a.username,
      email: a.email ?? undefined,
      name: [a.firstName, a.lastName].filter(Boolean).join(" ") || undefined,
    }));
  } catch {
    // Listing users needs admin rights; owners can still be typed in.
  }

  const inProject = new Set(projectFields.map((f) => f.id));
  const byId = new Map([...globalFields, ...projectFields].map((f) => [f.id, f]));
  return {
    project: { id: project.id, name: project.name },
    customFields: [...byId.values()]
      .map((f) => ({ id: f.id, name: f.name, inProject: inProject.has(f.id) }))
      .sort((a, b) => Number(b.inProject) - Number(a.inProject) || a.name.localeCompare(b.name)),
    layers: layers.map(({ id, name }) => ({ id, name })),
    statuses: statuses.map(({ id, name }) => ({ id, name })),
    integrations: integrations.map(({ id, name }) => ({ id, name })),
    roles: roles.map(({ id, name }) => ({ id, name })),
    users,
    trees: trees.map(({ id, name }) => ({ id, name })),
    warnings,
  };
}
