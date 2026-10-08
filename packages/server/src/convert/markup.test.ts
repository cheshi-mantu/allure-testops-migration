import { describe, expect, it } from "vitest";
import {
  convertStepText,
  convertTestRailTables,
  convertText,
  looksLikeHtml,
  referencedCaseIds,
  resolveAttachmentImages,
  resolveCaseLinks,
  splitTextSteps,
  tableToCsv,
} from "./markup.js";

describe("convertTestRailTables", () => {
  it("turns a TestRail table with header into a Markdown table", () => {
    const input = "Before\n|||:Name|:Value\n|| a | 1\n|| b | 2\nAfter";
    expect(convertTestRailTables(input)).toBe("Before\n| Name | Value |\n| --- | --- |\n| a | 1 |\n| b | 2 |\nAfter");
  });

  it("gives a headless table an empty header", () => {
    expect(convertTestRailTables("|| x | y")).toBe("|  |  |\n| --- | --- |\n| x | y |");
  });
});

describe("convertText", () => {
  it("rewrites inline attachments and remembers their ids", () => {
    const result = convertText("See ![](index.php?/attachments/get/42) and ![shot](https://tr.example/index.php?/attachments/get/abc-1#_t=5)", {
      format: "markdown",
    });
    expect(result.text).toBe("See ![](testrail-attachment:42) and ![shot](testrail-attachment:abc-1)");
    expect(result.attachmentIds).toEqual(["42", "abc-1"]);
  });

  it("detects and converts HTML from the new TestRail editor", () => {
    const html = '<p>Open <strong>login</strong> page</p><p><img src="index.php?/attachments/get/7" data-attachment-id="7"></p>';
    const result = convertText(html, { format: "auto" });
    expect(result.text).toBe("Open **login** page\n\n![](testrail-attachment:7)");
    expect(result.attachmentIds).toEqual(["7"]);
  });

  it("converts HTML tables to Markdown tables", () => {
    const html = "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>";
    expect(convertText(html, { format: "html" }).text).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |");
  });

  it("keeps Markdown untouched when it is not HTML", () => {
    expect(looksLikeHtml("a < b and c > d")).toBe(false);
    expect(convertText("**bold** text", { format: "auto" }).text).toBe("**bold** text");
  });

  it("keeps attachment ids of already converted text", () => {
    expect(convertText("![](testrail-attachment:9)", { format: "markdown" }).attachmentIds).toEqual(["9"]);
  });
});

describe("resolveAttachmentImages", () => {
  it("points images to uploaded attachments and marks missing ones", () => {
    const text = "![](testrail-attachment:1) ![](testrail-attachment:2)";
    const resolved = resolveAttachmentImages(text, (id) => (id === "1" ? "/api/rs/testcase/attachment/100/content" : null));
    expect(resolved).toBe("![](/api/rs/testcase/attachment/100/content) [Attachment 2 was not migrated]");
  });
});

describe("case links", () => {
  it("finds and resolves links to other cases on any host", () => {
    const text = "Like [login](https://tr.example/index.php?/cases/view/12) and http://alias.example/index.php?/cases/view/13";
    expect(referencedCaseIds(text)).toEqual([12, 13]);
    const resolved = resolveCaseLinks(text, (id) => (id === 12 ? "https://testops.example/project/1/test-cases/500" : null));
    expect(resolved).toBe("Like [login](https://testops.example/project/1/test-cases/500) and http://alias.example/index.php?/cases/view/13");
  });
});

describe("step text", () => {
  it("moves tables and images out of the body", () => {
    const result = convertStepText("Fill the form\n|||:Field|:Value\n|| name | John\n![](index.php?/attachments/get/5)", { format: "markdown" });
    expect(result.body).toBe("Fill the form");
    expect(result.attachmentIds).toEqual(["5"]);
    expect(result.tables).toEqual([{ header: ["Field", "Value"], rows: [["name", "John"]] }]);
  });

  it("writes CSV with quoting", () => {
    expect(tableToCsv({ header: ["a", "b"], rows: [["x,y", 'say "hi"']] })).toBe('a,b\n"x,y","say ""hi"""\n');
  });

  it("splits text steps into lines without list markers", () => {
    expect(splitTextSteps("1. Open\n2) Click\n\n- Check")).toEqual(["Open", "Click", "Check"]);
  });
});
