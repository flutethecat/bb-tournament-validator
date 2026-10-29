// Markdown-lite for organiser text (tournament summary, notes, news): paragraphs, **bold**, *italic*, links
// ([label](https://...) and bare http(s) URLs) and lists ("- " / "* " bullets, "1. " numbered). The output is a
// token tree rendered by MarkdownLite.vue with text interpolation only: no raw HTML ever reaches the page, and a
// link whose target is not http(s) stays plain text.

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "link"; href: string; text: string };

export type Block =
  | { kind: "p"; lines: Inline[][] }
  | { kind: "ul" | "ol"; items: Inline[][] };

/** http(s) only, no credentials, no whitespace; anything else is not a link. */
export function safeLink(href: string): string {
  const value = href.trim();
  if (!/^https?:\/\//i.test(value) || /\s/.test(value)) return "";
  try {
    const url = new URL(value);
    return url.username || url.password ? "" : url.href;
  } catch {
    return "";
  }
}

const LINK = /\[([^\]\n]{1,200})\]\(([^)\s]{1,500})\)/y;
const BARE = /https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/y;

/** Inline tokens of one line. Emphasis does not nest links inside it (kept simple on purpose). */
export function parseInline(line: string): Inline[] {
  const out: Inline[] = [];
  let buffer = "";
  const flush = (): void => { if (buffer) { out.push({ kind: "text", text: buffer }); buffer = ""; } };
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === "[") {
      LINK.lastIndex = i;
      const m = LINK.exec(line);
      if (m) {
        const href = safeLink(m[2]!);
        flush();
        out.push(href ? { kind: "link", href, text: m[1]! } : { kind: "text", text: m[1]! });
        i += m[0].length;
        continue;
      }
    }
    if (ch === "h" && (line.startsWith("http://", i) || line.startsWith("https://", i))) {
      BARE.lastIndex = i;
      const m = BARE.exec(line);
      const href = m ? safeLink(m[0]) : "";
      if (m && href) {
        flush();
        out.push({ kind: "link", href, text: m[0] });
        i += m[0].length;
        continue;
      }
    }
    if (ch === "*" && line[i + 1] === "*") {
      const end = line.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        out.push({ kind: "strong", children: parseInline(line.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if ((ch === "*" || ch === "_") && line[i + 1] !== ch && line[i + 1] !== " ") {
      const end = line.indexOf(ch, i + 1);
      if (end > i + 1 && line[end - 1] !== " ") {
        flush();
        out.push({ kind: "em", children: parseInline(line.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    buffer += ch;
    i += 1;
  }
  flush();
  return out;
}

const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBER = /^\s*\d{1,3}[.)]\s+(.*)$/;

/** Blocks: a blank line ends a paragraph or list; consecutive list lines of one kind form one list. */
export function parseMarkdownLite(source: string | undefined | null): Block[] {
  const blocks: Block[] = [];
  if (!source) return blocks;
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let current: Block | null = null;
  const close = (): void => { if (current) blocks.push(current); current = null; };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { close(); continue; }
    const bullet = BULLET.exec(line);
    const number = bullet ? null : NUMBER.exec(line);
    if (bullet || number) {
      const kind = bullet ? "ul" : "ol";
      const text = (bullet ?? number)![1]!;
      if (!current || current.kind !== kind) { close(); current = { kind, items: [] }; }
      (current as Extract<Block, { kind: "ul" | "ol" }>).items.push(parseInline(text));
      continue;
    }
    if (!current || current.kind !== "p") { close(); current = { kind: "p", lines: [] }; }
    (current as Extract<Block, { kind: "p" }>).lines.push(parseInline(line.trim()));
  }
  close();
  return blocks;
}
