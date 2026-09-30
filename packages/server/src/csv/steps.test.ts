import { describe, expect, it } from "vitest";
import type { PlannedStep } from "@atm/shared";
import { attachExpected, detectStepFormat, parseExpectedTexts, parseSteps, type StepParseOptions } from "./steps.js";

const auto: StepParseOptions = { format: "auto", stepPattern: "", expectedPattern: "" };

/** Compact view: body, expected and nested steps. */
function view(steps: PlannedStep[]): unknown[] {
  return steps.map((s) =>
    s.type === "step"
      ? { body: s.body, ...(s.expected ? { expected: s.expected } : {}), ...(s.steps ? { steps: view(s.steps) } : {}) }
      : { shared: s.name },
  );
}

describe("parseSteps", () => {
  it("nests the classic tab indented layout", () => {
    const text = "Open something\n\tCheck it is opened\n\t\tCheck well\n\t\tCheck again\nDo some stuff\n\tFirst";
    expect(detectStepFormat(text)).toBe("indented");
    expect(view(parseSteps(text, auto))).toEqual([
      { body: "Open something", steps: [{ body: "Check it is opened", steps: [{ body: "Check well" }, { body: "Check again" }] }] },
      { body: "Do some stuff", steps: [{ body: "First" }] },
    ]);
  });

  it("nests space indented steps", () => {
    expect(view(parseSteps("A\n  a1\n    a11\nB", auto))).toEqual([{ body: "A", steps: [{ body: "a1", steps: [{ body: "a11" }] }] }, { body: "B" }]);
  });

  it("reads the Allure TestOps export syntax", () => {
    const text = "[step 1] Open page\n\t[expected.step 1.1] Page is open\n[step 2] Log in\n\t[step 2.1] Enter name\n\t\t[expected.step 2.1.1] Name accepted\n[shared 3] Common login";
    expect(detectStepFormat(text)).toBe("testops");
    expect(view(parseSteps(text, auto))).toEqual([
      { body: "Open page", expected: "Page is open" },
      { body: "Log in", steps: [{ body: "Enter name", expected: "Name accepted" }] },
      { body: "Shared step: Common login" },
    ]);
  });

  it("keeps continuation lines of numbered steps", () => {
    expect(view(parseSteps("1. Open\nthe page\n2) Click", auto))).toEqual([{ body: "Open\nthe page" }, { body: "Click" }]);
  });

  it("splits by a pattern and understands Java style flags", () => {
    const options = { ...auto, format: "regex" as const, stepPattern: "(?i)step\\s*\\d*:\\s*" };
    expect(view(parseSteps("STEP 1: describe one Step 2: describe two", options))).toEqual([{ body: "describe one" }, { body: "describe two" }]);
  });

  it("moves expected results out of sub-steps and lines", () => {
    const options = { ...auto, expectedPattern: "(?i)expected( result)?:?" };
    expect(view(parseSteps("Open\n\tExpected result: it opens\nClick\n\tExpected\n\t\tclicked", options))).toEqual([
      { body: "Open", expected: "it opens" },
      { body: "Click", expected: "clicked" },
    ]);
    expect(view(parseSteps("Open the app Expected: the app opens", { ...options, format: "single" }))).toEqual([{ body: "Open the app", expected: "the app opens" }]);
  });

  it("uses one step for single format", () => {
    expect(view(parseSteps("a\nb", { ...auto, format: "single" }))).toEqual([{ body: "a\nb" }]);
  });
});

describe("expected results from a separate column", () => {
  it("lines up expected results with steps", () => {
    const steps = parseSteps("1. Open\n2. Click\n3. Check", auto);
    attachExpected(steps, parseExpectedTexts("1. Opened\n2. Clicked", auto));
    expect(view(steps)).toEqual([{ body: "Open", expected: "Opened" }, { body: "Click", expected: "Clicked" }, { body: "Check" }]);
  });

  it("gives a single expected result to the last step", () => {
    const steps = parseSteps("Open\nClick", auto);
    attachExpected(steps, ["All good"]);
    expect(view(steps)).toEqual([{ body: "Open" }, { body: "Click", expected: "All good" }]);
  });
});
