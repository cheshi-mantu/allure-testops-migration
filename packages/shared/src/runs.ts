import type { RunContext } from "./api.js";
import type { Profile } from "./profile.js";

/** Identifies what a run of this profile reads, see `RunContext.source`. */
export function runSource(profile: Profile): string {
  switch (profile.source) {
    case "csv":
      return `csv:${profile.csv.fileId ?? ""}`;
    case "xml":
      return `xml:${profile.xml.fileId ?? ""}#${profile.xml.caseElement ?? ""}`;
    case "testops":
      return `testops:${profile.testopsSource.connection.endpoint.replace(/\/+$/, "")}#${profile.testopsSource.projects.map((p) => p.sourceId).join(",")}`;
    case "qase":
      return `qase:${profile.qase.connection.endpoint.replace(/\/+$/, "")}#${profile.qase.scope.projectCode}`;
    case "alm":
      return `alm:${profile.alm.connection.endpoint.replace(/\/+$/, "")}#${profile.alm.scope.domain}#${profile.alm.scope.project}`;
    case "squad":
      return `squad:${profile.squad.connection.jiraUrl.replace(/\/+$/, "")}#${profile.squad.scope.projectKey}#${profile.squad.scope.issueType}#${profile.squad.scope.jql.trim()}`;
    case "zephyr":
      return `zephyr:${profile.zephyr.connection.jiraUrl.replace(/\/+$/, "")}#${profile.zephyr.scope.projectKey}`;
    case "xray":
      return `xray:${profile.xray.connection.jiraUrl.replace(/\/+$/, "")}#${profile.xray.scope.projectKey}#${profile.xray.scope.jql.trim()}`;
    default:
      return `testrail:${profile.testrail.connection.endpoint.replace(/\/+$/, "")}#${profile.testrail.scope.projectId ?? ""}`;
  }
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
