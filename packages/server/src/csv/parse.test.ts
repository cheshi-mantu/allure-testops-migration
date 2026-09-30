import { describe, expect, it } from "vitest";
import { decode, detectDelimiter, parseCsv, readTable, uniqueHeaders } from "./parse.js";

describe("decode", () => {
  it("honours a UTF-8 BOM and falls back to Windows-1252 for invalid UTF-8", () => {
    expect(decode(Buffer.from([0xef, 0xbb, 0xbf, 0x61]), "auto")).toEqual({ text: "a", encoding: "utf-8" });
    const latin = decode(Buffer.from([0x63, 0x61, 0x66, 0xe9]), "auto");
    expect(latin.text).toBe("café");
    expect(latin.encoding).toBe("windows-1252");
    expect(latin.warning).toBeDefined();
  });

  it("reads UTF-16 with a BOM", () => {
    expect(decode(Buffer.from([0xff, 0xfe, 0x61, 0x00, 0x62, 0x00]), "auto").text).toBe("ab");
  });
});

describe("parseCsv", () => {
  it("handles quotes, doubled quotes and line breaks inside cells", () => {
    const text = 'id,name,steps\r\n1,"Login, basic","Open\n\t""Login"" page"\n2,Plain,Step\n\n';
    expect(parseCsv(text, ",")).toEqual([
      ["id", "name", "steps"],
      ["1", "Login, basic", 'Open\n\t"Login" page'],
      ["2", "Plain", "Step"],
    ]);
  });

  it("keeps empty cells", () => {
    expect(parseCsv("a;b;c\n1;;3", ";")).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
    ]);
  });
});

describe("detectDelimiter", () => {
  it("picks the delimiter that splits rows consistently", () => {
    expect(detectDelimiter('id;name;tags\n1;"A, B";x,y\n2;C;z')).toBe(";");
    expect(detectDelimiter("id\tname\n1\tA, B")).toBe("\t");
    expect(detectDelimiter("id,name,desc\n1,A,text; more")).toBe(",");
  });
});

describe("headers", () => {
  it("names blank columns and numbers duplicates", () => {
    expect(uniqueHeaders(["Name", "", "name", "Tags"])).toEqual(["Name", "Column 2", "name (2)", "Tags"]);
  });

  it("reads a table and warns about extra values", () => {
    const table = readTable(Buffer.from("a,b\n1,2,3\n4,5"), { delimiter: "auto", quote: '"', encoding: "auto" });
    expect(table.columns).toEqual(["a", "b"]);
    expect(table.rows).toEqual([
      { a: "1", b: "2" },
      { a: "4", b: "5" },
    ]);
    expect(table.lines).toEqual([2, 3]);
    expect(table.warnings[0]).toMatch(/more values/);
  });
});
