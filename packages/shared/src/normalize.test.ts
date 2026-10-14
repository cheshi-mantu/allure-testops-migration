import { describe, expect, it } from "vitest";
import type { PlannedCase } from "./api.js";
import { normalizePlanned } from "./normalize.js";

describe("normalizePlanned", () => {
  it("trims every value, drops empty ones and writes tags, layer and status in lower case", () => {
    const planned: PlannedCase = {
      sourceId: " C1 ",
      sourceUrl: null,
      name: "  Log in ",
      description: "\n Text \n",
      precondition: " ",
      expectedResult: "",
      tags: [" Smoke", "smoke ", "XRAY:CALC-12", " "],
      customFields: { " Browser ": [" Chrome", "Chrome ", " "], Browser: ["Firefox"], Empty: ["  "] },
      layer: " E2E ",
      status: " Draft",
      owner: " jane ",
      members: [{ name: " sam ", role: " Reviewer " }, { name: "sam", role: "Reviewer" }, { name: " ", role: "Lead" }],
      links: [{ name: " ", url: " https://a.example.com " }, { name: "x", url: " " }],
      issues: [{ key: " ABC-1 ", integrationId: 1 }, { key: " ", integrationId: 1 }],
      testKeys: [{ key: " CALC-12 ", integrationId: 2 }],
      examples: [[{ name: " browser ", value: " chrome " }]],
      comments: [" Note ", " "],
      attachments: [{ sourceId: "1", fileName: " a.png " }],
      scenario: [{ type: "step", body: " Open ", attachments: [], data: " ", dataAttachments: [], expected: " Shown ", expectedAttachments: [], steps: [{ type: "step", body: " Nested ", attachments: [], data: null, dataAttachments: [], expected: null, expectedAttachments: [] }] }],
      notes: [],
    };
    const result = normalizePlanned(planned);
    expect(result).toMatchObject({
      sourceId: "C1",
      name: "Log in",
      description: "Text",
      precondition: "",
      tags: ["smoke", "xray:calc-12"],
      customFields: { Browser: ["Chrome", "Firefox"] },
      layer: "e2e",
      status: "draft",
      owner: "jane",
      members: [{ name: "sam", role: "Reviewer" }],
      links: [{ name: "https://a.example.com", url: "https://a.example.com" }],
      issues: [{ key: "ABC-1", integrationId: 1 }],
      testKeys: [{ key: "CALC-12", integrationId: 2 }],
      examples: [[{ name: "browser", value: "chrome" }]],
      comments: ["Note"],
      attachments: [{ sourceId: "1", fileName: "a.png" }],
    });
    expect(result.scenario[0]).toMatchObject({ body: "Open", data: null, expected: "Shown", steps: [{ body: "Nested" }] });
    expect(normalizePlanned({ ...planned, layer: "  ", status: null }).layer).toBeNull();
  });
});
