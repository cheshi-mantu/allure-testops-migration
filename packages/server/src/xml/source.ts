import { mergeSuggestedMappings, type ConnectionCheck, type PlannedAttachment, type PlannedCase, type PlannedNote, type PlannedStep, type Profile, type SourceDiscovery, type SourceFieldInfo, type XmlFilePreview } from "@atm/shared";
import { ATTACHMENT_SCHEME, looksLikeHtml } from "../convert/markup.js";
import { examplesSink, stepsWithExamples } from "../convert/examples.js";
import { note } from "../convert/notes.js";
import { buildStep } from "../convert/steps.js";
import { columnFor, groupCases, type CsvCase } from "../csv/cases.js";
import { columnInfo, levelsOf } from "../csv/discovery.js";
import type { CsvTable } from "../csv/parse.js";
import { parseSteps } from "../csv/steps.js";
import { suggestColumns, type Suggestion } from "../csv/suggest.js";
import { transformCsvCase } from "../csv/transform.js";
import { CaseSkipped } from "../engine/errors.js";
import { KnownProblem } from "../engine/problems.js";
import type { RetryInfo } from "../http/httpClient.js";
import type { FileStore } from "../storage/fileStore.js";
import { otherHosts, XmlFiles } from "./files.js";
import { readXml, type XmlDocument, type XmlRecord } from "./read.js";

/**
 * The XML source on top of the reader: every case becomes rows of a table (one row per value of
 * its fields), so column suggestions, value tables, text conversion and the mapping to Allure
 * TestOps are the ones the CSV source uses. Step lists and the section path come from the XML
 * structure itself.
 */

/** Internal columns: the section path and the record number. */
const PATH_COLUMN = "\u0001path";
const INDEX_COLUMN = "\u0001index";
const PATH_SEPARATOR = "\u0000";

export interface LoadedXml {
  fileName: string;
  doc: XmlDocument;
  /** Files the XML refers to, downloaded from the source system when the profile says so. */
  xmlFiles: XmlFiles;
}

export async function loadXml(profile: Profile, files: FileStore, onRetry?: (info: RetryInfo) => void): Promise<LoadedXml> {
  const missing = (title: string) =>
    new KnownProblem({ key: "no-file", title, hint: "Upload the XML file or choose one from the library on the XML file step.", fix: { step: "file" } });
  if (!profile.xml.fileId) {
    throw missing("No XML file is chosen.");
  }
  if (!(await files.get(profile.xml.fileId))) {
    throw missing("The XML file of this profile is not in the file library any more, for example after importing the profile on another machine.");
  }
  const { info, data } = await files.read(profile.xml.fileId);
  let doc: XmlDocument;
  try {
    doc = readXml(data, { caseElement: profile.xml.caseElement });
  } catch (error) {
    throw new KnownProblem({
      key: "xml-not-readable",
      title: `"${info.name}" cannot be read as XML.`,
      hint: `${error instanceof Error ? error.message : String(error)} Export the file again, or check that it is the XML export and not, for example, an Excel file.`,
      fix: { step: "file" },
    });
  }
  const xmlFiles = new XmlFiles(profile.xml.files, onRetry);
  doc.records.forEach((record) => linkImages(record, xmlFiles, profile.options.textFormat));
  return { fileName: info.name, doc, xmlFiles };
}

/** URLs listed in a record with the name next to them, e.g. attachments with `name` and `url`. */
function namedUrls(record: XmlRecord): { url: string; name: string | null }[] {
  const urls: { url: string; name: string | null }[] = [];
  for (const [field, values] of record.values) {
    if (/(^|\/)(url|href|link)$/i.test(field)) {
      const names = record.values.get(field.replace(/[^/]+$/, "name")) ?? [];
      values.forEach((url, index) => /^https?:\/\//i.test(url) && urls.push({ url, name: names.length === values.length ? names[index]! : null }));
    }
  }
  return urls;
}

const IMAGE = /!\[([^\]]*)\]\(\s*([^)\s]+)[^)]*\)|<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Images in text refer to files the export does not contain. An image served by the source system
 * is planned as an attachment that keeps its place in the text, when files are downloaded.
 * Otherwise an image whose address is listed among the record's URLs (e.g. its attachments)
 * becomes a link with the file name, so the text stays readable.
 */
function linkImages(record: XmlRecord, xmlFiles: XmlFiles, format: Profile["options"]["textFormat"]): void {
  const urls = namedUrls(record);
  const rewrite = (text: string) => {
    // What replaces an image is written in the language of the text around it.
    const html = format === "html" || (format === "auto" && looksLikeHtml(text.replace(/<img\b[^>]*>/gi, "")));
    return text.replace(IMAGE, (_match, alt: string | undefined, markdownSource: string | undefined, htmlSource: string | undefined) => {
      const source = (markdownSource ?? htmlSource)!;
      const label = alt?.trim() ?? "";
      const known = urls.find((candidate) => candidate.url === source || (!/^https?:\/\//i.test(source) && candidate.url.endsWith(source)));
      const address = known?.url ?? source;
      const file = xmlFiles.resolve(address);
      if (file) {
        const key = xmlFiles.register(file, known?.name ?? null);
        return html ? `<img src="${ATTACHMENT_SCHEME}${key}" alt="${escapeHtml(label)}">` : `![${label}](${ATTACHMENT_SCHEME}${key})`;
      }
      if (!/^https?:\/\//i.test(address)) {
        return `[image: ${label || source}]`;
      }
      const name = known?.name ?? (label || "image");
      return html ? `<a href="${escapeHtml(address)}">${escapeHtml(name)}</a>` : `[${name}](${address})`;
    });
  };
  const has = (text: string) => text.includes("![") || /<img\b/i.test(text);
  for (const [field, values] of record.values) {
    if (values.some(has)) {
      record.values.set(field, values.map(rewrite));
    }
  }
  for (const steps of record.steps.values()) {
    for (const step of steps) {
      step.action = has(step.action) ? rewrite(step.action) : step.action;
      step.expected = has(step.expected) ? rewrite(step.expected) : step.expected;
      step.data = has(step.data) ? rewrite(step.data) : step.data;
    }
  }
}

/** Rows of one record: row N holds the Nth value of every field. */
function rowsOf(record: XmlRecord, index: number): Record<string, string>[] {
  const height = Math.max(1, ...[...record.values.values()].map((values) => values.length));
  return Array.from({ length: height }, (_unused, row) => {
    const cells: Record<string, string> = row === 0 ? { [INDEX_COLUMN]: String(index), [PATH_COLUMN]: record.path.join(PATH_SEPARATOR) } : {};
    for (const [field, values] of record.values) {
      if (values[row] !== undefined) {
        cells[field] = values[row]!;
      }
    }
    return cells;
  });
}

/** A readable name for a field path: `custom/atm_dropdown` -> "Atm dropdown", `attachments/name` -> "Attachments name". */
export function prettyName(field: string): string {
  const parts = field.replace(/@/g, "").split("/").filter(Boolean);
  const generic = /^(name|value|url|id|content|text|item|index|title)$/i;
  let last = parts.pop() ?? field;
  while (generic.test(last) && parts.length > 0) {
    const parent = parts.pop()!;
    last = /^(content|text|value|item)$/i.test(last) ? parent : `${parent} ${last}`;
  }
  const words = last.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Technical values with no meaning in Allure TestOps, unless the user maps them. */
const TECHNICAL = /(^|\/)@?((\w+_)?id|\w*internalid|index|(\w+_)?order|is_converted|step_number)$/i;

/**
 * Exports that store well-known values as numbers. Matched by the root and case elements; only
 * the first translation of the values, which the user can change like any other.
 */
const KNOWN_CODES: { root: string; caseElement: string; fields: Record<string, { values: Record<string, string>; status?: boolean }> }[] = [
  {
    // TestLink.
    root: "testsuite",
    caseElement: "testcase",
    fields: {
      execution_type: { values: { "1": "Manual", "2": "Automated" } },
      importance: { values: { "1": "Low", "2": "Medium", "3": "High" } },
      status: { values: { "1": "Draft", "2": "Review", "5": "Outdated", "7": "Active" }, status: true },
    },
  },
];

/** Fields with their statistics and suggested targets, as the mapping step shows them. */
export function analyseFields(profile: Profile, doc: XmlDocument): { fieldsInfo: SourceFieldInfo[]; effective: Profile } {
  // The same suggestions as for CSV columns, with the field path read as a header.
  // "keywords/@name" is the list of keywords: the name of the list says what the values are.
  const header = (field: string) => (field.includes("/") ? field.replace(/\/@?(name|value|title)$/i, "") : field).replace(/[/@]+/g, " ").trim();
  const headers = new Map<string, string>();
  for (const field of doc.fields) {
    let name = header(field) || field;
    while ([...headers.values()].includes(name)) {
      name += " ";
    }
    headers.set(field, name);
  }
  const rows = doc.records.flatMap((record, index) =>
    rowsOf(record, index).map((row) => Object.fromEntries(doc.fields.filter((field) => row[field] !== undefined).map((field) => [headers.get(field)!, row[field]!]))),
  );
  const table: CsvTable = { columns: doc.fields.map((field) => headers.get(field)!), rows, lines: rows.map((_row, index) => index + 1), delimiter: "", encoding: "", warnings: [] };
  const suggestions = suggestColumns(table);
  const idField = doc.fields.find((field) => suggestions.get(headers.get(field)!)?.target.kind === "sourceId");
  // One name: a title or name beats a summary, which then reads as the description.
  const named = doc.fields.filter((field) => suggestions.get(headers.get(field)!)?.target.kind === "name");
  const nameRank = (field: string) => ["title", "name", "summary"].findIndex((word) => field.toLowerCase().replace(/^@/, "") === word);
  const nameField = [...named].sort((a, b) => (nameRank(a) < 0 ? 9 : nameRank(a)) - (nameRank(b) < 0 ? 9 : nameRank(b)))[0];
  const codes = KNOWN_CODES.find((known) => known.root === doc.root && known.caseElement === doc.caseElement)?.fields ?? {};

  const fieldsInfo: SourceFieldInfo[] = doc.fields.map((field) => {
    const samples = doc.records.flatMap((record) => record.values.get(field) ?? []);
    let suggestion: Suggestion = suggestions.get(headers.get(field)!) ?? { target: { kind: "ignore" } };
    const last = field.split("/").pop()!.toLowerCase();
    const known = field.includes("/") ? undefined : codes[field];
    if (named.includes(field) && field !== nameField) {
      suggestion = { target: { kind: "description", heading: "" } };
    } else if (["description", "customField"].includes(suggestion.target.kind) && /(^|[\/_])(steps?|scenario|gherkin)([\/_]|$)/i.test(field) && samples.some((v) => v.includes("\n") || v.length > 40)) {
      // Cases of one file may keep their steps in different fields (step list, text, BDD scenario): each is a scenario.
      suggestion = { target: { kind: "scenario" } };
    } else if (suggestion.target.kind === "scenarioExpected") {
      // Steps carry their own expected results; a field next to them is the result of the whole case.
      suggestion = { target: { kind: "expectedResult", heading: "" } };
    } else if (known) {
      suggestion = { target: known.status ? { kind: "status" } : { kind: "customField", name: prettyName(field) } };
    } else if (field !== idField && TECHNICAL.test(field) && suggestion.target.kind === "customField") {
      suggestion = { target: { kind: "ignore" } };
    } else if (suggestion.target.kind === "link" && /attach|file/i.test(field) && doc.fields.includes(field.replace(/[^/]+$/, "name"))) {
      // Addresses of listed files: attached when files are downloaded, links otherwise.
      suggestion = { target: { kind: "attachment" } };
    } else if (last === "name" && doc.fields.includes(field.replace(/[^/]+$/, "url"))) {
      // The names of listed files become the names of their links.
      suggestion = { target: { kind: "ignore" } };
    } else if (suggestion.target.kind === "customField" && ["mission", "goals", "objective", "summary", "notes"].includes(last) && samples.some((v) => v.length > 40 || v.includes("\n"))) {
      suggestion = { target: { kind: "description", heading: prettyName(field) } };
    } else if (suggestion.target.kind === "customField") {
      suggestion = { ...suggestion, target: { kind: "customField", name: prettyName(field) } };
    } else if ((suggestion.target.kind === "description" || suggestion.target.kind === "precondition" || suggestion.target.kind === "expectedResult") && suggestion.target.heading) {
      suggestion = { ...suggestion, target: { ...suggestion.target, heading: prettyName(field) } };
    }
    // Several values of one case are separate values already: nothing to split.
    const info = columnInfo(field, samples, { target: suggestion.target });
    // The path of the element stays visible as the system name; the label is what a person would call the field.
    return { ...info, label: prettyName(field), filledCount: doc.records.filter((record) => record.values.has(field)).length, ...(known ? { suggestedValues: known.values } : {}) };
  });
  for (const list of doc.stepLists) {
    const cases = doc.records.filter((record) => record.steps.has(list.field));
    const counts = cases.map((record) => record.steps.get(list.field)!.length);
    fieldsInfo.push({
      systemName: list.field,
      label: prettyName(list.field),
      kind: "steps",
      system: false,
      options: null,
      filledCount: cases.length,
      examples: counts.length > 0 ? [`${Math.min(...counts)} to ${Math.max(...counts)} step(s)`, ...(cases[0] ? [cases[0].steps.get(list.field)![0]!.action.replace(/\s+/g, " ").slice(0, 160)] : [])].filter(Boolean) : [],
      suggestedTarget: { kind: "scenario" },
    });
  }
  return { fieldsInfo, effective: { ...profile, fields: mergeSuggestedMappings(profile.fields, fieldsInfo, null) } };
}

export interface XmlCase extends CsvCase {
  record: XmlRecord;
}

/** Cases with their key (the id field, or a hash of the name), in file order. */
export function xmlCases(doc: XmlDocument, profile: Profile): { cases: XmlCase[]; warnings: string[] } {
  const firstRows = doc.records.map((record, index) => rowsOf(record, index)[0]!);
  const table: CsvTable = { columns: doc.fields, rows: firstRows, lines: doc.records.map((record) => record.line), delimiter: "", encoding: "", warnings: [] };
  const grouped = groupCases(table, { ...profile, csv: { ...profile.csv, rows: "single" } });
  const cases = grouped.cases.map((testCase) => {
    const index = Number(testCase.rows[0]![INDEX_COLUMN]);
    return { ...testCase, rows: rowsOf(doc.records[index]!, index), record: doc.records[index]! };
  });
  return { cases, warnings: grouped.warnings.map((warning) => warning.replace(/\bcolumn\b/g, "field")) };
}

export async function previewXml(profile: Profile, files: FileStore): Promise<XmlFilePreview> {
  const { doc } = await loadXml(profile, files);
  const { effective } = analyseFields(profile, doc);
  const { cases, warnings } = xmlCases(doc, effective);
  return {
    caseElement: doc.caseElement,
    candidates: doc.candidates.slice(0, 12),
    caseCount: cases.length,
    stepLists: doc.stepLists.map((list) => ({ ...list, cases: doc.records.filter((record) => record.steps.has(list.field)).length })),
    depth: Math.max(0, ...doc.records.map((record) => record.path.length)),
    fieldCount: doc.fields.length + doc.stepLists.length,
    sample: cases.slice(0, 8).map((testCase) => ({
      line: testCase.line,
      id: testCase.key,
      name: testCase.name,
      path: testCase.record.path,
      steps: Math.max(0, ...[...testCase.record.steps.values()].map((steps) => steps.length)),
    })),
    warnings: [...doc.warnings, ...warnings],
  };
}

export async function discoverXml(profile: Profile, files: FileStore): Promise<SourceDiscovery> {
  const { doc, fileName } = await loadXml(profile, files);
  const { fieldsInfo, effective } = analyseFields(profile, doc);
  const { cases, warnings } = xmlCases(doc, effective);
  const paths = doc.records.map((record) => record.path);
  const levels = levelsOf(paths);
  const distinctPaths = [...new Map(paths.filter((path) => path.length > 0).map((path) => [path.join(PATH_SEPARATOR), path])).values()].sort((a, b) => b.length - a.length);
  return {
    source: "xml",
    project: { id: 0, name: fileName, suiteMode: 1 },
    suites: [],
    structure: [
      {
        suite: { id: 0, name: fileName },
        sectionCount: levels.reduce((sum, level) => sum + level.sectionCount, 0),
        maxDepth: levels.length,
        levels,
        examplePaths: distinctPaths.slice(0, 5),
      },
    ],
    maxDepth: levels.length,
    levels,
    fields: fieldsInfo,
    sampledCases: cases.length,
    sampleCaseIds: cases.slice(0, 100).map((testCase) => ({ id: testCase.key, name: testCase.name || `Line ${testCase.line}` })),
    warnings: [...doc.warnings, ...warnings],
  };
}

/**
 * Turns a case of the file into the Allure TestOps case the migration will write. Fields go through
 * the CSV transform; the scenario comes from the step list or, when a case has none, from a text
 * field mapped to the scenario.
 */
export function transformXmlCase(testCase: XmlCase, profile: Profile, doc: XmlDocument, xmlFiles: XmlFiles): { planned: PlannedCase; linkedCaseIds: string[] } {
  const scenarioMappings = profile.fields.filter((mapping) => mapping.target.kind === "scenario");
  const fileMappings = profile.fields.filter((mapping) => mapping.target.kind === "attachment");
  const fields = profile.fields.map((mapping) =>
    ["scenario", "scenarioExpected", "attachment"].includes(mapping.target.kind) ? { ...mapping, target: { kind: "ignore" as const } } : mapping,
  );
  const tabular: Profile = { ...profile, fields, csv: { ...profile.csv, pathColumn: PATH_COLUMN, steps: profile.xml.steps } };
  // The transform speaks of columns; an XML file has fields.
  const fieldWord = (text: string) => text.replace(/\bcolumn\b/g, "field");
  const reword = (entry: PlannedNote): PlannedNote => ({ ...entry, text: fieldWord(entry.text), ...(entry.summary ? { summary: fieldWord(entry.summary) } : {}), ...(entry.hint ? { hint: fieldWord(entry.hint) } : {}) });
  let result: ReturnType<typeof transformCsvCase>;
  try {
    result = transformCsvCase(testCase, { profile: tabular, pathSeparator: PATH_SEPARATOR, multiRow: true });
  } catch (error) {
    throw error instanceof CaseSkipped ? new CaseSkipped(error.message, reword(error.note)) : error;
  }
  const planned = result.planned;
  planned.notes = planned.notes.map(reword);
  const notes: PlannedNote[] = planned.notes;
  // A link to a listed file is named after the file, not after its address.
  const names = new Map(namedUrls(testCase.record).filter((entry) => entry.name).map((entry) => [entry.url, entry.name!]));
  planned.links = planned.links.map((link) => (names.has(link.url) ? { ...link, name: names.get(link.url)! } : link));
  const lists = new Set(doc.stepLists.map((list) => list.field));
  // The transform above collected examples of text it read; scenarios of the file add theirs.
  const examples = examplesSink(profile.options.gherkinExamples);
  examples.examples.push(...(planned.examples ?? []));
  for (const mapping of scenarioMappings) {
    let steps: PlannedStep[];
    if (lists.has(mapping.source)) {
      steps = (testCase.record.steps.get(mapping.source) ?? [])
        .map((step, index) => buildStep(step.action, step.expected, step.data, index + 1, { format: profile.options.textFormat }))
        .filter((step) => step.type !== "step" || step.body || step.expected || step.data);
    } else {
      const text = (testCase.record.values.get(mapping.source) ?? []).join("\n\n");
      steps = text.trim() ? stepsWithExamples(text, (rest) => parseSteps(rest, profile.xml.steps), examples) : [];
    }
    if (steps.length === 0) {
      continue;
    }
    if (planned.scenario.length > 0) {
      notes.push(note.scenarioTwice(mapping.source));
      continue;
    }
    planned.scenario = steps;
  }

  // Files: listed in fields mapped to Attachments, and images inside text and steps.
  const addFile = (key: string) => {
    if (!planned.attachments.some((attachment) => attachment.sourceId === key)) {
      planned.attachments.push({ sourceId: key, fileName: xmlFiles.nameOf(key) });
    }
  };
  for (const mapping of fileMappings) {
    for (const value of testCase.record.values.get(mapping.source) ?? []) {
      const file = /\s/.test(value) ? null : xmlFiles.resolve(value);
      if (file) {
        addFile(xmlFiles.register(file, names.get(value) ?? null));
      } else if (/^https?:\/\/\S+$/i.test(value)) {
        // Not downloaded: the address is kept as a link.
        planned.links.push({ name: names.get(value) ?? value, url: value });
      } else {
        notes.push(note.linkNotUrl(value, mapping.source));
      }
    }
  }
  const inText = [planned.description, planned.precondition, planned.expectedResult, ...planned.comments].flatMap((text) => [...text.matchAll(PLANNED_FILE)].map((match) => match[1]!));
  inText.filter((key) => xmlFiles.has(key)).forEach(addFile);
  if (inText.every((key) => xmlFiles.has(key))) {
    planned.notes = notes.filter((entry) => entry.code !== "csv-testrail-images");
  }
  liftStepImages(planned.scenario, xmlFiles);
  if (examples.examples.length > 0) {
    planned.examples = examples.examples;
  }
  return { planned, linkedCaseIds: [] };
}

const PLANNED_FILE = new RegExp(`!\\[[^\\]]*\\]\\(${ATTACHMENT_SCHEME}([A-Za-z0-9-]+)\\)`, "g");

/** Step text is plain: images inside it become attachments of the step, named after their files. */
function liftStepImages(steps: PlannedStep[], xmlFiles: XmlFiles): void {
  const lift = (text: string | null, attachments: PlannedAttachment[]): string | null => {
    if (!text || !text.includes(ATTACHMENT_SCHEME)) {
      return text;
    }
    for (const match of text.matchAll(PLANNED_FILE)) {
      if (!attachments.some((attachment) => attachment.sourceId === match[1])) {
        attachments.push({ sourceId: match[1]!, fileName: "" });
      }
    }
    return text.replace(PLANNED_FILE, "").replace(/\n{3,}/g, "\n\n").trim();
  };
  for (const step of steps) {
    if (step.type !== "step") {
      continue;
    }
    step.body = lift(step.body, step.attachments) || (step.attachments.length > 0 ? "See attachment" : "");
    step.data = lift(step.data, step.dataAttachments);
    step.expected = lift(step.expected, step.expectedAttachments);
    for (const attachment of [...step.attachments, ...step.dataAttachments, ...step.expectedAttachments]) {
      if (attachment.sourceId !== null && xmlFiles.has(attachment.sourceId)) {
        attachment.fileName = xmlFiles.nameOf(attachment.sourceId);
      }
    }
    liftStepImages(step.steps ?? [], xmlFiles);
  }
}

/** "Test download" on the Connection step: reads the first file the XML refers to at the source system. */
export async function checkXmlFiles(profile: Profile, files: FileStore): Promise<ConnectionCheck> {
  const fail = (message: string): ConnectionCheck => ({ ok: false, message });
  if (!profile.xml.files.download) {
    return fail("Turn on \"Download attached files\" first.");
  }
  const { doc, xmlFiles } = await loadXml(profile, files);
  if (!xmlFiles.enabled) {
    return fail("Enter the address of the source system, starting with http:// or https://.");
  }
  const { effective } = analyseFields(profile, doc);
  const fileFields = effective.fields.filter((mapping) => mapping.target.kind === "attachment").map((mapping) => mapping.source);
  const linkFields = effective.fields.filter((mapping) => mapping.target.kind === "link").map((mapping) => mapping.source);
  // Addresses at the source system in fields mapped to Links: probably files, but nothing says so.
  const asLinks = linkFields.filter((field) => doc.records.some((record) => (record.values.get(field) ?? []).some((value) => /^https?:\/\/\S+$/i.test(value) && xmlFiles.resolve(value))));
  const listed: string[] = [];
  for (const record of doc.records) {
    const names = new Map(namedUrls(record).map((entry) => [entry.url, entry.name]));
    listed.push(...namedUrls(record).map((entry) => entry.url));
    for (const field of fileFields) {
      for (const value of record.values.get(field) ?? []) {
        const file = /\s/.test(value) ? null : xmlFiles.resolve(value);
        if (file) {
          xmlFiles.register(file, names.get(value) ?? null);
        }
      }
    }
  }
  const elsewhere = otherHosts(listed, xmlFiles.origin);
  const others =
    (elsewhere.length > 0 ? ` Addresses at ${elsewhere.slice(0, 3).join(", ")} are not downloaded and stay links.` : "") +
    (asLinks.length > 0 ? ` ${asLinks.join(", ")} also holds addresses at this system but is mapped to Links: map it to Attachments on the Fields step to download those files.` : "");
  const keys = xmlFiles.keys;
  if (keys.length === 0) {
    return fail(
      `The file refers to no files at ${xmlFiles.origin}: no field mapped to Attachments holds such addresses and the text has no such images.${others || " Check that the address is the one the addresses in the file start with."}`,
    );
  }
  try {
    const file = await xmlFiles.download(keys[0]!);
    const size = file.data.length < 1024 * 1024 ? `${Math.max(1, Math.round(file.data.length / 1024))} KB` : `${(file.data.length / 1024 / 1024).toFixed(1)} MB`;
    return { ok: true, message: `Downloaded "${file.fileName}" (${size}). The file refers to ${keys.length} file(s) at ${xmlFiles.origin}.${others}` };
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : String(error)}.`);
  }
}

/** The name field must be mapped before anything can be imported. */
export function requireNameField(profile: Profile): void {
  if (!columnFor(profile, "name")) {
    throw new KnownProblem({
      key: "no-name-column",
      title: "No field is mapped to the test case name, so nothing can be imported.",
      hint: "The name is the only required value. On the Fields step, map the field that holds the test case names to \"Test case name\".",
      fix: { step: "fields" },
    });
  }
}
