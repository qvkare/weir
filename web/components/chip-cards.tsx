import type { ReactNode } from "react";
import type { Chip } from "@/lib/hardware.ts";
import { DotText } from "./dot-text.tsx";

// The chip cards (DESIGN section 6.1): one per chip, each with its market's last print and a link to it.
// Each package is drawn from above, as an illustration: the die, and its memory stacks only
// where a source gives their number (lib/hardware.ts). Not to scale; no maker's marks.

function Package({ chip }: { chip: Chip }) {
  const cx = 150;
  const cy = 86;
  const parts: ReactNode[] = [];
  if (chip.stacks === 5) {
    // Three stacks on one side of the die, two on the other.
    for (const [x, y] of [[-52, -44], [-52, -13], [-52, 18], [32, -30], [32, 2]] as const) {
      parts.push(
        <g key={`${x}${y}`}>
          <rect x={cx + x} y={cy + y} width={20} height={26} className="hbm" />
          {[1, 2, 3].map((k) => (
            <path key={k} d={`M${cx + x + 2} ${cy + y + (k * 26) / 4}H${cx + x + 18}`} className="layer" />
          ))}
        </g>,
      );
    }
  } else {
    // Memory drawn as two blocks: where it sits, not how many stacks.
    parts.push(<rect key="m1" x={cx - 54} y={cy - 46} width={22} height={92} rx={1} className="mem" />);
    parts.push(<rect key="m2" x={cx + 32} y={cy - 46} width={22} height={92} rx={1} className="mem" />);
  }
  return (
    <svg className="pkg" viewBox="0 0 300 172" aria-hidden="true" focusable="false">
      <rect x={cx - 64} y={cy - 64} width={128} height={128} rx={3} className="body" />
      <rect x={cx - 64} y={cy - 64} width={128} height={128} rx={3} className="grain" />
      <path d={`M${cx - 64} ${cy - 50}L${cx - 50} ${cy - 64}`} stroke="var(--ink)" strokeWidth={0.9} />
      {parts}
      <rect x={cx - 26} y={cy - 40} width={52} height={80} className="die" />
      <path d={`M${cx - 26 + 52 / 3} ${cy - 40}V${cy + 40}M${cx - 26 + 104 / 3} ${cy - 40}V${cy + 40}M${cx - 26} ${cy}H${cx + 26}`} stroke="var(--sheet)" strokeWidth={0.5} opacity={0.5} />
    </svg>
  );
}

export interface ChipCardData {
  chip: Chip;
  /** The market shown for the chip, and where its card links. */
  href: string | null;
  /** "Trading", "Model" or "Not deployed". */
  status: string;
  live: boolean;
  /** The market's last print, or why there is none. */
  last: ReactNode;
  current: boolean;
}

export function ChipCards({ cards }: { cards: ChipCardData[] }) {
  return (
    <div className="chips-grid">
      {cards.map(({ chip: c, href, status, live, last, current }) => (
        <article key={c.id} className={`chip-card${current ? " current" : ""}`} aria-label={`${c.model}: ${status}`}>
          <div className="top">
            <span>{current ? "Showing" : "Specimen"}</span>
            <span className={`status${live ? " live" : ""}`}>
              <i aria-hidden="true" />
              {status}
            </span>
          </div>
          <Package chip={c} />
          <DotText text={c.name} className="name" />
          <dl className="kv spec">
            <dt>Item</dt>
            <dd>{c.model}</dd>
            <dt>Memory</dt>
            <dd>{c.memory}</dd>
            <dt>Bandwidth</dt>
            <dd>{c.bandwidth}</dd>
            {c.die ? (
              <>
                <dt>Die</dt>
                <dd>{c.die}</dd>
              </>
            ) : null}
            <dt>Power</dt>
            <dd>{c.power}</dd>
            <dt>Last print</dt>
            <dd>{last}</dd>
          </dl>
          {href ? (
            <a className="chip-link" href={href} aria-current={current ? "page" : undefined}>
              {current ? `This is the ${c.name} market` : `Open the ${c.name} market`} <span aria-hidden="true">&rarr;</span>
            </a>
          ) : null}
        </article>
      ))}
    </div>
  );
}
