/**
 * CSV reading without surprises: encoding and delimiter detection, RFC 4180 quoting with
 * line breaks inside cells, and unique column names.
 */

export interface DecodedText {
  text: string;
  encoding: string;
  warning?: string;
}

/** Decodes file content. `auto` honours a BOM, then tries strict UTF-8, then falls back to Windows-1252. */
export function decode(data: Buffer, encoding: string): DecodedText {
  if (encoding !== "auto") {
    return { text: stripBom(new TextDecoder(encoding).decode(data)), encoding };
  }
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    return { text: new TextDecoder("utf-8").decode(data.subarray(3)), encoding: "utf-8" };
  }
  if (data[0] === 0xff && data[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(data.subarray(2)), encoding: "utf-16le" };
  }
  if (data[0] === 0xfe && data[1] === 0xff) {
    return { text: new TextDecoder("utf-16be").decode(data.subarray(2)), encoding: "utf-16be" };
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(data), encoding: "utf-8" };
  } catch {
    return {
      text: new TextDecoder("windows-1252").decode(data),
      encoding: "windows-1252",
      warning: "The file is not valid UTF-8; it was read as Windows-1252. Choose the encoding if characters look wrong.",
    };
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Splits CSV text into records. Quoted cells may contain delimiters, doubled quotes and line breaks. */
export function parseCsv(text: string, delimiter: string, quote = '"', maxRecords = Infinity): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;
  let i = 0;
  const pushCell = () => {
    record.push(cell);
    cell = "";
  };
  const pushRecord = () => {
    pushCell();
    records.push(record);
    record = [];
  };
  while (i < text.length && records.length < maxRecords) {
    const char = text[i]!;
    if (quoted) {
      if (char === quote) {
        if (text[i + 1] === quote) {
          cell += quote;
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      cell += char;
      i += 1;
      continue;
    }
    if (char === quote && cell.trim() === "") {
      // Opening quote; whitespace before it is ignored, as spreadsheet tools do.
      cell = "";
      quoted = true;
      i += 1;
      continue;
    }
    if (text.startsWith(delimiter, i)) {
      pushCell();
      i += delimiter.length;
      continue;
    }
    if (char === "\r" || char === "\n") {
      pushRecord();
      i += char === "\r" && text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    cell += char;
    i += 1;
  }
  if (records.length < maxRecords && (cell !== "" || record.length > 0)) {
    pushRecord();
  }
  // Blank lines are not records.
  return records.filter((r) => r.length > 1 || (r[0] ?? "").trim() !== "");
}

const DELIMITERS = [",", ";", "\t", "|"];

/** Picks the delimiter that splits the first records into the same number of columns most consistently. */
export function detectDelimiter(text: string, quote = '"'): string {
  let best = ",";
  let bestScore = -1;
  for (const delimiter of DELIMITERS) {
    const records = parseCsv(text, delimiter, quote, 30);
    if (records.length === 0) {
      continue;
    }
    const widths = records.map((r) => r.length);
    const header = widths[0]!;
    if (header < 2) {
      continue;
    }
    const consistent = widths.filter((w) => w === header).length / widths.length;
    const score = consistent * 100 + Math.min(header, 50);
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }
  return best;
}

/** Column names from the header row: blanks get a name, duplicates a number. */
export function uniqueHeaders(header: string[]): string[] {
  const seen = new Map<string, number>();
  return header.map((raw, index) => {
    const base = raw.trim() || `Column ${index + 1}`;
    const count = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), count);
    return count === 1 ? base : `${base} (${count})`;
  });
}

export interface CsvTable {
  columns: string[];
  /** Data rows as column -> value. */
  rows: Record<string, string>[];
  /** 1-based line number of the record in the file, for messages. */
  lines: number[];
  delimiter: string;
  encoding: string;
  warnings: string[];
}

export interface ReadOptions {
  delimiter: string;
  quote: string;
  encoding: string;
}

export function readTable(data: Buffer, options: ReadOptions): CsvTable {
  const decoded = decode(data, options.encoding);
  const delimiter = options.delimiter === "auto" ? detectDelimiter(decoded.text, options.quote) : unescapeDelimiter(options.delimiter);
  const records = parseCsv(decoded.text, delimiter, options.quote);
  const warnings = decoded.warning ? [decoded.warning] : [];
  if (records.length === 0) {
    return { columns: [], rows: [], lines: [], delimiter, encoding: decoded.encoding, warnings: [...warnings, "The file is empty."] };
  }
  const columns = uniqueHeaders(records[0]!);
  const rows: Record<string, string>[] = [];
  const lines: number[] = [];
  let tooWide = 0;
  records.slice(1).forEach((record, index) => {
    if (record.length > columns.length && record.slice(columns.length).some((v) => v.trim() !== "")) {
      tooWide += 1;
    }
    rows.push(Object.fromEntries(columns.map((column, i) => [column, record[i] ?? ""])));
    lines.push(index + 2);
  });
  if (tooWide > 0) {
    warnings.push(`${tooWide} row(s) have more values than the header has columns; the extra values are ignored. Check the delimiter.`);
  }
  return { columns, rows, lines, delimiter, encoding: decoded.encoding, warnings };
}

/** Lets users type `\t` for a tab. */
export function unescapeDelimiter(value: string): string {
  return value === "\\t" || value.toLowerCase() === "tab" ? "\t" : value;
}

export function describeDelimiter(value: string): string {
  return value === "\t" ? "tab" : value === " " ? "space" : `"${value}"`;
}
