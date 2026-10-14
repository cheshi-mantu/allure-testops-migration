import { describe, expect, it } from "vitest";
import { parameterExampleCount, parameterExamples } from "../qase/catalog.js";
import { examplesSink, takeExamples } from "./examples.js";
import { textSteps } from "./steps.js";

const OUTLINE = 'Given I am on the sign-up page\nWhen I enter the password "<password>"\nThen I see "<message>"\n\nExamples:\n  | password | message |\n  | short | At least 8 characters |\n  | NoDigits!! | At least one digit |';
const MARKDOWN = { format: "markdown" } as const;

describe("Gherkin Examples", () => {
  it("takes the tables after Examples out of the text", () => {
    const { text, tables } = takeExamples(OUTLINE);
    expect(text).not.toContain("| short |");
    expect(text).toContain("Examples:");
    expect(tables).toEqual([{ header: ["password", "message"], rows: [["short", "At least 8 characters"], ["NoDigits!!", "At least one digit"]] }]);
  });

  it("attaches each table as a Markdown file of its Examples step", () => {
    const steps = textSteps(`${OUTLINE}\n\nExamples: long ones\n  | password | message |\n  | Valid#Pass1 | Strong password |`, "lines", MARKDOWN);
    expect(steps.map((s) => (s.type === "step" ? s.body : ""))).toEqual([
      "Given I am on the sign-up page",
      'When I enter the password "<password>"',
      'Then I see "<message>"',
      "Examples:",
      "Examples: long ones",
    ]);
    const files = steps.flatMap((s) => (s.type === "step" ? s.attachments : []));
    expect(files.map((f) => f.fileName)).toEqual(["examples.md", "examples-2.md"]);
    expect(files[0]!.content).toBe("| password | message |\n| --- | --- |\n| short | At least 8 characters |\n| NoDigits!! | At least one digit |\n");
  });

  it("makes every row an example of the case when asked, without the Examples step", () => {
    const sink = examplesSink("examples");
    const steps = textSteps(OUTLINE, "lines", MARKDOWN, sink);
    expect(steps).toHaveLength(3);
    expect(sink.examples).toEqual([
      [
        { name: "password", value: "short" },
        { name: "message", value: "At least 8 characters" },
      ],
      [
        { name: "password", value: "NoDigits!!" },
        { name: "message", value: "At least one digit" },
      ],
    ]);
  });

  it("keeps the table in one step when text stays a single step", () => {
    const [step] = textSteps(OUTLINE, "single", MARKDOWN);
    expect(step!.type === "step" && step.attachments.map((a) => a.fileName)).toEqual(["examples.md"]);
  });
});

describe("Qase parameters as examples", () => {
  const parameters = [
    { type: "single" as const, item: { title: "browser", values: ["chrome", "firefox"] } },
    { type: "group" as const, shared_id: "s-1", items: [{ title: "user", values: ["admin", "guest"] }, { title: "locale", values: ["en", "de"] }] },
  ];

  it("combines single parameters and keeps a group together", () => {
    expect(parameterExampleCount(parameters)).toBe(4);
    expect(parameterExamples(parameters)).toEqual([
      [{ name: "browser", value: "chrome" }, { name: "user", value: "admin" }, { name: "locale", value: "en" }],
      [{ name: "browser", value: "chrome" }, { name: "user", value: "guest" }, { name: "locale", value: "de" }],
      [{ name: "browser", value: "firefox" }, { name: "user", value: "admin" }, { name: "locale", value: "en" }],
      [{ name: "browser", value: "firefox" }, { name: "user", value: "guest" }, { name: "locale", value: "de" }],
    ]);
    expect(parameterExamples([])).toEqual([]);
  });
});
