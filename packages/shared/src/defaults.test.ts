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

  it("knows TestRail fields by their old and their TestRail 9 names", () => {
    const text = (systemName: string): SourceFieldInfo => ({ systemName, label: "Preconditions", kind: "text", system: false, options: null, filledCount: 2, examples: [] });
    expect(suggestTarget(text("custom_preconds"))).toEqual({ kind: "precondition", heading: "" });
    expect(suggestTarget(text("custom_case_preconds"))).toEqual({ kind: "precondition", heading: "" });
    expect(suggestTarget({ ...text("custom_case_steps_separated"), kind: "steps" })).toEqual({ kind: "scenario" });
  });
});
