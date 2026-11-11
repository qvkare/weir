import { dotPath, ROWS } from "@/lib/dotmatrix.ts";

/**
 * A figure in the dot-matrix face (lib/dotmatrix.ts). The real text is in the page for screen
 * readers, search and copying; the drawing is hidden from assistive technology. Server-rendered,
 * so a dot figure is part of the first paint like any text.
 */
export function DotText({ text, className }: { text: string; className?: string }) {
  const { width, d } = dotPath(text);
  return (
    <span className={`dm${className ? ` ${className}` : ""}`}>
      <span className="sr-only">{text}</span>
      <svg viewBox={`0 0 ${width} ${ROWS}`} aria-hidden="true" focusable="false" style={{ aspectRatio: `${width} / ${ROWS}` }}>
        <path d={d} fill="currentColor" />
      </svg>
    </span>
  );
}
