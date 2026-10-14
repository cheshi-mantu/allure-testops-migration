import { describe, expect, it } from "vitest";
import { exampleText, splitValue } from "./structure.js";

describe("splitValue", () => {
  it("splits by a character, by \\n per line, or not at all", () => {
    expect(splitValue("ABC-1, ABC-2", ",")).toEqual(["ABC-1", " ABC-2"]);
    expect(splitValue("https://a.example.com\r\nhttps://b.example.com\nhttps://c.example.com", "\\n")).toEqual(["https://a.example.com", "https://b.example.com", "https://c.example.com"]);
    expect(splitValue("one\ntwo", "")).toEqual(["one\ntwo"]);
  });
});

describe("exampleText", () => {
  it("shows line breaks inside a value as ↵", () => {
    expect(exampleText("https://a.example.com\nhttps://b.example.com")).toBe("https://a.example.com ↵ https://b.example.com");
    expect(exampleText("See ![shot](https://x.example.com/a.png)   now")).toBe("See [image: shot] now");
  });
});
