"use client";
import { fmtUtc } from "@/lib/format.ts";
import { timelineGeometry, type SeriesTimes } from "@/lib/timeline.ts";
import { ChartFrame } from "./chart-frame.tsx";

/** One series' life on one axis. Horizontal from 560 px, vertical below it with time running down. */
export function SeriesStrip({ times, now, round, summary }: { times: SeriesTimes; now: number; round: number | null; summary: string }) {
  return (
    <ChartFrame
      label={summary}
      render={(width) => (width < 560 ? <Vertical times={times} now={now} round={round} width={width} /> : <Horizontal times={times} now={now} round={round} width={width} />)}
    />
  );
}

const HATCH = (id: string) => (
  <defs>
    <pattern id={id} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="4" height="4" fill="var(--paper)" />
      <line x1="0" y1="0" x2="0" y2="4" stroke="var(--ink-2)" strokeWidth="1.5" />
    </pattern>
  </defs>
);

function Horizontal({ times, now, round, width }: { times: SeriesTimes; now: number; round: number | null; width: number }) {
  const x0 = 8;
  const len = width - 16;
  const g = timelineGeometry(times, now, len, round);
  const id = `hatch-h-${times.series}`;
  const height = 150;
  const lane = { auction: 26, delivery: 64 };
  // Alternate mark labels above and below to keep them apart.
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true">
      {HATCH(id)}
      <text x={x0} y={lane.auction - 8}>
        Auction rounds{g.dense ? " (each a commit then a reveal)" : ""}
      </text>
      {g.dense ? (
        <>
          <rect x={x0 + g.auction.a} y={lane.auction} width={g.auction.b - g.auction.a} height={16} fill={`url(#${id})`} stroke="var(--ink)" strokeWidth={1} />
        </>
      ) : (
        g.blocks.map((b) => (
          <g key={b.round}>
            <rect x={x0 + b.a} y={lane.auction} width={Math.max(0.5, b.mid - b.a)} height={16} fill="var(--ink)" />
            <rect x={x0 + b.mid} y={lane.auction} width={Math.max(0.5, b.b - b.mid)} height={16} fill={`url(#${id})`} stroke="var(--ink)" strokeWidth={0.5} />
          </g>
        ))
      )}
      {g.blocks
        .filter((b) => b.current)
        .map((b) => (
          <rect key="cur" x={x0 + b.a - 2} y={lane.auction - 3} width={b.b - b.a + 4} height={22} fill="none" stroke="var(--long)" strokeWidth={2} />
        ))}
      <text x={x0 + g.delivery.a} y={lane.delivery - 8}>
        Delivery
      </text>
      <rect x={x0 + g.delivery.a} y={lane.delivery} width={g.delivery.b - g.delivery.a} height={16} fill="var(--panel)" stroke="var(--ink)" strokeWidth={1} />
      <line className="axis" x1={x0} x2={x0 + len} y1={lane.delivery + 30} y2={lane.delivery + 30} />
      {placeLabels(g.marks.map((m) => ({ pos: m.pos, text: `${m.label} ${fmtUtc(m.at).replace(" UTC", "")}` })), len).map((l, i) => (
        <g key={g.marks[i]!.kind}>
          <line x1={x0 + l.pos} x2={x0 + l.pos} y1={lane.delivery + 26} y2={lane.delivery + 34 + (l.row ? l.row * 14 : 0)} stroke="var(--ink)" strokeWidth={l.row ? 0.5 : 1} />
          <text x={x0 + l.x} y={lane.delivery + 48 + l.row * 14} style={{ fontSize: 12 }}>
            {l.text}
          </text>
        </g>
      ))}
      {g.now.inside ? (
        <g>
          <line x1={x0 + g.now.pos} x2={x0 + g.now.pos} y1={4} y2={lane.delivery + 34} stroke="var(--long)" strokeWidth={2} />
          <text className="long" x={x0 + g.now.pos + 4} y={12}>
            now
          </text>
        </g>
      ) : null}
    </svg>
  );
}

function Vertical({ times, now, round, width }: { times: SeriesTimes; now: number; round: number | null; width: number }) {
  const y0 = 16;
  const len = 300;
  const g = timelineGeometry(times, now, len, round);
  const id = `hatch-v-${times.series}`;
  const height = len + 48;
  const col = { auction: 8, delivery: 34, axis: 66 };
  // Labels at least 15 px apart, in time order.
  const labelY: number[] = [];
  g.marks.forEach((m, i) => labelY.push(Math.max(y0 + m.pos + 4, i ? labelY[i - 1]! + 15 : 0)));
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true">
      {HATCH(id)}
      {g.dense ? (
        <rect x={col.auction} y={y0 + g.auction.a} width={18} height={g.auction.b - g.auction.a} fill={`url(#${id})`} stroke="var(--ink)" />
      ) : (
        g.blocks.map((b) => (
          <g key={b.round}>
            <rect x={col.auction} y={y0 + b.a} width={18} height={Math.max(0.5, b.mid - b.a)} fill="var(--ink)" />
            <rect x={col.auction} y={y0 + b.mid} width={18} height={Math.max(0.5, b.b - b.mid)} fill={`url(#${id})`} stroke="var(--ink)" strokeWidth={0.5} />
          </g>
        ))
      )}
      <rect x={col.delivery} y={y0 + g.delivery.a} width={18} height={g.delivery.b - g.delivery.a} fill="var(--panel)" stroke="var(--ink)" />
      <line className="axis" x1={col.axis} x2={col.axis} y1={y0} y2={y0 + len} />
      {g.marks.map((m, i) => (
        <g key={m.kind}>
          <line x1={col.axis - 4} x2={col.axis + 4} y1={y0 + m.pos} y2={y0 + m.pos} stroke="var(--ink)" />
          <text x={col.axis + 10} y={labelY[i]} style={{ fontSize: 12 }}>
            {m.label} {fmtUtc(m.at).replace(" UTC", "")}
          </text>
        </g>
      ))}
      {g.now.inside ? (
        <g>
          <line x1={2} x2={width - 4} y1={y0 + g.now.pos} y2={y0 + g.now.pos} stroke="var(--long)" strokeWidth={2} strokeDasharray="6 3" />
          <text className="long" x={width - 6} y={y0 + g.now.pos - 4} textAnchor="end">
            now
          </text>
        </g>
      ) : null}
    </svg>
  );
}

/** Puts each label on the first row where it does not overlap, kept inside the axis. */
function placeLabels(items: { pos: number; text: string }[], len: number): { pos: number; text: string; x: number; row: number }[] {
  const ends: number[] = [];
  return items.map((it) => {
    const w = it.text.length * 6.3;
    const x = Math.min(Math.max(it.pos - w / 2, 0), Math.max(0, len - w));
    let row = 0;
    while (ends[row] !== undefined && ends[row]! + 10 > x) row++;
    ends[row] = x + w;
    return { ...it, x, row };
  });
}
