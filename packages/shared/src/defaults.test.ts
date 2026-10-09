import { describe, expect, it } from "vitest";
import type { SourceFieldInfo } from "./api.js";
import { suggestTarget } from "./defaults.js";

const field = (filledCount: number): SourceFieldInfo => ({
  systemName: "xray:testSets",
  label: "Test sets",
  kind: "multiselect",
  system: true,
  options: [],
  filledCount,
  examples: [],
  suggestedTarget: { kind: "customField", name: "Test set" },
});

describe("suggestTarget", () => {
  it("does not migrate a field that is empty in every sampled record", () => {
    expect(suggestTarget(field(0))).toEqual({ kind: "ignore" });
  });

  it("keeps the suggestion for a field with values", () => {
    expect(suggestTarget(field(3))).toEqual({ kind: "customField", name: "Test set" });
  });
});
