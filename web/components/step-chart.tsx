"use client";
import { useMemo, useState } from "react";
import { dollarsOfPrice, fmtGpuH, fmtInt, fmtPrice } from "@/lib/format.ts";
import { curveLabels, stepGeometry, stepSummary, type Seg, type StepOrder } from "@/lib/step.ts";
import { ChartFrame } from "./chart-frame.tsx";

export interface StepChartProps {
  orders: StepOrder[];
  band: number;
  floor: number | null;
  tick: number;
  price: number | null;
  volume: number;
  cleared: boolean;
  height?: number;
  /** Small version for the home page: fewer labels. */
  compact?: boolean;
  /** Draw the curves in once (400 ms) when the chart first shows a clearing. */
  animate?: boolean;
}

const path = (segs: Seg[]) => segs.map((s) => `M${s.x1.toFixed(1)},${s.y1.toFixed(1)}L${s.x2.toFixed(1)},${s.y2.toFixed(1)}`).join("");

export function StepChart(props: StepChartProps) {
  const [picked, setPicked] = useState<number | null>(null);
  const height = props.height ?? (props.compact ? 220 : 380);
  const summary = stepSummary(props);
  const pickedStep = props.orders.find((o) => o.seq === picked) ?? null;

  const render = (width: number) => <StepSvg {...props} width={width} height={width < 560 ? Math.min(height, 280) : height} picked={picked} onPick={setPicked} />;

  return (
    <div>
      <ChartFrame render={render} label={summary} />
      <p className="readout small" aria-live="polite">
        {pickedStep ? (
          <>
            <span className={pickedStep.side === "Long" ? "side-long" : "side-short"}>{pickedStep.side === "Long" ? "LONG" : "SHORT"}</span> seq {pickedStep.seq}, {pickedStep.owner}: {fmtGpuH(pickedStep.size)} at a limit of {fmtPrice(pickedStep.price, props.tick)}
            {props.cleared ? `, filled ${fmtInt(pickedStep.filled ?? 0)}` : ""}
          </>
        ) : (
          <span className="muted">{props.orders.length ? "Point at or tap a step for its order." : ""}</span>
        )}
      </p>
    </div>
  );
}

function StepSvg({ width, height, picked, onPick, ...p }: StepChartProps & { width: number; height: number; picked: number | null; onPick: (seq: number | null) => void }) {
  const g = useMemo(() => stepGeometry({ orders: p.orders, band: p.band, price: p.price, volume: p.volume, cleared: p.cleared, width, height }), [p.orders, p.band, p.price, p.volume, p.cleared, width, height]);
  const narrow = width < 560;
  const labels = curveLabels(g);
  const anim = p.animate && g.clearing ? "draw-in" : undefined;
  const thin = (segs: Seg[]) => path(segs);
  const thick = (segs: Seg[]) => path(segs.filter((s) => s.filled));
  const label = g.clearing ? `Clears at ${dollarsOfPrice(g.clearing.price, p.tick)}${p.floor !== null ? ` · forward ${dollarsOfPrice(p.floor + g.clearing.price, p.tick)}` : ""}` : null;
  const labelAbove = g.clearing ? g.clearing.y - g.plot.y0 > 24 : true;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true" className={anim}>
      {g.clearing ? (
        <>
          <rect x={g.clearing.longRect.x} y={g.clearing.longRect.y} width={Math.max(0, g.clearing.longRect.w)} height={Math.max(0, g.clearing.longRect.h)} fill="var(--long-soft)" />
          <rect x={g.clearing.shortRect.x} y={g.clearing.shortRect.y} width={Math.max(0, g.clearing.shortRect.w)} height={Math.max(0, g.clearing.shortRect.h)} fill="var(--short-soft)" />
        </>
      ) : null}
      {g.yTicks.map((t) => (
        <g key={t.price}>
          <line className="grid" x1={g.plot.x0} x2={g.plot.x1} y1={t.y} y2={t.y} />
          <text x={g.plot.x0 - 6} y={t.y + 4} textAnchor="end">
            {dollarsOfPrice(t.price, p.tick)}
          </text>
          {p.floor !== null ? (
            <text x={g.plot.x1 + 6} y={t.y + 4}>
              {dollarsOfPrice(p.floor + t.price, p.tick)}
            </text>
          ) : null}
        </g>
      ))}
      <line className="axis" x1={g.plot.x0} x2={g.plot.x1} y1={g.plot.y1} y2={g.plot.y1} />
      {g.xTicks.map((t) => (
        <text key={t.units} x={t.x} y={g.plot.y1 + 16} textAnchor="middle">
          {fmtInt(t.units)}
        </text>
      ))}
      {p.compact && narrow ? null : (
        <>
          <text x={g.plot.x0 - 6} y={g.plot.y0 - 12} textAnchor="end">
            LONG price
          </text>
          {p.floor !== null ? (
            <text x={g.plot.x1 + 6} y={g.plot.y0 - 12}>
              Forward
            </text>
          ) : null}
          <text x={g.plot.x1} y={g.plot.y1 + 30} textAnchor="end">
            GPU-hours
          </text>
        </>
      )}

      <g fill="none" strokeLinecap="square">
        <path className="curve" pathLength={1} d={thin(g.demand)} stroke="var(--long)" strokeWidth={1} strokeOpacity={0.5} />
        <path className="curve" pathLength={1} d={thin(g.supply)} stroke="var(--short)" strokeWidth={1} strokeOpacity={0.5} />
        <path className="curve" pathLength={1} d={thick(g.demand)} stroke="var(--long)" strokeWidth={3} />
        <path className="curve" pathLength={1} d={thick(g.supply)} stroke="var(--short)" strokeWidth={3} />
      </g>
      {g.steps
        .filter((s) => s.partAt !== null)
        .map((s) => (
          <line key={`part-${s.seq}`} x1={s.partAt!} x2={s.partAt!} y1={s.y - 6} y2={s.y + 6} stroke={s.side === "Long" ? "var(--long)" : "var(--short)"} strokeWidth={2} />
        ))}

      {g.clearing ? (
        <>
          <line className="fade-in" x1={g.plot.x0} x2={g.plot.x1} y1={g.clearing.y} y2={g.clearing.y} stroke="var(--ink)" strokeWidth={2} />
          <line className="fade-in" x1={g.clearing.x} x2={g.clearing.x} y1={g.plot.y0} y2={g.plot.y1} stroke="var(--ink)" strokeWidth={1} strokeDasharray="4 3" />
          <text className="ink fade-in" x={g.plot.x1 - 4} y={labelAbove ? g.clearing.y - 7 : g.clearing.y + 17} textAnchor="end">
            {label}
          </text>
          <text className="ink" x={Math.min(g.clearing.x + 5, g.plot.x1 - 4)} y={g.plot.y1 - 6} textAnchor={g.clearing.x > g.plot.x1 - 90 ? "end" : "start"}>
            {fmtInt(g.clearing.volume)} GPU-h
          </text>
        </>
      ) : null}

      {!p.compact || !narrow ? (
        <>
          {labels.demand ? (
            <text className="long" x={labels.demand.x} y={labels.demand.y}>
              Demand (LONG)
            </text>
          ) : null}
          {labels.supply ? (
            <text className="short" x={labels.supply.x} y={labels.supply.y}>
              Supply (SHORT)
            </text>
          ) : null}
        </>
      ) : null}

      {g.noClearing && g.noClearing !== "not cleared" ? (
        <text x={(g.plot.x0 + g.plot.x1) / 2} y={(g.plot.y0 + g.plot.y1) / 2} textAnchor="middle" className="ink">
          {g.noClearing === "no orders" ? "No revealed orders" : g.noClearing === "one side only" ? "Orders on one side only: no trade" : "The curves do not cross: no trade"}
        </text>
      ) : null}

      {g.steps.map((s) => (
        <rect
          key={`hit-${s.side}-${s.seq}`}
          x={s.x1}
          y={s.y - 10}
          width={Math.max(4, s.x2 - s.x1)}
          height={20}
          fill="transparent"
          stroke={picked === s.seq ? "var(--ink)" : "none"}
          strokeDasharray="2 2"
          onPointerEnter={() => onPick(s.seq)}
          onClick={() => onPick(s.seq)}
          style={{ cursor: "pointer" }}
        />
      ))}
    </svg>
  );
}
