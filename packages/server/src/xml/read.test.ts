import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readXml } from "./read.js";

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../../test/fixtures/${name}`, import.meta.url)));

describe("readXml on a TestRail export", () => {
  const doc = readXml(fixture("testrail-export.xml"));
  const byId = (id: string) => doc.records.find((record) => record.values.get("id")?.[0] === id)!;

  it("finds the case element and the step list on its own", () => {
    expect(doc.root).toBe("suite");
    expect(doc.caseElement).toBe("case");
    expect(doc.records).toHaveLength(5);
    expect(doc.stepLists).toEqual([{ field: "custom/steps_separated", action: "content", expected: "expected", data: "additional_info" }]);
  });

  it("reads the nested sections as the path, without the suite", () => {
    expect(byId("C10").path).toEqual(["Web shop"]);
    expect(byId("C11").path).toEqual(["Web shop", "Auth", "Password"]);
    expect(byId("C13").path).toEqual(["API"]);
  });

  it("unwraps id and value pairs, lists of values and lists of records", () => {
    const record = byId("C11");
    expect(record.values.get("custom/browser")).toEqual(["Chrome"]);
    expect(record.values.get("custom/platforms")).toEqual(["Web", "iOS"]);
    expect(record.values.get("attachments/name")).toEqual(["screenshot.png", "test-data.csv"]);
    expect(record.values.get("attachments/url")).toHaveLength(2);
    expect(record.values.get("references")).toEqual(["REQ-1, REQ-7"]);
    expect(record.values.has("estimate")).toBe(false);
  });

  it("keeps steps without an expected result and the data of a step", () => {
    expect(byId("C10").steps.get("custom/steps_separated")).toEqual([
      { action: "Open the home page", expected: "", data: "" },
      { action: "Log in as a customer", expected: "", data: "" },
    ]);
    const steps = byId("C11").steps.get("custom/steps_separated")!;
    expect(steps).toHaveLength(3);
    expect(steps[0]).toEqual({ action: "<p>Open the login page</p>", expected: "", data: "<p>URL: `/login`</p>" });
    expect(steps[2]!.data).toMatch(/^\|\|\|:Field\|:Value/);
  });

  it("reads nested content such as a BDD scenario and line numbers", () => {
    expect(byId("C12").values.get("custom/testrail_bdd_scenario/scenario/content")![0]).toMatch(/^Scenario: Password rules\nGiven/);
    expect(byId("C10").line).toBe(11);
  });
});

describe("readXml on a TestLink export", () => {
  const doc = readXml(fixture("testlink-export.xml"));

  it("finds test cases named by an attribute inside nested suites", () => {
    expect(doc.caseElement).toBe("testcase");
    expect(doc.records.map((record) => record.values.get("@name")![0])).toEqual(["Valid login", "Wrong password"]);
    expect(doc.records.map((record) => record.path)).toEqual([["Login"], ["Login", "Errors"]]);
  });

  it("turns name and value pairs into fields and named items into values", () => {
    const [first, second] = doc.records;
    expect(first!.values.get("custom_fields/Browser")).toEqual(["Chrome"]);
    expect(first!.values.get("custom_fields/Team")).toEqual(["Identity"]);
    expect(second!.values.get("custom_fields/Browser")).toEqual(["Firefox"]);
    expect(first!.values.get("keywords/@name")).toEqual(["smoke", "login"]);
    expect(first!.values.get("requirements/doc_id")).toEqual(["REQ-1", "REQ-2"]);
  });

  it("reads steps with their own element names", () => {
    expect(doc.stepLists).toEqual([{ field: "steps", action: "actions", expected: "expectedresults", data: null }]);
    expect(doc.records[0]!.steps.get("steps")).toEqual([
      { action: "<p>Open the login page</p>", expected: "<p>The form is shown</p>", data: "" },
      { action: "<p>Enter the credentials and submit</p>", expected: "<p>The dashboard opens</p>", data: "" },
    ]);
  });
});

describe("readXml on other files", () => {
  it("takes the element the user chose", () => {
    const doc = readXml(Buffer.from("<root><thing><name>A</name><size>1</size></thing><thing><name>B</name><size>2</size></thing></root>"), { caseElement: "thing" });
    expect(doc.caseElement).toBe("thing");
    expect(doc.records.map((record) => record.values.get("name")![0])).toEqual(["A", "B"]);
  });

  it("says when nothing looks like a test case and when the file is broken", () => {
    expect(readXml(Buffer.from("<root><a>1</a></root>")).warnings[0]).toMatch(/looks like a test case/);
    expect(() => readXml(Buffer.from("<root><a></root>"))).toThrow(/not well-formed XML/);
  });
});
