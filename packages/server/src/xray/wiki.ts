import { markdownTable } from "../convert/markup.js";

/**
 * Jira wiki markup (used by Xray for steps, preconditions and generic definitions) to Markdown.
 * Covers what test cases use: headings, lists, emphasis, code, quotes, links, tables and images.
 * `image` decides what an `!file.png!` reference becomes; by default it is dropped.
 */
export function wikiToMarkdown(raw: string, image: (fileName: string) => string = () => ""): string {
  const text = raw.replace(/\r\n?/g, "\n");
  const blocks: string[] = [];
  // Code and noformat blocks are kept verbatim; placeholders keep inline rules away from them.
  let protectedText = text
    .replace(/\{code(?::([^}|]*))?[^}]*\}([\s\S]*?)\{code\}/g, (_m, lang: string | undefined, body: string) => {
      blocks.push(`\`\`\`${(lang ?? "").trim()}\n${body.replace(/^\n|\n$/g, "")}\n\`\`\``);
      return `\u0000${blocks.length - 1}\u0000`;
    })
    .replace(/\{noformat[^}]*\}([\s\S]*?)\{noformat\}/g, (_m, body: string) => {
      blocks.push(`\`\`\`\n${body.replace(/^\n|\n$/g, "")}\n\`\`\``);
      return `\u0000${blocks.length - 1}\u0000`;
    });

  protectedText = protectedText
    .replace(/\{quote\}([\s\S]*?)\{quote\}/g, (_m, body: string) =>
      body
        .trim()
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n"),
    )
    .replace(/\{color(?::[^}]*)?\}/g, "")
    .replace(/\{panel[^}]*\}/g, "")
    .replace(/\{anchor[^}]*\}/g, "");

  const lines = protectedText.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*\|/.test(line)) {
      // A table: consecutive lines starting with | or ||.
      const rows: { header: boolean; cells: string[] }[] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i]!)) {
        const row = lines[i]!.trim();
        const header = row.startsWith("||");
        const cells = row
          .replace(/^\|\|?/, "")
          .replace(/\|\|?\s*$/, "")
          .split(/\|\|?/)
          .map((cell) => inline(cell.trim(), image));
        rows.push({ header, cells });
        i++;
      }
      i--;
      const head = rows[0]?.header ? rows.shift()!.cells : Array.from({ length: Math.max(...rows.map((r) => r.cells.length), 0) }, () => "");
      out.push(markdownTable(head, rows.map((r) => r.cells)));
      continue;
    }
    const heading = /^\s*h([1-6])\.\s+(.*)$/.exec(line);
    if (heading) {
      out.push(`${"#".repeat(Number(heading[1]))} ${inline(heading[2]!, image)}`);
      continue;
    }
    const list = /^\s*([*#-]+)\s+(.*)$/.exec(line);
    if (list && !/^-{2,}$/.test(list[1]!)) {
      const markers = list[1]!;
      const depth = markers.length - 1;
      const ordered = markers.endsWith("#");
      out.push(`${"  ".repeat(depth)}${ordered ? "1." : "-"} ${inline(list[2]!, image)}`);
      continue;
    }
    if (/^\s*----\s*$/.test(line)) {
      out.push("---");
      continue;
    }
    out.push(inline(line, image));
  }
  return out
    .join("\n")
    .replace(/\u0000(\d+)\u0000/g, (_m, index: string) => blocks[Number(index)]!)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function inline(text: string, image: (fileName: string) => string): string {
  return (
    text
      // Images: !file.png! or !file.png|thumbnail!
      .replace(/!([^!\s|][^!|]*?)(?:\|[^!]*)?!/g, (_m, name: string) => image(name.trim()))
      // Links: [text|url], [url], mentions [~accountid:...]
      .replace(/\[~[^\]]+\]/g, "@user")
      .replace(/\[([^\]|]+)\|([^\]]+)\]/g, (_m, label: string, url: string) => `[${label.trim()}](${url.trim()})`)
      .replace(/\[((?:https?|mailto):[^\]\s]+)\]/g, "<$1>")
      // Monospace, bold, italic, strike-through, underline, citation.
      .replace(/\{\{(.+?)\}\}/g, "`$1`")
      .replace(/(^|[\s(>])\*(\S(?:.*?\S)?)\*(?=$|[\s).,:;!?<])/g, "$1**$2**")
      .replace(/(^|[\s(>])_(\S(?:.*?\S)?)_(?=$|[\s).,:;!?<])/g, "$1*$2*")
      .replace(/(^|[\s(>])-(\S(?:.*?\S)?)-(?=$|[\s).,:;!?<])/g, "$1~~$2~~")
      .replace(/(^|[\s(>])\+(\S(?:.*?\S)?)\+(?=$|[\s).,:;!?<])/g, "$1$2")
      .replace(/\?\?(.+?)\?\?/g, "*$1*")
      // Forced line break.
      .replace(/\s*\\\\\s*/g, "\n")
      // Escaped markup characters.
      .replace(/\\([*_{}[\]!|+\-^~?#])/g, "$1")
  );
}

/**
 * Wiki markup for Allure TestOps step text, which is plain: emphasis and code markers are dropped,
 * links keep their address, lists and tables stay (tables are moved into files by the step builder).
 */
export function wikiToStepText(raw: string): string {
  return wikiToMarkdown(raw)
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|[\s(])\*(\S(?:.*?\S)?)\*(?=$|[\s).,:;!?])/gm, "$1$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\((\S+?)\)/g, (_m, label: string, url: string) => (label === url ? url : `${label} (${url})`))
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1");
}

/** Plain text of wiki markup for one line values, e.g. step bodies of called tests in names. */
export function wikiToPlain(raw: string): string {
  return wikiToMarkdown(raw)
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
