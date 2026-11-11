"use client";
import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { dollarsOfPrice, fmtGpuH, fmtPrice, fmtUsd } from "@/lib/format.ts";
import { fixingFromX, hedgeSize, parseGpuHours, payoffAt, payoffGeometry, stepFixing, type HedgeSide } from "@/lib/payoff.ts";
import { ChartFrame } from "./chart-frame.tsx";

export interface PayoffSizerProps {
  floor: number;
  band: number;
  tick: number;
  /** LONG price the figures use. */
  p: number;
  /** Where p came from, said in words beside the figures. */
  pSource: string;
  maxOrderSize: number;
  series: number;
}

const DEFAULT_HOURS = 1344; // 8 GPUs x 168 h

export function PayoffSizer(props: PayoffSizerProps) {
  const { floor, band, tick, p } = props;
  const [side, setSide] = useState<HedgeSide>("Long");
  const [fixing, setFixing] = useState(floor + Math.round(band * 0.75 / tick) * tick);
  const [hoursText, setHoursText] = useState(DEFAULT_HOURS.toLocaleString("en-US"));
  const hours = parseGpuHours(hoursText, props.maxOrderSize);
  const size = hours === null ? null : hedgeSize(hours, side, floor, band, p);
  const at = payoffAt(side, fixing, floor, band, p);
  const id = useId();
  const buyer = side === "Long";
  const inside = fixing >= floor && fixing <= floor + band;
  const perHour = (v: number) => dollarsOfPrice(v, tick);
  const total = (perUnit: number) => (hours === null ? null : fmtUsd(BigInt(Math.round(perUnit)) * BigInt(hours)));

  return (
    <div className="grid-2 wide-left">
      <div>
        <ChartFrame label={`Payoff per GPU-hour for a ${buyer ? "buyer holding LONG" : "seller holding SHORT"} bought at ${fmtPrice(p, tick)}. Inside the band from ${fmtPrice(floor, tick)} to ${fmtPrice(floor + band, tick)} the ${buyer ? "cost" : "revenue"} is fixed at ${fmtPrice(floor + p, tick)}. Outside it the hedge stops.`} render={(w) => <PayoffSvg {...props} side={side} fixing={fixing} width={w} height={w < 560 ? 240 : 320} onFixing={setFixing} />} />
        <div className="legend" aria-hidden="true">
          <span className="key">
            <span className="swatch thin" style={{ color: "var(--ink)" }} /> Unhedged: the fixing
          </span>
          <span className="key">
            <span className="swatch" style={{ color: buyer ? "var(--long)" : "var(--short)" }} /> Hedged with {buyer ? "LONG" : "SHORT"}
          </span>
          <span className="key">
            <span className="swatch box" style={{ color: "var(--panel)" }} /> Band
          </span>
        </div>
        <dl className="kv" style={{ marginTop: 16 }} aria-live="polite">
          <dt>Fixing (week&rsquo;s average)</dt>
          <dd>
            <b>{fmtPrice(fixing, tick)}</b> {inside ? <span className="muted">inside the band</span> : <span className="flag">outside the band: the hedge stops</span>}
          </dd>
          <dt>Unhedged {buyer ? "cost" : "revenue"}</dt>
          <dd>{fmtPrice(at.unhedged, tick)}</dd>
          <dt>{buyer ? "LONG" : "SHORT"} payout</dt>
          <dd>{fmtPrice(at.payout, tick)}</dd>
          <dt>Hedged {buyer ? "cost" : "revenue"}</dt>
          <dd>
            <b>{fmtPrice(at.hedged, tick)}</b>
          </dd>
          <dt>Difference</dt>
          <dd>
            {at.difference === 0 ? "none" : `${at.difference > 0 ? "+" : "-"}${perHour(Math.abs(at.difference))} /GPU-h`}
            {at.difference !== 0 ? <span className="muted"> ({buyer ? (at.difference > 0 ? "the hedge cost you" : "the hedge saved you") : at.difference > 0 ? "the hedge earned you" : "the hedge cost you"})</span> : null}
          </dd>
        </dl>
        <p className="tiny muted" style={{ marginTop: 8 }}>
          Drag the handle, or focus it and use the arrow keys: one tick each, ten with Shift.
        </p>
      </div>

      <div className="stack">
        <div className="field">
          <span className="label" id={`${id}-side`}>
            Your side
          </span>
          <div className="switch side-toggle" role="group" aria-labelledby={`${id}-side`}>
            <button type="button" className="long-btn" aria-pressed={buyer} onClick={() => setSide("Long")}>
              Buyer (LONG)
            </button>
            <button type="button" className="short-btn" aria-pressed={!buyer} onClick={() => setSide("Short")}>
              Seller (SHORT)
            </button>
          </div>
        </div>
        <div className="field">
          <label htmlFor={`${id}-hours`}>GPU-hours you will {buyer ? "use" : "sell"} in the delivery week</label>
          <input
            id={`${id}-hours`}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={hoursText}
            onChange={(e) => setHoursText(e.target.value)}
            aria-invalid={hours === null}
            aria-describedby={`${id}-hours-hint`}
          />
          {hours === null ? (
            <span id={`${id}-hours-hint`} className="error-text">
              A whole number from 1 to {props.maxOrderSize.toLocaleString("en-US")} (max_order_size).
            </span>
          ) : (
            <span id={`${id}-hours-hint`} className="hint">
              8 GPUs for a week is 1,344.
            </span>
          )}
        </div>
        <table aria-live="polite">
          <caption>
            Series {props.series}, at {props.pSource}
          </caption>
          <tbody>
            <tr>
              <th scope="row">Units of {buyer ? "LONG" : "SHORT"}</th>
              <td className="num">{size ? fmtGpuH(size.units) : "no data"}</td>
            </tr>
            <tr>
              <th scope="row">Dollars locked</th>
              <td className="num">{size ? fmtUsd(size.locked) : "no data"}</td>
            </tr>
            <tr>
              <th scope="row">Most you can lose</th>
              <td className="num">{size ? fmtUsd(size.maxLoss) : "no data"}</td>
            </tr>
            <tr className="ink">
              <th scope="row">Your price inside the band</th>
              <td className="num">{size ? fmtPrice(size.effective, tick) : "no data"}</td>
            </tr>
            <tr>
              <th scope="row">At this fixing, for all hours</th>
              <td className="num">{total(at.hedged) ?? "no data"}</td>
            </tr>
          </tbody>
        </table>
        <p className="small muted">
          The band runs from {fmtPrice(floor, tick)} to {fmtPrice(floor + band, tick)}. Beyond it you pay or receive the market price again, shifted by the fixed amount. Position bonuses from forfeits are left out.
        </p>
      </div>
    </div>
  );
}

function PayoffSvg(p: PayoffSizerProps & { side: HedgeSide; fixing: number; width: number; height: number; onFixing: (f: number) => void }) {
  const g = payoffGeometry({ side: p.side, floor: p.floor, band: p.band, p: p.p, fixing: p.fixing, width: p.width, height: p.height });
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef(false);
  const colour = p.side === "Long" ? "var(--long)" : "var(--short)";
  const toX = (e: PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    return ((e.clientX - r.left) / r.width) * p.width;
  };
  const onDown = (e: PointerEvent<SVGSVGElement>) => {
    dragging.current = true;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    p.onFixing(fixingFromX(toX(e), g, p.tick));
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (dragging.current) p.onFixing(fixingFromX(toX(e), g, p.tick));
  };
  const onKey = (e: KeyboardEvent) => {
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = stepFixing(p.fixing, 1, e.shiftKey, p.tick, p.floor, p.band);
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = stepFixing(p.fixing, -1, e.shiftKey, p.tick, p.floor, p.band);
    if (e.key === "Home") next = g.domain.lo;
    if (e.key === "End") next = g.domain.hi;
    if (e.key === "PageUp") next = stepFixing(p.fixing, 1, true, p.tick, p.floor, p.band);
    if (e.key === "PageDown") next = stepFixing(p.fixing, -1, true, p.tick, p.floor, p.band);
    if (next !== null) {
      e.preventDefault();
      p.onFixing(next);
    }
  };
  const h = payoffAt(p.side, p.fixing, p.floor, p.band, p.p);
  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${p.width} ${p.height}`}
      width={p.width}
      height={p.height}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={() => (dragging.current = false)}
      onPointerCancel={() => (dragging.current = false)}
      style={{ touchAction: "none", userSelect: "none" }}
    >
      <rect x={g.band.x1} y={g.plot.y0} width={g.band.x2 - g.band.x1} height={g.plot.y1 - g.plot.y0} fill="var(--panel)" />
      {g.yTicks.map((t) => (
        <g key={t.value}>
          <line className="grid" x1={g.plot.x0} x2={g.plot.x1} y1={t.y} y2={t.y} />
          <text x={g.plot.x0 - 6} y={t.y + 4} textAnchor="end">
            {dollarsOfPrice(t.value, p.tick)}
          </text>
        </g>
      ))}
      <line className="axis" x1={g.plot.x0} x2={g.plot.x1} y1={g.plot.y1} y2={g.plot.y1} />
      {g.xTicks.map((t) => (
        <text key={t.value} x={t.x} y={g.plot.y1 + 16} textAnchor="middle">
          {dollarsOfPrice(t.value, p.tick)}
        </text>
      ))}
      <text x={g.plot.x1} y={g.plot.y1 + 30} textAnchor="end">
        Fixing, USD per GPU-hour
      </text>
      <text x={(g.band.x1 + g.band.x2) / 2} y={g.plot.y0 + 14} textAnchor="middle">
        Band
      </text>
      <polyline className="curve" pathLength={1} points={g.unhedged} fill="none" stroke="var(--ink)" strokeWidth={1} />
      <polyline className="curve" pathLength={1} points={g.hedged} fill="none" stroke={colour} strokeWidth={3} strokeLinejoin="round" />
      <g
        role="slider"
        tabIndex={0}
        aria-label="Fixing"
        aria-valuemin={g.domain.lo / 1e6}
        aria-valuemax={g.domain.hi / 1e6}
        aria-valuenow={p.fixing / 1e6}
        aria-valuetext={`Fixing ${fmtPrice(p.fixing, p.tick)}; hedged ${fmtPrice(h.hedged, p.tick)}, unhedged ${fmtPrice(h.unhedged, p.tick)}`}
        onKeyDown={onKey}
        style={{ cursor: "ew-resize", outline: "none" }}
        className="handle"
      >
        <rect x={g.handle.x - 22} y={g.plot.y0} width={44} height={g.plot.y1 - g.plot.y0} fill="transparent" />
        <line x1={g.handle.x} x2={g.handle.x} y1={g.plot.y0} y2={g.plot.y1} stroke="var(--ink)" strokeWidth={1.5} />
        <circle cx={g.handle.x} cy={g.handle.yUnhedged} r={4} fill="var(--paper)" stroke="var(--ink)" strokeWidth={1.5} />
        <circle cx={g.handle.x} cy={g.handle.yHedged} r={6} fill={colour} stroke="var(--paper)" strokeWidth={1.5} />
        <rect x={g.handle.x - 9} y={g.plot.y1 - 22} width={18} height={18} rx={3} fill="var(--ink)" />
        <path d={`M${g.handle.x - 3},${g.plot.y1 - 16} l-3,3 l3,3 M${g.handle.x + 3},${g.plot.y1 - 16} l3,3 l-3,3`} stroke="var(--paper)" strokeWidth={1.5} fill="none" />
      </g>
    </svg>
  );
}
