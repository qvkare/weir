import type { ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "@/lib/markdown.ts";

// A Markdown document from the repository (docs/SPEC.md at /spec, docs/AUDIT.md at /audit),
// rendered as plain elements with an anchor per heading and a table of contents.

export function In({ v }: { v: Inline[] }): ReactNode {
  return v.map((x, i) =>
    x.t === "text" ? x.v : x.t === "code" ? <code key={i}>{x.v}</code> : x.t === "b" ? <b key={i}><In v={x.v} /></b> : <a key={i} href={x.href.startsWith("http") || x.href.startsWith("/") || x.href.startsWith("#") ? x.href : undefined}><In v={x.v} /></a>,
  );
}

function Render({ b }: { b: Block }) {
  switch (b.t) {
    case "h":
      // The document's own title is the page's h1; its sections are h2 and h3.
      if (b.level === 1) return null;
      return b.level === 2 ? <h2 id={b.id} className="spec-h2">{b.text}</h2> : <h3 id={b.id} className="spec-h3">{b.text}</h3>;
    case "p":
      return <p><In v={b.v} /></p>;
    case "code":
      return <pre>{b.v}</pre>;
    case "ul":
      return <ul className="spec-list">{b.items.map((it, i) => <li key={i}><In v={it} /></li>)}</ul>;
    case "table":
      return (
        <div className="table-wrap">
          <table>
            <thead><tr>{b.head.map((c, i) => <th key={i} scope="col"><In v={c} /></th>)}</tr></thead>
            <tbody>{b.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}><In v={c} /></td>)}</tr>)}</tbody>
          </table>
        </div>
      );
  }
}


export function MarkdownDoc({ text, tocLabel = "Sections" }: { text: string; tocLabel?: string }) {
  const blocks = parseMarkdown(text);
  const toc = blocks.filter((b): b is Extract<Block, { t: "h" }> => b.t === "h" && b.level === 2);
  return (
    <div className="spec-doc">
      <nav aria-label={tocLabel} className="spec-toc">
        <ol>{toc.map((h) => <li key={h.id}><a href={`#${h.id}`}>{h.text}</a></li>)}</ol>
      </nav>
      <article className="spec-body-text">{blocks.map((b, i) => <Render key={i} b={b} />)}</article>
    </div>
  );
}
