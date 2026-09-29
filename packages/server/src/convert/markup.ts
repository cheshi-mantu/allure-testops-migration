import TurndownService from "turndown";

/**
 * Text conversion from TestRail to Allure TestOps.
 *
 * TestRail stores text either in its own Markdown flavour (with `|||` tables) or, with the newer
 * editor, as HTML. Allure TestOps text fields are Markdown, scenario step bodies are plain text.
 *
 * Inline images are rewritten to `![name](testrail-attachment:<id>)` so the writer can upload them
 * and point the image at the uploaded Allure TestOps attachment.
 */

export const ATTACHMENT_SCHEME = "testrail-attachment:";

const HTML_HINT = /<(p|br|div|span|img|table|ul|ol|li|strong|em|b|i|u|h[1-6]|pre|code|a)\b[^>]*>/i;

export function looksLikeHtml(text: string): boolean {
  return HTML_HINT.test(text);
}

/** The few DOM members used here; turndown parses HTML with its own DOM implementation on Node. */
interface DomNode {
  textContent: string | null;
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): ArrayLike<DomNode>;
}

let turndown: TurndownService | null = null;

function htmlConverter(): TurndownService {
  if (turndown) {
    return turndown;
  }
  const service = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "*" });
  service.addRule("table", {
    filter: "table",
    replacement: (_content, node) => `\n\n${htmlTableToMarkdown(node as unknown as DomNode)}\n\n`,
  });
  service.addRule("keepImageSource", {
    filter: "img",
    replacement: (_content, node) => {
      const element = node as unknown as DomNode;
      const src = element.getAttribute("src") ?? "";
      const alt = element.getAttribute("alt") ?? "";
      return src ? `![${alt}](${src})` : "";
    },
  });
  turndown = service;
  return service;
}

function cellText(cell: DomNode): string {
  return (cell.textContent ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}

function htmlTableToMarkdown(table: DomNode): string {
  const rows = Array.from(table.querySelectorAll("tr")).map((row) => Array.from(row.querySelectorAll("th,td")).map(cellText));
  if (rows.length === 0) {
    return "";
  }
  return markdownTable(rows[0]!, rows.slice(1));
}

export function markdownTable(header: string[], rows: string[][]): string {
  const width = Math.max(header.length, ...rows.map((row) => row.length));
  const pad = (row: string[]) => Array.from({ length: width }, (_, i) => row[i] ?? "");
  const line = (row: string[]) => `| ${pad(row).join(" | ")} |`;
  return [line(header), `|${" --- |".repeat(width)}`, ...rows.map(line)].join("\n");
}

export function htmlToMarkdown(html: string): string {
  return htmlConverter()
    .turndown(html)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------- TestRail tables

/** A block of lines starting with `||`; the first may start with `|||` which marks a header. */
const TESTRAIL_TABLE = /(?:^|\n)((?:[ \t]*\|\|.*(?:\n|$))+)/g;

export interface Table {
  header: string[] | null;
  rows: string[][];
}

function splitCells(line: string): string[] {
  return line.split("|").map((cell) => cell.trim());
}

export function parseTestRailTable(block: string): Table {
  const lines = block.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("||"));
  let header: string[] | null = null;
  const rows: string[][] = [];
  lines.forEach((line, index) => {
    if (index === 0 && line.startsWith("|||")) {
      header = splitCells(line.slice(3)).map((cell) => cell.replace(/^:|:$/g, "").trim());
    } else {
      rows.push(splitCells(line.slice(2)));
    }
  });
  return { header, rows };
}

function tableToMarkdown(table: Table): string {
  const width = Math.max(table.header?.length ?? 0, ...table.rows.map((r) => r.length));
  const header = table.header ?? Array.from({ length: width }, () => "");
  return markdownTable(header, table.rows);
}

/** Replaces TestRail `|||` tables with Markdown tables. */
export function convertTestRailTables(text: string): string {
  return text.replace(TESTRAIL_TABLE, (match, block: string) => {
    const prefix = match.startsWith("\n") ? "\n" : "";
    const trailing = block.endsWith("\n") ? "\n" : "";
    return `${prefix}${tableToMarkdown(parseTestRailTable(block))}${trailing}`;
  });
}

// ---------------------------------------------------------------- attachments and links

/** `index.php?/attachments/get/<id>`, optionally absolute and with a `#_t=...` cache buster. */
const ATTACHMENT_URL = /(?:https?:\/\/[^\s)"']*?\/)?index\.php\?\/attachments\/get\/([A-Za-z0-9-]+)[^\s)"']*/;
const PLANNED_IMAGE = new RegExp(`!\\[[^\\]]*\\]\\(${ATTACHMENT_SCHEME}([A-Za-z0-9-]+)\\)`, "g");
const MARKDOWN_IMAGE = new RegExp(`!\\[([^\\]]*)\\]\\(\\s*${ATTACHMENT_URL.source}\\s*\\)`, "g");

export interface ConvertedText {
  text: string;
  /** TestRail attachment ids referenced inline, in order of appearance. */
  attachmentIds: string[];
}

export interface TextOptions {
  format: "auto" | "markdown" | "html";
}

/** TestRail text to Allure TestOps Markdown. */
export function convertText(raw: string, options: TextOptions): ConvertedText {
  let text = raw.replace(/\r\n/g, "\n");
  if (options.format === "html" || (options.format === "auto" && looksLikeHtml(text))) {
    text = htmlToMarkdown(text);
  }
  text = convertTestRailTables(text);
  text = text.replace(MARKDOWN_IMAGE, (_match, alt: string, id: string) => `![${alt}](${ATTACHMENT_SCHEME}${id})`);
  // Collect ids after rewriting, so text that was converted before keeps its references too.
  const attachmentIds = [...new Set([...text.matchAll(PLANNED_IMAGE)].map((match) => match[1]!))];
  return { text: text.trim(), attachmentIds };
}

/** Points planned image references at uploaded attachments; unknown ones are dropped with their id kept as text. */
export function resolveAttachmentImages(text: string, urlFor: (sourceId: string) => string | null): string {
  return text.replace(PLANNED_IMAGE, (match, id: string) => {
    const url = urlFor(id);
    return url ? match.replace(`${ATTACHMENT_SCHEME}${id}`, url) : `[TestRail attachment ${id} was not migrated]`;
  });
}

/**
 * Links to other TestRail cases: `.../index.php?/cases/view/123`. Any host is accepted because
 * teams often link through another address of the same TestRail (http/https, alias domains).
 */
const CASE_LINK = /(?:https?:\/\/[^\s)"'<>]*?\/)?index\.php\?\/cases\/view\/(\d+)/g;

export function referencedCaseIds(text: string): number[] {
  return [...new Set([...text.matchAll(CASE_LINK)].map((match) => Number(match[1])))];
}

export function resolveCaseLinks(text: string, urlFor: (caseId: number) => string | null): string {
  return text.replace(CASE_LINK, (match, id: string) => urlFor(Number(id)) ?? match);
}

// ---------------------------------------------------------------- plain text for step bodies

export interface StepText {
  body: string;
  attachmentIds: string[];
  /** Tables found in the text, moved out as CSV files because step bodies do not render Markdown. */
  tables: Table[];
}

const MARKDOWN_TABLE = /(?:^|\n)((?:[ \t]*\|.*\|[ \t]*(?:\n|$))+)/g;

function parseMarkdownTable(block: string): Table {
  const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
  const cells = (line: string) => line.replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
  const isSeparator = (line: string) => /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/.test(line);
  if (lines.length >= 2 && isSeparator(lines[1]!)) {
    return { header: cells(lines[0]!), rows: lines.slice(2).map(cells) };
  }
  return { header: null, rows: lines.filter((l) => !isSeparator(l)).map(cells) };
}

/** Converts TestRail text to a plain step body plus the attachments and tables it contained. */
export function convertStepText(raw: string, options: TextOptions): StepText {
  const converted = convertText(raw, options);
  const tables: Table[] = [];
  let body = converted.text.replace(MARKDOWN_TABLE, (match, block: string) => {
    tables.push(parseMarkdownTable(block));
    return match.startsWith("\n") ? "\n" : "";
  });
  body = body
    .replace(PLANNED_IMAGE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { body, attachmentIds: converted.attachmentIds, tables };
}

export function tableToCsv(table: Table): string {
  const escape = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const rows = table.header ? [table.header, ...table.rows] : table.rows;
  return `${rows.map((row) => row.map(escape).join(",")).join("\n")}\n`;
}

/** Splits a plain text steps field into steps: one per line, list markers removed. */
export function splitTextSteps(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*(?:\d+[.)]|[-*•])\s+/, "").trim())
    .filter((line) => line !== "");
}
