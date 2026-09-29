import type { SectionLevelInfo } from "@atm/shared";
import type { TrSection } from "./types.js";

export { mapSectionPath } from "@atm/shared";

/** Sections of one suite with parent lookups. */
export class SectionTree {
  private readonly byId: Map<number, TrSection>;

  constructor(readonly sections: TrSection[]) {
    this.byId = new Map(sections.map((section) => [section.id, section]));
  }

  get(id: number): TrSection | undefined {
    return this.byId.get(id);
  }

  /** Sections from the top level down to the given one. Stops safely on broken parent links. */
  path(sectionId: number): TrSection[] {
    const path: TrSection[] = [];
    const seen = new Set<number>();
    let current = this.byId.get(sectionId);
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      path.unshift(current);
      current = current.parent_id === null ? undefined : this.byId.get(current.parent_id);
    }
    return path;
  }

  /** Nesting depth (1-based), computed from parents rather than trusting the `depth` property. */
  depthOf(section: TrSection): number {
    return this.path(section.id).length;
  }

  get maxDepth(): number {
    return this.sections.reduce((max, section) => Math.max(max, this.depthOf(section)), 0);
  }
}

const LEVEL_EXAMPLES = 5;

export function levelStats(tree: SectionTree, caseSectionIds: number[]): SectionLevelInfo[] {
  const levels: SectionLevelInfo[] = [];
  const ensure = (level: number) => {
    while (levels.length < level) {
      levels.push({ level: levels.length + 1, sectionCount: 0, caseCount: 0, examples: [] });
    }
    return levels[level - 1]!;
  };
  for (const section of tree.sections) {
    const info = ensure(tree.depthOf(section));
    info.sectionCount += 1;
    if (info.examples.length < LEVEL_EXAMPLES && !info.examples.includes(section.name)) {
      info.examples.push(section.name);
    }
  }
  for (const sectionId of caseSectionIds) {
    const depth = tree.path(sectionId).length;
    if (depth > 0) {
      ensure(depth).caseCount += 1;
    }
  }
  return levels;
}

/** Combines statistics of several suites level by level. */
export function mergeLevelStats(all: SectionLevelInfo[][]): SectionLevelInfo[] {
  const merged: SectionLevelInfo[] = [];
  for (const levels of all) {
    for (const info of levels) {
      const target = merged[info.level - 1] ?? { level: info.level, sectionCount: 0, caseCount: 0, examples: [] };
      merged[info.level - 1] = target;
      target.sectionCount += info.sectionCount;
      target.caseCount += info.caseCount;
      for (const example of info.examples) {
        if (target.examples.length < LEVEL_EXAMPLES && !target.examples.includes(example)) {
          target.examples.push(example);
        }
      }
    }
  }
  return merged.filter(Boolean);
}
