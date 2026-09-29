import type {
  ConnectionCheck,
  NamedId,
  PlannedCase,
  Profile,
  ProfileListItem,
  RunLogEntry,
  RunSummary,
  TestOpsDiscovery,
  TestRailDiscovery,
} from "@atm/shared";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;
  if (!response.ok) {
    const message = (data as { message?: string } | undefined)?.message ?? `Request failed with ${response.status}`;
    throw new ApiError(message, response.status);
  }
  return data as T;
}

export interface CheckResult extends ConnectionCheck {
  projects: NamedId[];
}

export const api = {
  profiles: () => request<ProfileListItem[]>("GET", "/api/profiles"),
  createProfile: (name: string) => request<Profile>("POST", "/api/profiles", { name }),
  profile: (id: string) => request<Profile>("GET", `/api/profiles/${id}`),
  saveProfile: (profile: Profile) => request<Profile>("PUT", `/api/profiles/${profile.id}`, profile),
  deleteProfile: (id: string) => request<void>("DELETE", `/api/profiles/${id}`),
  duplicateProfile: (id: string) => request<Profile>("POST", `/api/profiles/${id}/duplicate`),
  importProfile: (profile: unknown, name?: string) => request<Profile>("POST", "/api/profiles/import", { profile, name }),
  exportUrl: (id: string, includeSecrets: boolean) => `/api/profiles/${id}/export?includeSecrets=${includeSecrets}`,

  checkTestRail: (id: string) => request<CheckResult>("POST", `/api/profiles/${id}/testrail/check`),
  checkTestOps: (id: string) => request<CheckResult>("POST", `/api/profiles/${id}/testops/check`),
  testRailSuites: (id: string) => request<{ suiteMode: number; suites: NamedId[] }>("GET", `/api/profiles/${id}/testrail/suites`),
  discoverTestRail: (id: string) => request<TestRailDiscovery>("POST", `/api/profiles/${id}/testrail/discover`),
  discoverTestOps: (id: string) => request<TestOpsDiscovery>("POST", `/api/profiles/${id}/testops/discover`),
  customFieldValues: (id: string, name: string) =>
    request<string[]>("GET", `/api/profiles/${id}/testops/cf-values?name=${encodeURIComponent(name)}`),
  preview: (id: string, caseId: number) => request<PlannedCase & { linkedCaseIds: number[] }>("POST", `/api/profiles/${id}/preview`, { caseId }),

  runs: (id: string) => request<RunSummary[]>("GET", `/api/profiles/${id}/runs`),
  startRun: (id: string, dryRun: boolean) => request<RunSummary>("POST", `/api/profiles/${id}/runs`, { dryRun }),
  cancelRun: (id: string) => request<{ cancelled: boolean }>("POST", `/api/profiles/${id}/runs/cancel`),
  runLog: (id: string, runId: string) => request<RunLogEntry[]>("GET", `/api/profiles/${id}/runs/${runId}/log`),
  runEventsUrl: (id: string, runId: string) => `/api/profiles/${id}/runs/${runId}/events`,
};

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
