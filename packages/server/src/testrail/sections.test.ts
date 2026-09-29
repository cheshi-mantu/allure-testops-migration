import { describe, expect, it } from "vitest";
import { StructureMappingSchema } from "@atm/shared";
import { levelStats, mapSectionPath, SectionTree } from "./sections.js";
import type { TrSection } from "./types.js";

const section = (id: number, name: string, parent: number | null): TrSection => ({ id, name, parent_id: parent, suite_id: 1, depth: 0 });

const tree = new SectionTree([
  section(1, "Web", null),
  section(2, "Auth", 1),
  section(3, "Login", 2),
  section(4, "Errors", 3),
  section(5, "Mobile", null),
]);

describe("SectionTree", () => {
  it("builds the path from the top level down", () => {
    expect(tree.path(4).map((s) => s.name)).toEqual(["Web", "Auth", "Login", "Errors"]);
    expect(tree.maxDepth).toBe(4);
  });

  it("survives cyclic parents", () => {
    const broken = new SectionTree([section(1, "A", 2), section(2, "B", 1)]);
    expect(broken.path(1).map((s) => s.name)).toEqual(["B", "A"]);
  });

  it("collects per level statistics", () => {
    const stats = levelStats(tree, [3, 3, 4, 5]);
    expect(stats.map((l) => [l.level, l.sectionCount, l.caseCount])).toEqual([
      [1, 2, 1],
      [2, 1, 0],
      [3, 1, 2],
      [4, 1, 1],
    ]);
    expect(stats[0]!.examples).toEqual(["Web", "Mobile"]);
  });
});

describe("mapSectionPath", () => {
  const path = ["Web", "Auth", "Login", "Errors"];

  it("maps each level to its own field", () => {
    const structure = StructureMappingSchema.parse({ levels: ["Platform", "Feature", "Story", "Area"] });
    expect(Object.fromEntries(mapSectionPath(path, structure))).toEqual({
      Platform: ["Web"],
      Feature: ["Auth"],
      Story: ["Login"],
      Area: ["Errors"],
    });
  });

  it("joins deeper levels into the last mapped level", () => {
    const structure = StructureMappingSchema.parse({ levels: ["Platform", "Feature"], deeperLevels: "join" });
    expect(Object.fromEntries(mapSectionPath(path, structure))).toEqual({
      Platform: ["Web"],
      Feature: ["Auth / Login / Errors"],
    });
  });

  it("drops deeper levels when asked", () => {
    const structure = StructureMappingSchema.parse({ levels: ["Platform", "Feature"], deeperLevels: "drop" });
    expect(Object.fromEntries(mapSectionPath(path, structure))).toEqual({ Platform: ["Web"], Feature: ["Auth"] });
  });

  it("skips levels without a field", () => {
    const structure = StructureMappingSchema.parse({ levels: [null, "Feature"], deeperLevels: "drop" });
    expect(Object.fromEntries(mapSectionPath(path, structure))).toEqual({ Feature: ["Auth"] });
  });

  it("handles paths shorter than the mapping", () => {
    const structure = StructureMappingSchema.parse({ levels: ["Platform", "Feature", "Story"] });
    expect(Object.fromEntries(mapSectionPath(["Mobile"], structure))).toEqual({ Platform: ["Mobile"] });
  });
});
