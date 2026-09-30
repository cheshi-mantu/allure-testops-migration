import type { RunContext } from "./api.js";
import type { Profile } from "./profile.js";

/** Identifies what a run of this profile reads, see `RunContext.source`. */
export function runSource(profile: Profile): string {
  return profile.source === "csv"
    ? `csv:${profile.csv.fileId ?? ""}`
    : `testrail:${profile.testrail.connection.endpoint.replace(/\/+$/, "")}#${profile.testrail.scope.projectId ?? ""}`;
}

export function runContext(profile: Profile, sourceLabel: string): RunContext {
  return {
    source: runSource(profile),
    sourceLabel,
    testopsProjectId: profile.testops.scope.projectId,
    tagPrefix: profile.options.migrationTagPrefix,
  };
}

export type RunContextChange = "source" | "project" | "tagPrefix";

/** What the profile uses differently from the run; empty for runs without a context. */
export function runContextChanges(context: RunContext | undefined, profile: Profile): RunContextChange[] {
  if (!context) {
    return [];
  }
  const changes: RunContextChange[] = [];
  if (context.source !== runSource(profile)) {
    changes.push("source");
  }
  if (context.testopsProjectId !== profile.testops.scope.projectId) {
    changes.push("project");
  }
  if (context.tagPrefix !== profile.options.migrationTagPrefix) {
    changes.push("tagPrefix");
  }
  return changes;
}
