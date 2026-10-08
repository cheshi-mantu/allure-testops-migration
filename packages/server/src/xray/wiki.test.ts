import { describe, expect, it } from "vitest";
import { wikiToMarkdown, wikiToStepText } from "./wiki.js";

describe("wikiToMarkdown", () => {
  it("converts emphasis, monospace, links and line breaks", () => {
    expect(wikiToMarkdown("Press *Save* and _wait_, see {{config.yml}} and [docs|https://example.com/docs]\\\\next line")).toBe(
      "Press **Save** and *wait*, see `config.yml` and [docs](https://example.com/docs)\nnext line",
    );
  });

  it("keeps snake_case, paths and arithmetic intact", () => {
    expect(wikiToMarkdown("Set user_name to 2 * 3 * 4 in ~/Library/app_data")).toBe("Set user_name to 2 * 3 * 4 in ~/Library/app_data");
  });

  it("converts headings, nested lists and tables", () => {
    expect(wikiToMarkdown("h2. Setup\n* one\n** nested\n# first\n||User||Role||\n|jane|admin|")).toBe(
      "## Setup\n- one\n  - nested\n1. first\n| User | Role |\n| --- | --- |\n| jane | admin |",
    );
  });

  it("keeps code blocks verbatim", () => {
    expect(wikiToMarkdown("Run:\n{code:bash}\nnpm run *build*\n{code}")).toBe("Run:\n```bash\nnpm run *build*\n```");
  });

  it("lets the caller decide what images become", () => {
    expect(wikiToMarkdown("See !shot.png|thumbnail! here")).toBe("See  here");
    expect(wikiToMarkdown("See !shot.png!", (name) => `[image: ${name}]`)).toBe("See [image: shot.png]");
  });

  it("gives plain step text without Markdown markers", () => {
    expect(wikiToStepText("Open the *login* page, type {{admin}} and see [docs|https://example.com]")).toBe("Open the login page, type admin and see docs (https://example.com)");
  });
});
