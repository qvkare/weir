"use client";
// The homepage's landscape (ours): a dusk sky, rolling hills in three depths with haze between,
// and soft dunes in front. Drawn as separate SVG layers, no strokes, colours from app/site.css
// (slate to mauve at dusk in the dark theme, a pale morning in the light one). On scroll each
// layer moves at its own rate, the window sinks behind the dunes and the scene fades into the
// page. Transforms and opacity only; fail open: with no script, no animation frames, reduced
// motion or ?motion=reduce, the scene simply stands still.
import { useEffect, useRef, type ReactNode } from "react";

const V = { w: 1600, h: 900 };

/** One layer: a shape filled with a vertical gradient between two colour variables. */
function Layer({ id, d, top, bottom, className }: { id: string; d: string; top: string; bottom: string; className: string }) {
  return (
    <svg viewBox={`0 0 ${V.w} ${V.h}`} preserveAspectRatio="xMidYMax slice" className={className} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style={{ stopColor: `var(${top})` }} />
          <stop offset="100%" style={{ stopColor: `var(${bottom})` }} />
        </linearGradient>
      </defs>
      <path d={d} fill={`url(#${id})`} />
    </svg>
  );
}

// Hand-drawn hills on a 1600 x 900 canvas; the open middle leaves room for the window.
const FAR = "M0 250 C 120 220 240 222 350 262 C 520 330 640 430 800 450 C 960 430 1080 330 1250 268 C 1370 225 1480 220 1600 250 L1600 900 L0 900 Z";
const MID = "M0 330 C 90 290 200 282 300 312 C 420 360 500 480 560 620 C 590 690 600 780 600 900 L0 900 Z M1000 900 C 1000 780 1010 690 1040 620 C 1100 480 1180 370 1300 330 C 1400 300 1510 300 1600 330 L1600 900 Z";
const NEAR = "M0 440 C 80 410 170 410 250 445 C 330 490 390 600 420 760 C 430 810 432 860 432 900 L0 900 Z M1168 900 C 1168 860 1170 810 1180 760 C 1210 600 1270 490 1350 450 C 1430 410 1520 410 1600 440 L1600 900 Z";
const DUNE_BACK = "M0 772 C 200 735 380 745 560 785 C 740 825 900 830 1080 798 C 1260 766 1440 755 1600 776 L1600 900 L0 900 Z";
const DUNE_FRONT = "M0 838 C 160 812 320 815 480 842 C 640 870 820 878 1000 858 C 1180 838 1400 825 1600 846 L1600 900 L0 900 Z";

/** The foreground: two dunes, the nearer one darker, both fading into the page at the bottom. */
function Dunes({ id, className }: { id: string; className: string }) {
  return (
    <svg viewBox={`0 0 ${V.w} ${V.h}`} preserveAspectRatio="xMidYMax slice" className={className} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}-b`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style={{ stopColor: "var(--dune-1)" }} />
          <stop offset="100%" style={{ stopColor: "var(--dune-2)" }} />
        </linearGradient>
        <linearGradient id={`${id}-f`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style={{ stopColor: "var(--dune-3)" }} />
          <stop offset="85%" style={{ stopColor: "var(--background)" }} />
        </linearGradient>
      </defs>
      <path d={DUNE_BACK} fill={`url(#${id}-b)`} />
      <path d={DUNE_FRONT} fill={`url(#${id}-f)`} />
    </svg>
  );
}

export function HeroScene({ id = "hero", copy, frame, className }: { id?: string; copy: ReactNode; frame: ReactNode; className?: string }) {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduce = document.documentElement.getAttribute("data-motion") === "reduce" || matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const h = el.offsetHeight || 1;
      const p = Math.min(1, Math.max(0, window.scrollY / h));
      el.style.setProperty("--hp", p.toFixed(4));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    addEventListener("scroll", onScroll, { passive: true });
    addEventListener("resize", onScroll);
    return () => {
      removeEventListener("scroll", onScroll);
      removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  return (
    <section ref={ref} className={`hero-scene ${className ?? ""}`} aria-labelledby={`${id}-h`}>
      <div className="scene-sky" aria-hidden="true" />
      <Layer id={`${id}-far`} d={FAR} top="--far-1" bottom="--far-2" className="scene-layer scene-far" />
      <Layer id={`${id}-mid`} d={MID} top="--mid-1" bottom="--mid-2" className="scene-layer scene-mid" />
      <Layer id={`${id}-near`} d={NEAR} top="--near-1" bottom="--near-2" className="scene-layer scene-near" />
      <div className="scene-copy">{copy}</div>
      <div className="scene-window">{frame}</div>
      <Dunes id={`${id}-dunes`} className="scene-layer scene-dunes" />
      <div className="scene-grain" aria-hidden="true" />
      <div className="scene-fade" aria-hidden="true" />
    </section>
  );
}

/** The closing section's scene: the sky and the dunes only, the window standing in them. */
export function DuneScene({ id = "close", children }: { id?: string; children: ReactNode }) {
  return (
    <section className="dune-scene" aria-labelledby={`${id}-h`}>
      <div className="scene-sky" aria-hidden="true" />
      <Layer id={`${id}-far`} d={FAR} top="--far-1" bottom="--far-2" className="scene-layer scene-far-static" />
      <div className="relative z-10">{children}</div>
      <Dunes id={`${id}-dunes`} className="scene-layer scene-dunes" />
      <div className="scene-grain" aria-hidden="true" />
    </section>
  );
}
