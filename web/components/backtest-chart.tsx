"use client";
import { backtestGeometry, type BacktestWeek } from "@/lib/backtest.ts";
import { ChartFrame } from "./chart-frame.tsx";

/** Each week a band rectangle, the unhedged average as dots joined thinly, the hedged price as a tick. */
export function BacktestChart({ weeks, summary }: { weeks: BacktestWeek[]; summary: string }) {
  return (
    <ChartFrame
      label={summary}
      render={(width) => {
        const height = width < 560 ? 260 : 360;
        const g = backtestGeometry(weeks, width, height);
        const line = g.weeks.map((w, i) => `${i ? "L" : "M"}${(w.x + w.w / 2).toFixed(1)},${w.unhedgedY.toFixed(1)}`).join("");
        return (
          <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true">
            {g.yTicks.map((t) => (
              <g key={t.label}>
                <line className="grid" x1={g.plot.x0} x2={g.plot.x1} y1={t.y} y2={t.y} />
                <text x={g.plot.x0 - 6} y={t.y + 4} textAnchor="end">
                  {t.label}
                </text>
              </g>
            ))}
            {g.weeks.map((w) => (
              <rect key={`b${w.week.start}`} x={w.x} y={w.band.y0} width={w.w} height={Math.max(1, w.band.y1 - w.band.y0)} fill="var(--panel)" stroke="var(--rule)" strokeWidth={0.5} />
            ))}
            <path className="curve" pathLength={1} d={line} fill="none" stroke="var(--ink)" strokeWidth={0.75} strokeOpacity={0.6} />
            {g.weeks.map((w) => (
              <g key={`w${w.week.start}`}>
                <line x1={w.x - 1} x2={w.x + w.w + 1} y1={w.hedgedY} y2={w.hedgedY} stroke="var(--long)" strokeWidth={2.5} />
                <circle cx={w.x + w.w / 2} cy={w.unhedgedY} r={width < 560 ? 2 : 2.75} fill="var(--ink)" />
                {!w.week.inside ? (
                  <g>
                    <path d={`M${w.x + w.w / 2},${g.plot.y1 + 4} l-5,8 h10 Z`} fill="var(--flag)" />
                  </g>
                ) : null}
                <title>{`${w.week.label}: unhedged $${w.week.unhedged.toFixed(3)}, hedged $${w.week.hedged.toFixed(3)}, band $${w.week.floor.toFixed(3)} to $${w.week.cap.toFixed(3)}${w.week.inside ? "" : ", average outside the band"}`}</title>
              </g>
            ))}
            <line className="axis" x1={g.plot.x0} x2={g.plot.x1} y1={g.plot.y1} y2={g.plot.y1} />
            {g.xLabels.map((l) => (
              <text key={l.label} x={l.x} y={g.plot.y1 + 28} textAnchor="middle">
                {l.label}
              </text>
            ))}
            <text x={g.plot.x0 - 6} y={g.plot.y0 - 2} textAnchor="end" style={{ fontSize: 11 }}>
              USD /GPU-h
            </text>
          </svg>
        );
      }}
    />
  );
}
