import type { StructureMapping } from "./profile.js";

/**
 * Applies the structure mapping to a section path (top level first):
 * returns custom field name -> values. Levels without a field are skipped;
 * levels deeper than the mapped ones are joined into the last mapped level or dropped.
 */
/** `\n` in a separator stands for a line break, which a one-line input cannot hold. */
export const LINE_BREAK = "\\n";

/** A value split by the separator of its mapping: a character, a word or `\n` for one value per line. */
export function splitValue(value: string, separator: string): string[] {
  if (!separator) {
    return [value];
  }
  return separator === LINE_BREAK ? value.split(/\r?\n/) : value.split(separator);
}

/**
 * One example of a field for the mapping screens: a value of one case, shortened. A line break
 * shows as ↵, so values that hold several lines can be told from several values.
 */
export function exampleText(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_match, name: string) => `[image${name ? `: ${name}` : ""}]`)
    .replace(/[ \t]*\r?\n\s*/g, " ↵ ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

export function mapSectionPath(names: string[], structure: StructureMapping): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const add = (field: string, value: string) => {
    const values = result.get(field) ?? [];
    if (!values.includes(value)) {
      values.push(value);
    }
    result.set(field, values);
  };
  const mapped = structure.levels.length;
  names.slice(0, mapped).forEach((name, index) => {
    const field = structure.levels[index];
    if (field) {
      add(field, name);
    }
  });
  if (names.length > mapped && structure.deeperLevels === "join" && mapped > 0) {
    const lastField = structure.levels[mapped - 1];
    if (lastField) {
      const joined = names.slice(mapped - 1).join(structure.joinSeparator);
      // Replace the plain last level value with the joined path.
      result.set(lastField, (result.get(lastField) ?? []).filter((v) => v !== names[mapped - 1]).concat(joined));
    }
  }
  return result;
}
