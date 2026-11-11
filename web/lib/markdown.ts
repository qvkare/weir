// A small Markdown reader for docs/SPEC.md, enough for /spec: headings, paragraphs, fenced code,
// pipe tables and bullet lists, with inline code, bold and links. It returns plain data; the page
// renders it as React elements, so nothing is set as raw HTML.

export type Inline = { t: "text"; v: string } | { t: "code"; v: string } | { t: "b"; v: Inline[] } | { t: "a"; href: string; v: Inline[] };

export type Block =
  | { t: "h"; level: number; id: string; text: string }
  | { t: "p"; v: Inline[] }
  | { t: "code"; v: string }
  | { t: "table"; head: Inline[][]; rows: Inline[][][] }
  | { t: "ul"; items: Inline[][] };

/** "## 9. Index" -> "s9"; "### 6.2 Commit" -> "s6-2"; other headings by their words. */
export function headingId(text: string): string {
  const m = /^(\d+(?:\.\d+)*)\.?\s/.exec(text);
  if (m) return `s${m[1]!.replace(/\./g, "-")}`;
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function inline(src: string): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  let text = "";
  const flush = () => {
    if (text) out.push({ t: "text", v: text });
    text = "";
  };
  while (i < src.length) {
    const c = src[i]!;
    if (c === "`") {
      const j = src.indexOf("`", i + 1);
      if (j > i) {
        flush();
        out.push({ t: "code", v: src.slice(i + 1, j) });
        i = j + 1;
        continue;
      }
    }
    if (c === "*" && src[i + 1] === "*") {
      const j = src.indexOf("**", i + 2);
      if (j > i) {
        flush();
        out.push({ t: "b", v: inline(src.slice(i + 2, j)) });
        i = j + 2;
        continue;
      }
    }
    if (c === "[") {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(src.slice(i));
      if (m) {
        flush();
        out.push({ t: "a", href: m[2]!, v: inline(m[1]!) });
        i += m[0].length;
        continue;
      }
    }
    text += c;
    i++;
  }
  flush();
  return out;
}

const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => inline(c.trim()));

export function parseMarkdown(md: string): Block[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      out.push({ t: "h", level: h[1]!.length, id: headingId(h[2]!), text: h[2]! });
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) body.push(lines[i++]!);
      i++;
      out.push({ t: "code", v: body.join("\n") });
      continue;
    }
    if (line.trim().startsWith("|")) {
      const rows: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) rows.push(lines[i++]!);
      const [head, , ...body] = rows;
      out.push({ t: "table", head: cells(head!), rows: body.map(cells) });
      continue;
    }
    if (/^\s*[-*]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && (/^\s*[-*]\s/.test(lines[i]!) || (/^\s{2,}\S/.test(lines[i]!) && items.length))) {
        const l = lines[i++]!;
        if (/^\s*[-*]\s/.test(l)) items.push(l.replace(/^\s*[-*]\s/, ""));
        else items[items.length - 1] += ` ${l.trim()}`;
      }
      out.push({ t: "ul", items: items.map(inline) });
      continue;
    }
    if (/^\d+\.\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && (/^\d+\.\s/.test(lines[i]!) || (/^\s{2,}\S/.test(lines[i]!) && items.length))) {
        const l = lines[i++]!;
        if (/^\d+\.\s/.test(l)) items.push(l.replace(/^\d+\.\s/, ""));
        else items[items.length - 1] += ` ${l.trim()}`;
      }
      out.push({ t: "ul", items: items.map(inline) });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,4}\s|```|\s*\||\s*[-*]\s|\d+\.\s)/.test(lines[i]!)) para.push(lines[i++]!.trim());
    out.push({ t: "p", v: inline(para.join(" ")) });
  }
  return out;
}
