"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Draws a chart at the container's real width. Before the browser measures (and with scripts
 * off) it shows two server drawings, at 375 and 1200 px, one per breakpoint.
 */
export function ChartFrame({ render, label, minWidth = 300 }: { render: (width: number) => ReactNode; label: string; minWidth?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(minWidth, Math.floor(el.getBoundingClientRect().width)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [minWidth]);
  return (
    <div ref={ref} className="chart" role="figure" aria-label={label}>
      {width ? (
        render(width)
      ) : (
        <>
          <div className="chart-at-375">{render(375)}</div>
          <div className="chart-at-1200">{render(1200)}</div>
        </>
      )}
    </div>
  );
}
