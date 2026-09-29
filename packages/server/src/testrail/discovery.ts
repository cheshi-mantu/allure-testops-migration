import type { Profile, SuiteStructure, TestRailDiscovery } from "@atm/shared";
import { TestRailClient } from "./client.js";
import { collectStats, FieldCatalog } from "./fields.js";
import { levelStats, mergeLevelStats, SectionTree } from "./sections.js";
import type { TrCase, TrProject, TrSuite } from "./types.js";

const SAMPLE_PER_SUITE = 250;
const SAMPLE_TOTAL = 1000;
const EXAMPLE_PATHS = 5;

export interface TestRailProjectContext {
  client: TestRailClient;
  project: TrProject;
  /** Suites selected for migration. */
  suites: TrSuite[];
  sections: Map<number, SectionTree>;
  catalog: FieldCatalog;
  warnings: string[];
}

function requireProject(profile: Profile): number {
  const projectId = profile.testrail.scope.projectId;
  if (!projectId) {
    throw new Error("Choose a TestRail project first.");
  }
  return projectId;
}

async function optional<T>(load: () => Promise<T>, fallback: T, warnings: string[], what: string): Promise<T> {
  try {
    return await load();
  } catch (error) {
    warnings.push(`Could not read ${what}: ${error instanceof Error ? error.message : String(error)}`);
    return fallback;
  }
}

/** Loads project level reference data once; used by discovery, preview and migration runs. */
export async function loadTestRailContext(profile: Profile, client = new TestRailClient(profile.testrail.connection)): Promise<TestRailProjectContext> {
  const projectId = requireProject(profile);
  const warnings: string[] = [];
  const project = await client.getProject(projectId);
  const allSuites = await client.getSuites(projectId);
  const selected = profile.testrail.scope.suiteIds;
  const suites = selected.length > 0 ? allSuites.filter((suite) => selected.includes(suite.id)) : allSuites;
  if (selected.length > 0 && suites.length < selected.length) {
    warnings.push("Some selected suites no longer exist in TestRail.");
  }

  const [caseFields, priorities, caseTypes, caseStatuses, users, milestones, templates] = await Promise.all([
    client.getCaseFields(),
    optional(() => client.getPriorities(), [], warnings, "priorities"),
    optional(() => client.getCaseTypes(), [], warnings, "case types"),
    client.getCaseStatuses(),
    optional(() => client.getUsers(projectId), [], warnings, "users"),
    optional(() => client.getMilestones(projectId), [], warnings, "milestones"),
    optional(() => client.getTemplates(projectId), [], warnings, "templates"),
  ]);
  const catalog = new FieldCatalog({ projectId, caseFields, priorities, caseTypes, caseStatuses, users, milestones, templates });

  const sections = new Map<number, SectionTree>();
  for (const suite of suites) {
    sections.set(suite.id, new SectionTree(await client.getSections(projectId, suite.id)));
  }
  return { client, project, suites, sections, catalog, warnings };
}

/** Everything the mapping screens show about the TestRail side, including sample based statistics. */
export async function discoverTestRail(profile: Profile): Promise<TestRailDiscovery> {
  const context = await loadTestRailContext(profile);
  const { client, project, suites, sections, catalog, warnings } = context;

  const samples: TrCase[] = [];
  const structure: SuiteStructure[] = [];
  for (const suite of suites) {
    const budget = Math.min(SAMPLE_PER_SUITE, SAMPLE_TOTAL - samples.length);
    const suiteCases = budget > 0 ? await client.getCasesSample(project.id, suite.id, budget) : [];
    samples.push(...suiteCases);
    const tree = sections.get(suite.id)!;
    const levels = levelStats(tree, suiteCases.map((c) => c.section_id));
    const leaves = tree.sections.filter((section) => !tree.sections.some((other) => other.parent_id === section.id));
    const deepestFirst = [...leaves].sort((a, b) => tree.depthOf(b) - tree.depthOf(a));
    structure.push({
      suite: { id: suite.id, name: suite.name },
      sectionCount: tree.sections.length,
      maxDepth: tree.maxDepth,
      levels,
      examplePaths: deepestFirst.slice(0, EXAMPLE_PATHS).map((leaf) => tree.path(leaf.id).map((s) => s.name)),
    });
  }

  const maxDepth = structure.reduce((max, s) => Math.max(max, s.maxDepth), 0);
  return {
    project: { id: project.id, name: project.name, suiteMode: project.suite_mode },
    suites: suites.map((s) => ({ id: s.id, name: s.name })),
    structure,
    maxDepth,
    levels: mergeLevelStats(structure.map((s) => s.levels)),
    fields: catalog.toInfo(collectStats(catalog, samples)),
    sampledCases: samples.length,
    sampleCaseIds: samples.slice(0, 50).map((c) => ({ id: c.id, name: c.title })),
    warnings,
  };
}
