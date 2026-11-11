import type { ReactNode } from "react";
import { dotPath, ROWS } from "@/lib/dotmatrix.ts";

/** A numbered sheet: "03  The hour is the product", on an ink rule, a note on the right. */
export function SheetHead({ no, id, title, note }: { no: string; id: string; title: ReactNode; note?: ReactNode }) {
  const { width, d } = dotPath(no);
  return (
    <div className="sheet-head">
      <span className="dm sheet-no" aria-hidden="true">
        <svg viewBox={`0 0 ${width} ${ROWS}`} style={{ aspectRatio: `${width} / ${ROWS}` }} focusable="false">
          <path d={d} fill="currentColor" />
        </svg>
      </span>
      <h2 id={id}>{title}</h2>
      {note ? <span className="note">{note}</span> : null}
    </div>
  );
}
