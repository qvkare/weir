"use client";
import { dollarsOfPrice } from "@/lib/format.ts";
import { indexChartGeometry, type IndexChartInput } from "@/lib/index-chart.ts";
import { ChartFrame } from "./chart-frame.tsx";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function tickLabel(t: number, span: number): string {
  const d = new Date(t * 1000);
  const hm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  if (span <= 2 * 86_400) return hm;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export function IndexChart({ input, tick, summary }: { input: Omit<IndexChartInput, "width" | "height">; tick: number; summary: string }) {
  return (
    <ChartFrame
      label={summary}
      render={(width) => {
        const height = width < 560 ? 240 : 300;
        const g = indexChartGeometry({ ...input, width, height });
        const span = input.to - input.from;
        return (
          <>
          <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true">
            {g.band ? (
              <g>
                <rect x={g.band.x} y={g.band.y} width={g.band.w} height={g.band.h} fill="var(--panel)" />
                <text x={g.band.x + g.band.w - 4} y={g.band.y + 14} textAnchor="end">
                  {g.endLabels && g.band.w > 170 ? "Band, series in delivery" : "Band"}
                </text>
                {g.band.avgY !== null ? (
                  <>
                    <line x1={g.band.x} x2={g.band.x + g.band.w} y1={g.band.avgY} y2={g.band.avgY} stroke="var(--ink)" strokeWidth={1.5} strokeDasharray="5 4" />
                    <text className="ink" x={g.band.x + 4} y={g.band.y + g.band.h - 6}>
                      {g.endLabels ? "Average so far " : "Avg "}
                      {dollarsOfPrice(g.band.average, tick)}
                    </text>
                  </>
                ) : null}
              </g>
            ) : null}
            {g.yTicks.map((t) => (
              <g key={t.price}>
                <line className="grid" x1={g.plot.x0} x2={g.plot.x1} y1={t.y} y2={t.y} />
                <text x={g.plot.x0 - 6} y={t.y + 4} textAnchor="end">
                  {dollarsOfPrice(t.price, tick)}
                </text>
              </g>
            ))}
            <line className="axis" x1={g.plot.x0} x2={g.plot.x1} y1={g.plot.y1} y2={g.plot.y1} />
            {g.xTicks.map((t) => (
              <text key={t.t} x={t.x} y={g.plot.y1 + 16} textAnchor="middle">
                {tickLabel(t.t, span)}
              </text>
            ))}
            {g.reporters.map((r) => (
              <g key={r.reporter}>
                <path d={r.path} fill="none" stroke="var(--ink-3)" strokeWidth={1} />
                {g.endLabels && r.labelY !== null ? (
                  <text x={g.plot.x1 + 6} y={r.labelY + 4} style={{ fontSize: 11 }}>
                    {r.reporter.split(".")[0]}
                  </text>
                ) : null}
              </g>
            ))}
            <path d={g.index} fill="none" stroke="var(--ink)" strokeWidth={2} />
            {g.last ? <circle cx={g.last.x} cy={g.last.y} r={3.5} fill="var(--ink)" /> : null}
            {g.index === "" ? (
              <text x={(g.plot.x0 + g.plot.x1) / 2} y={(g.plot.y0 + g.plot.y1) / 2} textAnchor="middle" className="ink">
                No final prints in this window
              </text>
            ) : null}
          </svg>
          {!g.endLabels && g.reporters.length ? (
            <p className="tiny muted" style={{ marginTop: 4 }}>
              Thin lines: {g.reporters.map((r) => r.reporter).join(", ")}
            </p>
          ) : null}
          </>
        );
      }}
    />
  );
}

