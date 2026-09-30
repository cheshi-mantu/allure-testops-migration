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

describe("real world step layouts", () => {
  it("keeps a single numbered step with continuation lines as one step", () => {
    const options = { ...auto, expectedPattern: "(?i)expected( result)?:" };
    const steps = parseSteps("1. Quit the app\nRemove its folder\nRemove its settings\nExpected Result:\nThe app is uninstalled", options);
    expect(view(steps)).toEqual([{ body: "Quit the app\nRemove its folder\nRemove its settings", expected: "The app is uninstalled" }]);
  });

  it("splits steps written with markers on one line", () => {
    expect(view(parseSteps("Step: open the app Step: log in Step: check the page", auto))).toEqual([
      { body: "open the app" },
      { body: "log in" },
      { body: "check the page" },
    ]);
  });

  it("drops step numbering that Allure TestOps adds itself", () => {
    expect(view(parseSteps("Step 1: Open\n\tSubstep 1.1: Type login\nStep 2: Submit", auto))).toEqual([
      { body: "Open", steps: [{ body: "Type login" }] },
      { body: "Submit" },
    ]);
  });

  it("keeps numbered steps with bullet lists", () => {
    expect(view(parseSteps("1. Open the form\n2. Change fields:\n- Date\n- Amount\n3. Save", auto))).toEqual([
      { body: "Open the form" },
      { body: "Change fields:\n- Date\n- Amount" },
      { body: "Save" },
    ]);
  });
});

describe("expected results from a separate column", () => {
  it("matches numbered expected results by number, not position", () => {
    const steps = parseSteps("1. Click Add\n2. Fill fields\n3. Save", auto);
    attachExpected(steps, parseExpectedTexts("1. A row appears\n3. Saved", auto));
    expect(view(steps)).toEqual([{ body: "Click Add", expected: "A row appears" }, { body: "Fill fields" }, { body: "Save", expected: "Saved" }]);
  });

  it("keeps continuation lines of a numbered expected result", () => {
    const steps = parseSteps("1. Filter\n2. Check", auto);
    attachExpected(steps, parseExpectedTexts("2. Format accepted.\nRows shown", auto));
    expect(view(steps)).toEqual([{ body: "Filter" }, { body: "Check", expected: "Format accepted.\nRows shown" }]);
  });

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

  it("does not repeat expected results the steps column already holds", () => {
    const options = { ...auto, expectedPattern: "(?i)expected( result)?:" };
    const steps = parseSteps("1. Launch the installer\nExpected Result:\nLaunched\n2. Tap on Cancel\nExpected Result:\nClosed", options);
    attachExpected(steps, parseExpectedTexts("1. Launched\n2. Closed and  notified", options));
    expect(view(steps)).toEqual([
      { body: "Launch the installer", expected: "Launched" },
      { body: "Tap on Cancel", expected: "Closed\nClosed and  notified" },
    ]);
  });
});
