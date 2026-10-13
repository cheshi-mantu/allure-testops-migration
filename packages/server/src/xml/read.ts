import { SaxesParser } from "saxes";

/**
 * Reads test cases from any XML export without knowing the tool that made it. Exports share one
 * shape: named containers (suites, sections, folders) around a repeating test case element, whose
 * children are fields, lists of values and a list of steps. The file is parsed twice with a stream
 * parser: once to learn the structure, once to turn every case into fields with values.
 */

export interface XmlStep {
  action: string;
  expected: string;
  data: string;
}

export interface XmlRecord {
  /** 1-based line of the case element in the file. */
  line: number;
  /** Field -> values in document order, without repeats. Field names are paths inside the case, e.g. `custom/preconds`. */
  values: Map<string, string[]>;
  /** Step list field -> steps. */
  steps: Map<string, XmlStep[]>;
  /** Names of the named elements around the case, outermost first, without the document root. */
  path: string[];
}

export interface XmlStepList {
  field: string;
  /** Child elements of a step used as action, expected result and data. */
  action: string | null;
  expected: string | null;
  data: string | null;
}

export interface XmlDocument {
  root: string;
  caseElement: string | null;
  /** Elements that could hold a test case, most likely first. */
  candidates: { name: string; count: number }[];
  records: XmlRecord[];
  /** Fields in order of first appearance. */
  fields: string[];
  stepLists: XmlStepList[];
  warnings: string[];
}

interface PathStat {
  count: number;
  childNames: Set<string>;
  /** Most children of one name inside a single instance. */
  maxRepeat: number;
  /** Instances with a name or title of their own. */
  titled: number;
  scalarChildren: Set<string>;
}

/** Names a test case element usually has, most specific first. */
const CASE_NAMES = ["testcase", "test-case", "test_case", "case", "testscenario", "scenario", "test", "item", "issue", "record", "entry", "row"];
const TITLE = /^(title|name|summary)$/i;
const STEP = /step|action/i;
const ACTION = ["content", "action", "actions", "step", "description", "name", "title", "text", "body"];
const EXPECTED = ["expected", "expectedresult", "expectedresults", "expected_result", "expected_results", "result", "results"];
const DATA = ["additional_info", "data", "testdata", "test_data", "input", "inputs", "notes", "comment", "comments"];

function decode(data: Buffer): string {
  // The declared encoding, UTF-8 unless the file says otherwise.
  const head = data.subarray(0, 200).toString("latin1");
  const declared = /encoding\s*=\s*["']([\w-]+)["']/i.exec(head)?.[1]?.toLowerCase() ?? "utf-8";
  try {
    return new TextDecoder(declared).decode(data);
  } catch {
    return new TextDecoder("utf-8").decode(data);
  }
}

/** `a/b/a/b` reads as `a/b`: nested containers of the same kind share one path. */
function collapse(parent: string[], name: string): string[] {
  const seen = parent.indexOf(name);
  return seen >= 0 ? parent.slice(0, seen + 1) : [...parent, name];
}

function parse(text: string, handlers: { open: (name: string, attrs: Record<string, string>, line: number) => void; text: (text: string) => void; close: (name: string) => void }): void {
  const parser = new SaxesParser();
  parser.on("opentag", (tag) => handlers.open(tag.name, tag.attributes as Record<string, string>, parser.line));
  parser.on("text", handlers.text);
  parser.on("cdata", handlers.text);
  parser.on("closetag", (tag) => handlers.close(tag.name));
  parser.on("error", (error) => {
    throw new Error(`The file is not well-formed XML: ${error.message}`);
  });
  const CHUNK = 1 << 20;
  for (let offset = 0; offset < text.length; offset += CHUNK) {
    parser.write(text.slice(offset, offset + CHUNK));
  }
  parser.close();
}

/** First pass: what repeats, what is a list, which element looks like a test case. */
function scan(text: string): { root: string; stats: Map<string, PathStat> } {
  const stats = new Map<string, PathStat>();
  const stack: { path: string[]; children: Map<string, number>; text: string; titled: boolean; scalars: Set<string> }[] = [];
  let root = "";
  parse(text, {
    open: (name, attrs) => {
      const parent = stack[stack.length - 1];
      const path = collapse(parent?.path ?? [], name);
      root ||= name;
      parent?.children.set(name, (parent.children.get(name) ?? 0) + 1);
      stack.push({ path, children: new Map(), text: "", titled: Object.keys(attrs).some((a) => TITLE.test(a) && attrs[a]!.trim() !== ""), scalars: new Set() });
    },
    text: (chunk) => {
      const frame = stack[stack.length - 1];
      if (frame && frame.text.length < 64) {
        frame.text += chunk;
      }
    },
    close: (name) => {
      const frame = stack.pop()!;
      const parent = stack[stack.length - 1];
      const key = frame.path.join("/");
      const stat = stats.get(key) ?? { count: 0, childNames: new Set<string>(), maxRepeat: 0, titled: 0, scalarChildren: new Set<string>() };
      stat.count += 1;
      for (const [child, count] of frame.children) {
        stat.childNames.add(child);
        stat.maxRepeat = Math.max(stat.maxRepeat, count);
      }
      frame.scalars.forEach((s) => stat.scalarChildren.add(s));
      if (frame.titled) {
        stat.titled += 1;
      }
      stats.set(key, stat);
      if (parent && frame.children.size === 0 && frame.text.trim() !== "") {
        parent.scalars.add(name);
        if (TITLE.test(name)) {
          parent.titled = true;
        }
      }
    },
  });
  return { root, stats };
}

function caseCandidates(root: string, stats: Map<string, PathStat>): { name: string; count: number }[] {
  const entries = [...stats.entries()].filter(([path]) => path !== root);
  const last = (path: string) => path.split("/").pop()!;
  const known = (name: string) => {
    const index = CASE_NAMES.indexOf(name.toLowerCase());
    return index < 0 ? CASE_NAMES.length : index;
  };
  // A name and value pair has a name too, but it is a field of a case.
  const isPair = (s: PathStat) => [...s.childNames].every((child) => ["name", "value", "id", "key"].includes(child));
  const titled = entries.filter(([, s]) => s.titled / s.count >= 0.5 && s.childNames.size >= 2 && !isPair(s));
  const named = titled.filter(([path]) => known(last(path)) < CASE_NAMES.length);
  // Without a familiar name: not a part of a case, and not a container of what looks like cases.
  const guessed = titled.filter(
    ([path, s]) =>
      !named.some(([other]) => other === path || path.startsWith(`${other}/`)) &&
      !titled.some(([other, o]) => other.startsWith(`${path}/`) && o.count >= s.count),
  );
  const byName = new Map<string, number>();
  for (const [path, s] of [...named, ...guessed]) {
    byName.set(last(path), (byName.get(last(path)) ?? 0) + s.count);
  }
  const ranked = [...byName.entries()].sort((a, b) => known(a[0]) - known(b[0]) || b[1] - a[1]).map(([name, count]) => ({ name, count }));
  // Everything else that repeats stays available, for files the guess does not fit.
  const others = new Map<string, number>();
  for (const [path, s] of entries) {
    const name = last(path);
    if (!byName.has(name) && s.childNames.size > 0) {
      others.set(name, (others.get(name) ?? 0) + s.count);
    }
  }
  return [...ranked, ...[...others.entries()].filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }))];
}

interface Node {
  name: string;
  path: string[];
  attrs: Record<string, string>;
  text: string;
  children: Node[];
}

const scalar = (node: Node) => node.children.length === 0;

/** `<priority><id>3</id><value>High</value></priority>`: the value, with the id as a technical detail. */
function wrapped(node: Node): string | null {
  const value = node.children.find((c) => c.name === "value" && scalar(c));
  return value && node.children.every((c) => scalar(c) && ["value", "id", "key"].includes(c.name)) ? value.text.trim() : null;
}

const simple = (node: Node): string | null => (scalar(node) ? node.text.trim() : wrapped(node));

/** `<custom_field><name>Browser</name><value>Chrome</value></custom_field>`: a field called by its name. */
function pair(item: Node): { name: string; value: string | null } | null {
  const name = item.children.find((c) => c.name === "name");
  const value = item.children.find((c) => c.name === "value");
  return name && value && simple(name) ? { name: simple(name)!, value: simple(value) } : null;
}

export function readXml(data: Buffer, options: { caseElement: string | null } = { caseElement: null }): XmlDocument {
  const text = decode(data);
  const { root, stats } = scan(text);
  const candidates = caseCandidates(root, stats);
  const caseElement = options.caseElement && candidates.some((c) => c.name === options.caseElement) ? options.caseElement : (candidates[0]?.name ?? null);
  const warnings: string[] = [];
  if (options.caseElement && options.caseElement !== caseElement) {
    warnings.push(`The file has no "${options.caseElement}" elements; test cases are read from "${caseElement ?? "nothing"}" instead.`);
  }
  if (!caseElement) {
    return { root, caseElement: null, candidates, records: [], fields: [], stepLists: [], warnings: ["No element of this file looks like a test case: nothing repeats with a name or title."] };
  }
  const isList = (node: Node) => {
    const stat = stats.get(node.path.join("/"));
    return Boolean(stat && stat.childNames.size === 1 && stat.maxRepeat >= 2 && node.text.trim() === "");
  };

  const fields: string[] = [];
  const known = new Set<string>();
  const rawSteps = new Map<string, Map<string, number>>();
  const records: (XmlRecord & { frames: { label: string | null }[]; rawSteps: Map<string, Map<string, string>[]> })[] = [];

  const flatten = (record: (typeof records)[number], node: Node, prefix: string) => {
    const add = (field: string, value: string | null) => {
      const trimmed = value?.trim();
      if (!trimmed) {
        return;
      }
      if (!known.has(field)) {
        known.add(field);
        fields.push(field);
      }
      const list = record.values.get(field) ?? [];
      if (!list.includes(trimmed)) {
        list.push(trimmed);
      }
      record.values.set(field, list);
    };
    for (const [attr, value] of Object.entries(node.attrs)) {
      if (!attr.startsWith("xmlns")) {
        add(`${prefix}@${attr}`, value);
      }
    }
    for (const child of node.children) {
      const field = `${prefix}${child.name}`;
      const value = simple(child);
      if (value !== null) {
        add(field, value);
        continue;
      }
      const single = pair(child);
      if (single && child.children.length === 2 && stats.get(node.path.join("/"))?.childNames.size === 1) {
        // One name and value pair, e.g. the only custom field of a case: a field named by the pair.
        add(`${prefix}${single.name}`, single.value);
        continue;
      }
      if (isList(child)) {
        const items = child.children;
        if (STEP.test(child.name) || STEP.test(items[0]!.name)) {
          const steps = items.map((item) => {
            const parts = new Map<string, string>();
            if (scalar(item)) {
              parts.set(item.name, item.text.trim());
            }
            for (const part of item.children) {
              const partText = simple(part);
              if (partText) {
                parts.set(part.name, partText);
              }
            }
            return parts;
          });
          record.rawSteps.set(field, [...(record.rawSteps.get(field) ?? []), ...steps]);
          const seen = rawSteps.get(field) ?? new Map<string, number>();
          steps.forEach((parts) => parts.forEach((_v, key) => seen.set(key, (seen.get(key) ?? 0) + 1)));
          rawSteps.set(field, seen);
          continue;
        }
        if (items.every((item) => simple(item) !== null)) {
          // A list of values: one field with several values.
          items.forEach((item) => add(field, simple(item)));
        } else if (items.every((item) => pair(item) !== null)) {
          // A list of name and value pairs, e.g. custom fields: one field per name.
          items.forEach((item) => add(`${field}/${pair(item)!.name}`, pair(item)!.value));
        } else {
          // A list of records, e.g. attachments: their fields, each with several values.
          items.forEach((item) => flatten(record, item, `${field}/`));
        }
        continue;
      }
      flatten(record, child, `${field}/`);
      if (child.text.trim()) {
        add(field, child.text);
      }
    }
  };

  const frames: { name: string; label: string | null; text: string; hasChildren: boolean }[] = [];
  const building: Node[] = [];
  let current: (typeof records)[number] | null = null;
  parse(text, {
    open: (name, attrs, line) => {
      if (building.length > 0) {
        const parent = building[building.length - 1]!;
        const node: Node = { name, path: collapse(parent.path, name), attrs, text: "", children: [] };
        parent.children.push(node);
        building.push(node);
        return;
      }
      const parent = frames[frames.length - 1];
      if (parent) {
        parent.hasChildren = true;
      }
      if (name === caseElement) {
        const path = frames.reduce<string[]>((all, frame) => collapse(all, frame.name), []);
        current = { line, values: new Map(), steps: new Map(), path: [], frames: frames.slice(1), rawSteps: new Map() };
        building.push({ name, path: collapse(path, name), attrs, text: "", children: [] });
        return;
      }
      const label = Object.entries(attrs).find(([attr, value]) => TITLE.test(attr) && value.trim() !== "")?.[1]?.trim() ?? null;
      frames.push({ name, label, text: "", hasChildren: false });
    },
    text: (chunk) => {
      const target = building[building.length - 1] ?? frames[frames.length - 1];
      if (target) {
        target.text += chunk;
      }
    },
    close: (name) => {
      if (building.length > 0) {
        const node = building.pop()!;
        if (building.length === 0 && current) {
          flatten(current, node, "");
          records.push(current);
          current = null;
        }
        return;
      }
      const frame = frames.pop()!;
      const parent = frames[frames.length - 1];
      // The first name or title directly under a container names it.
      if (parent && !frame.hasChildren && TITLE.test(name) && parent.label === null && frame.text.trim() !== "") {
        parent.label = frame.text.trim();
      }
    },
  });

  const pick = (seen: Map<string, number>, names: string[], taken: (string | null)[]) => names.find((n) => seen.has(n) && !taken.includes(n)) ?? null;
  const stepLists: XmlStepList[] = [...rawSteps.entries()].map(([field, seen]) => {
    const action = pick(seen, ACTION, []) ?? [...seen.keys()][0] ?? null;
    const expected = pick(seen, EXPECTED, [action]);
    const stepData = pick(seen, DATA, [action, expected]);
    return { field, action, expected, data: stepData };
  });
  for (const record of records) {
    record.path = record.frames.map((frame) => frame.label).filter((label): label is string => Boolean(label));
    for (const list of stepLists) {
      const steps = (record.rawSteps.get(list.field) ?? [])
        .map((parts) => ({
          action: (list.action && parts.get(list.action)) || "",
          expected: (list.expected && parts.get(list.expected)) || "",
          data: (list.data && parts.get(list.data)) || "",
        }))
        .filter((step) => step.action || step.expected || step.data);
      if (steps.length > 0) {
        record.steps.set(list.field, steps);
      }
    }
  }
  if (records.length === 0) {
    warnings.push(`The file has no "${caseElement}" elements with content.`);
  }
  return {
    root,
    caseElement,
    candidates,
    records: records.map(({ line, values, steps, path }) => ({ line, values, steps, path })),
    fields,
    stepLists,
    warnings,
  };
}
