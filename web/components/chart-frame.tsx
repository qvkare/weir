"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Draws a chart at the container's real width. Before the browser measures (and with scripts
 * off) it shows two server drawings, at 375 and 1200 px, one per breakpoint.
 *
 * Motion: the first time the chart comes into view its lines (`path.curve`) draw themselves
 * once, and labels marked `.fade-in` follow. Never again after that, and never under
 * prefers-reduced-motion.
 */
export function ChartFrame({ render, label, minWidth = 300 }: { render: (width: number) => ReactNode; label: string; minWidth?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [draw, setDraw] = useState<"pending" | "in" | undefined>(undefined);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(minWidth, Math.floor(el.getBoundingClientRect().width)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [minWidth]);
  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // A chart already above the fold and in view at load is part of the first paint: leave it drawn.
    const r = el.getBoundingClientRect();
    if (r.top < window.innerHeight && r.bottom > 0 && performance.now() < 1500) return;
    setDraw("pending");
    let raf = 0;
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          io.disconnect();
          raf = requestAnimationFrame(() => requestAnimationFrame(() => setDraw("in")));
        }
      },
      { threshold: 0.25 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);
  return (
    <div ref={ref} className="chart" role="figure" aria-label={label} data-draw={draw}>
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
