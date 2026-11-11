"use client";
import type { CSSProperties } from "react";
import { dollarsOfPrice, fmtInt } from "@/lib/format.ts";
import { stepGeometry, type Seg, type StepOrder } from "@/lib/step.ts";

const DASH: CSSProperties = { strokeDasharray: 1 };
const path = (segs: Seg[]) => segs.map((s) => `M${s.x1.toFixed(1)},${s.y1.toFixed(1)}L${s.x2.toFixed(1)},${s.y2.toFixed(1)}`).join("");

/**
 * A cleared round drawn for motion: every part that a score animates carries `data-track`.
 * Used by the clearing drawing on /how. Supply is dashed and its paid area hatched, so the two
 * sides never rest on colour alone.
 */
export function ClearingChart({
  orders,
  band,
  price,
  volume,
  tick,
  width,
  payLabels = false,
  fillLabels = false,
}: {
  orders: StepOrder[];
  band: number;
  price: number;
  volume: number;
  tick: number;
  width: number | null;
  /** What each side paid, written inside the two tinted areas. */
  payLabels?: boolean;
  /** Each step labelled with its owner and fill. */
  fillLabels?: boolean;
}) {
  const film = { tick, band, price, volume };
  const w = width ?? 640;
  const h = w < 520 ? 230 : 290;
  const g = stepGeometry({ orders, band, price, volume, cleared: true, width: w, height: h });
  const c = g.clearing!;
  const lit = (segs: Seg[]) => path(segs.filter((s) => s.filled));
  const narrow = w < 520;
  const longFirst = g.steps.find((s) => s.side === "Long")!;
  const shortFirst = g.steps.find((s) => s.side === "Short")!;
  return (
    <svg className="film-chart" viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">
      <g data-track="soft" data-enter="" fillOpacity={0.65}>
        <rect x={c.longRect.x} y={c.longRect.y} width={c.longRect.w} height={c.longRect.h} fill="var(--long-soft)" />
        <rect x={c.shortRect.x} y={c.shortRect.y} width={c.shortRect.w} height={c.shortRect.h} fill="url(#hatch-short-soft)" />
      </g>
      <g data-track="axes">
        {g.yTicks.map((t) => (
          <g key={t.price}>
            <line className="grid" x1={g.plot.x0} x2={g.plot.x1} y1={t.y} y2={t.y} />
            <text x={g.plot.x0 - 8} y={t.y + 4} textAnchor="end">
              {/* The origin reads "0": a bare "$0.00" would look like a missing figure. */}
              {t.price === 0 ? "0" : dollarsOfPrice(t.price, film.tick)}
            </text>
          </g>
        ))}
        <line className="axis" x1={g.plot.x0} x2={g.plot.x1} y1={g.plot.y1} y2={g.plot.y1} />
        {g.xTicks.map((t) => (
          <text key={t.units} x={t.x} y={g.plot.y1 + 18} textAnchor="middle">
            {fmtInt(t.units)}
          </text>
        ))}
        <text x={narrow ? 0 : g.plot.x0 - 8} y={g.plot.y0 - 12} textAnchor={narrow ? "start" : "end"}>
          LONG price
        </text>
        <text x={g.plot.x1 + 8} y={g.plot.y1 + 4}>
          GPU-h
        </text>
      </g>
      <g fill="none" strokeLinecap="square" strokeLinejoin="miter">
        <path data-track="demand" d={path(g.demand)} pathLength={1} style={DASH} stroke="var(--long)" strokeWidth={1.5} strokeOpacity={0.55} />
        <path data-track="supply" d={path(g.supply)} pathLength={1} style={DASH} stroke="var(--short)" strokeWidth={1.5} strokeOpacity={0.55} />
        <g data-track="lit" data-enter="">
          <path d={lit(g.demand)} stroke="var(--long)" strokeWidth={4} />
          <path d={lit(g.supply)} stroke="var(--short)" strokeWidth={4} strokeDasharray="7 3" strokeLinecap="butt" />
          {g.steps
            .filter((s) => s.partAt !== null)
            .map((s) => (
              <line key={s.seq} x1={s.partAt!} x2={s.partAt!} y1={s.y - 7} y2={s.y + 7} stroke={s.side === "Long" ? "var(--long)" : "var(--short)"} strokeWidth={2} />
            ))}
        </g>
      </g>
      <text data-track="demand-label" data-enter="" display={fillLabels ? "none" : undefined} className="long" x={longFirst.x1 + 6} y={longFirst.y - 8}>
        Demand, LONG
      </text>
      <text data-track="supply-label" data-enter="" display={fillLabels ? "none" : undefined} className="short" x={shortFirst.x1 + 6} y={shortFirst.y + 18}>
        Supply, SHORT
      </text>
      <path data-track="price" d={`M${g.plot.x0},${c.y}H${g.plot.x1}`} pathLength={1} style={DASH} stroke="var(--ink)" strokeWidth={2.5} fill="none" />
      <g data-track="volume" data-enter="">
        <line x1={c.x} x2={c.x} y1={c.y} y2={g.plot.y1} stroke="var(--ink)" strokeDasharray="3 3" />
        <text className="ink" x={c.x + 6} y={g.plot.y1 - 8}>
          {fmtInt(film.volume)} GPU-h
        </text>
      </g>
      <g data-track="price-label" data-enter="">
        <text x={g.plot.x1 + 8} y={c.y - 12}>
          {narrow ? "Price" : "One price"}
        </text>
        <text className="ink film-price" x={g.plot.x1 + 6} y={c.y + 5} style={narrow ? { fontSize: 13 } : undefined}>
          {dollarsOfPrice(film.price, film.tick)}
        </text>
      </g>
      {fillLabels ? (
        <g data-track="fills" data-enter="">
          {g.steps.map((s) => (
            <text key={s.seq} className={s.side === "Long" ? "long" : "short"} x={(s.x1 + s.x2) / 2} y={s.side === "Long" ? s.y - 8 : s.y + 18} textAnchor="middle">
              {s.owner} {s.filled === s.size ? `filled ${fmtInt(s.filled)}` : s.filled ? `${fmtInt(s.filled)} of ${fmtInt(s.size)}` : "out"}
            </text>
          ))}
        </g>
      ) : null}
      <g data-track="hold" data-enter="" className="film-hold" display={narrow || !payLabels ? "none" : undefined}>
        <text className="short" x={c.x - 8} y={g.plot.y0 + 16} textAnchor="end">
          SHORT pays {dollarsOfPrice(film.band - film.price, film.tick)}
        </text>
        <text className="long" x={c.x - 8} y={g.plot.y1 - 8} textAnchor="end">
          LONG pays {dollarsOfPrice(film.price, film.tick)}
        </text>
      </g>
      <circle data-track="cross" data-enter="" cx={c.x} cy={c.y} r={6} fill="var(--sheet)" stroke="var(--ink)" strokeWidth={2.5} />
    </svg>
  );
}
