import { describe, expect, it } from "vitest";
import { newProfile } from "./defaults.js";
import { runContext, runContextChanges } from "./runs.js";

describe("runContextChanges", () => {
  const profile = () => {
    const p = newProfile("p1", "CSV", new Date(), "csv");
    p.csv.fileId = "file-a";
    p.testops.scope.projectId = 7;
    p.options.migrationTagPrefix = "csv-a";
    return p;
  };

  it("finds nothing for the same settings or an old run without a context", () => {
    const p = profile();
    expect(runContextChanges(runContext(p, "a.csv"), p)).toEqual([]);
    expect(runContextChanges(undefined, p)).toEqual([]);
  });

  it("names every setting that changed since the run", () => {
    const before = runContext(profile(), "a.csv");
    const p = profile();
    p.csv.fileId = "file-b";
    p.testops.scope.projectId = 8;
    p.options.migrationTagPrefix = "csv-b";
    expect(runContextChanges(before, p)).toEqual(["source", "project", "tagPrefix"]);
  });
});
