"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DUR, EASE_FN, clamp01 } from "@/lib/motion.ts";

// Fig. 1, the specimen (DESIGN section 6.1): one H100 SXM module drawn in fine isometric lines,
// taken apart in five steps. Text on each step is limited to facts checked in lib/hardware.ts.
// An illustration, not to scale; no maker's logo or trade dress.

interface Step {
  h: string;
  p: string;
  /** Explode amounts: heatsink (0..2, 2 = lifted away), lid, die, memory. */
  ex: [number, number, number, number];
  /** The hour ring, 0..1. */
  hr: number;
}

const STEPS: Step[] = [
  { h: "Under the heatsink", p: "One H100 in its SXM module, under the fin stack that carries its heat away so it can run flat out, hour after hour.", ex: [0, 0, 0, 0], hr: 0 },
  { h: "Lift the heatsink", p: "Below the fins, a lid over one package. A heatsink does not change what the chip does; it keeps it steady under load.", ex: [1, 0, 0, 0], hr: 0 },
  { h: "Lift the lid", p: "Under the lid, the package: one GPU die beside its memory stacks, on an interposer that wires them together.", ex: [2, 1, 0, 0], hr: 0 },
  { h: "The die and its memory", p: "The die is GH100: 80 billion transistors on 814 mm² of silicon. Five stacks of HBM3 hold its 80 GB.", ex: [2, 1, 1, 1], hr: 0 },
  { h: "One hour of it", p: "Weir does not sell the chip. It prices one hour of it, delivered next week, in one sealed round, at one price for every buyer and seller filled.", ex: [0, 0, 0, 0], hr: 1 },
];

const STILL = 3;
const C30 = Math.cos(Math.PI / 6);
const S30 = 0.5;

interface Lay {
  n: boolean;
  W: number;
  H: number;
  cx: number;
  cy: number;
  s: number;
}

const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

function Drawing({ L, ex, hr, k, step, hourLabel }: { L: Lay; ex: number[]; hr: number; k: number; step: number; hourLabel: string }) {
  const P = (x: number, y: number, z: number): [number, number] => [L.cx + (x - y) * C30 * L.s, L.cy + (x + y) * S30 * L.s - z * L.s];
  const pt = (p: [number, number]) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
  const poly = (a: [number, number][]) => `M${a.map(pt).join("L")}Z`;
  const line = (a: [number, number][]) => `M${a.map(pt).join("L")}`;
  const out: ReactNode[] = [];
  let key = 0;
  const box = (x: number, y: number, z: number, dx: number, dy: number, dz: number, cls = "b") => {
    out.push(
      <g key={key++} className={cls}>
        <path className="sx" d={poly([P(x + dx, y, z), P(x + dx, y + dy, z), P(x + dx, y + dy, z + dz), P(x + dx, y, z + dz)])} />
        <path className="sy" d={poly([P(x, y + dy, z), P(x + dx, y + dy, z), P(x + dx, y + dy, z + dz), P(x, y + dy, z + dz)])} />
        <path className="tp" d={poly([P(x, y, z + dz), P(x + dx, y, z + dz), P(x + dx, y + dy, z + dz), P(x, y + dy, z + dz)])} />
      </g>,
    );
  };
  const [eSink, eLid, eDie, eHbm] = ex as [number, number, number, number];
  const zLid = 8 + eLid * 120;
  const zDie = 3 + eDie * 70;
  const zHbm = 3 + eHbm * 40;
  // Board, power stages and connector.
  box(-150, -110, -12, 300, 220, 8, "b pcb");
  for (let i = 0; i < 12; i++) box(-138 + i * 12, 72, -4, 8, 14, 5);
  for (let i = 0; i < 12; i++) box(-138 + i * 12, -100, -4, 8, 14, 5);
  for (let j = 0; j < 6; j++) for (let i = 0; i < 3; i++) box(104 + i * 12, -60 + j * 20, -4, 9, 12, 7);
  // Package substrate and interposer.
  box(-66, -66, -4, 132, 132, 5, "b pcb");
  box(-54, -46, 1, 108, 92, 2);
  // Memory: five stacks, three on one side of the die and two on the other [HOPPER].
  for (const [x, y] of [[-50, -42], [-50, -12], [-50, 18], [32, -30], [32, 4]] as const) for (let l = 0; l < 8; l++) box(x, y, zHbm + l * 2.2, 18, 24, 2.2, "b hbm");
  // The die, with a floorplan grid.
  box(-26, -40, zDie, 52, 80, 4, "b die");
  const z = zDie + 4;
  for (let i = 1; i < 4; i++) out.push(<path key={key++} className="fineL" d={line([P(-26 + i * 13, -40, z), P(-26 + i * 13, 40, z)])} />);
  for (let j = 1; j < 8; j++) out.push(<path key={key++} className="fineL" d={line([P(-26, -40 + j * 10, z), P(26, -40 + j * 10, z)])} />);
  // The lid: a stepped spreader.
  box(-62, -62, zLid - 5, 124, 124, 3, "b lid");
  box(-56, -56, zLid - 2, 112, 112, 4, "b lid");
  out.push(<path key={key++} className="fine" d={poly([P(-46, -46, zLid + 2), P(46, -46, zLid + 2), P(46, 46, zLid + 2), P(-46, 46, zLid + 2)])} />);
  // The heatsink: a base plate and a stack of fins; lifted, then lifted away.
  const zS = zLid + 2 + Math.min(eSink, 1) * 96 + Math.max(eSink - 1, 0) * 60;
  const sinkA = 1 - clamp01(eSink - 1);
  const sinkStart = out.length;
  if (sinkA > 0.01) {
    box(-96, -86, zS, 192, 172, 9);
    for (let i = 0; i < 24; i++) box(-94 + i * 8, -84, zS + 9, 2.4, 168, 48);
    box(-96, -86, zS + 57, 192, 4, 3);
    box(-96, 82, zS + 57, 192, 4, 3);
  }
  const sink = out.splice(sinkStart);
  // The hour ring.
  const rr = 172;
  const ringPts: [number, number][] = [];
  for (let i = 0; i <= 120; i++) {
    const a = (i / 120) * Math.PI * 2;
    ringPts.push(P(Math.cos(a) * rr, Math.sin(a) * rr, -8));
  }
  const arc = (a0: number, a1: number) => {
    const pts: [number, number][] = [];
    for (let i = 0; i <= 40; i++) {
      const a = lerp(a0, a1, i / 40) - Math.PI / 2;
      pts.push(P(Math.cos(a) * rr, Math.sin(a) * rr, -8));
    }
    return line(pts);
  };
  const [hx, hy] = P(rr * 0.72, -rr * 0.72, -8);
  // Leader labels, shown on their steps once the move has landed.
  const labels: [string, number[], number, number, number, number, number][] = L.n
    ? []
    : [
        ["fin stack", [0], 96, 40, zS + 57, 80, -30],
        ["SXM board · power stages", [1], 120, 100, -4, 70, 40],
        ["lid", [1], -60, 60, zLid + 2, -150, 40],
        ["package substrate", [2, 3], -66, 40, 1, -170, 50],
        ["interposer", [2], 54, 40, 3, 90, 60],
        ["GH100 die · 814 mm²", [2, 3], 20, -40, zDie + 4, 120, -90],
        ["HBM3 stack", [2, 3], -40, -42, zHbm + 17, -170, -80],
      ];
  return (
    <svg viewBox={`0 0 ${L.W} ${L.H}`} className="spec-svg" aria-hidden="true" focusable="false">
      <g opacity={hr} className="spec-ring">
        <path d={line(ringPts)} />
        {Array.from({ length: 60 }, (_, i) => {
          const a = (i / 60) * Math.PI * 2 - Math.PI / 2;
          const r0 = i % 5 ? rr - 6 : rr - 14;
          return <path key={i} d={line([P(Math.cos(a) * r0, Math.sin(a) * r0, -8), P(Math.cos(a) * rr, Math.sin(a) * rr, -8)])} strokeWidth={i % 5 ? 0.6 : 1.2} />;
        })}
        {hr > 0 ? <path d={arc(0, hr * Math.PI)} className="spec-arc-l" /> : null}
        {hr > 0 ? <path d={arc(Math.PI, Math.PI + hr * Math.PI)} className="spec-arc-s" /> : null}
        <text x={hx + 14} y={hy - 26} className="spec-hour">
          1 GPU-hour
        </text>
        <text x={hx + 16} y={hy - 6} className="spec-lbl">
          {hourLabel}
        </text>
      </g>
      {out}
      <g opacity={sinkA}>{sink}</g>
      {labels.map(([txt, steps, ax, ay, az, dx, dy]) => {
        const [x0, y0] = P(ax, ay, az);
        const tx = x0 + dx;
        const ty = y0 + dy;
        return (
          <g key={txt} opacity={steps.includes(step) ? k : 0}>
            <path className="spec-lead" d={`M${x0.toFixed(1)} ${y0.toFixed(1)}L${tx.toFixed(1)} ${ty.toFixed(1)}H${(tx + (dx > 0 ? 8 : -8)).toFixed(1)}`} />
            <text className="spec-lbl" x={tx + (dx > 0 ? 12 : -12)} y={ty + 4} textAnchor={dx > 0 ? "start" : "end"}>
              {txt}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function Specimen({ hourLabel, sheet }: { hourLabel: string; sheet: ReactNode }) {
  const stage = useRef<HTMLDivElement>(null);
  const fig = useRef<HTMLElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [cur, setCur] = useState(STILL);
  const [from, setFrom] = useState<Step>(STEPS[STILL]!);
  const [k, setK] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [reduced, setReduced] = useState(false);
  const raf = useRef(0);
  const begun = useRef(false);
  const state = useRef({ cur: STILL, from: STEPS[STILL]!, k: 1, t0: 0, playing: false });

  const L: Lay = useMemo(() => (narrow ? { n: true, W: 400, H: 340, cx: 200, cy: 186, s: 0.8 } : { n: false, W: 900, H: 560, cx: 440, cy: 318, s: 1 }), [narrow]);

  const mix = (a: Step, b: Step, u: number): Step => ({ h: b.h, p: b.p, ex: a.ex.map((v, i) => lerp(v, b.ex[i]!, u)) as Step["ex"], hr: lerp(a.hr, b.hr, u) });

  const tick = useCallback((now: number) => {
    const s = state.current;
    const u = clamp01((now - s.t0) / (DUR.draw + 100));
    s.k = u;
    setK(u);
    if (s.playing && now - s.t0 > 3200) {
      go(s.cur + 1, true);
      return;
    }
    raf.current = u < 1 || s.playing ? requestAnimationFrame(tick) : 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const go = useCallback(
    (n: number, keepPlaying = false) => {
      const s = state.current;
      const next = (n + STEPS.length) % STEPS.length;
      const shown = mix(s.from, STEPS[s.cur]!, EASE_FN.travel(s.k));
      s.from = shown;
      s.cur = next;
      begun.current = true;
      if (!keepPlaying) {
        s.playing = false;
        setPlaying(false);
      }
      setFrom(shown);
      setCur(next);
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        s.k = 1;
        setK(1);
        return;
      }
      s.k = 0;
      setK(0);
      s.t0 = performance.now();
      if (!raf.current) raf.current = requestAnimationFrame(tick);
    },
    [tick],
  );

  const togglePlay = () => {
    const s = state.current;
    s.playing = !s.playing;
    setPlaying(s.playing);
    if (s.playing) {
      s.t0 = performance.now() - 3200;
      if (!raf.current) raf.current = requestAnimationFrame(tick);
    }
  };

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < 560));
    ro.observe(el);
    // The first time it is half in view, start from the closed module and step through once.
    const io = new IntersectionObserver(
      (es) => {
        const vis = es.some((e) => e.isIntersecting);
        if (vis && !begun.current && !mq.matches) {
          begun.current = true;
          const s = state.current;
          s.cur = 0;
          s.from = STEPS[0]!;
          s.k = 1;
          setCur(0);
          setFrom(STEPS[0]!);
          s.playing = true;
          setPlaying(true);
          s.t0 = performance.now() - 2000;
          raf.current = requestAnimationFrame(tick);
        }
        if (!vis && state.current.playing) {
          state.current.playing = false;
          setPlaying(false);
        }
      },
      { threshold: 0.5 },
    );
    io.observe(el);
    const onVis = () => {
      if (document.hidden && state.current.playing) {
        state.current.playing = false;
        setPlaying(false);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
  }, [tick]);

  const shown = mix(from, STEPS[cur]!, EASE_FN.travel(k));
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      go(cur + 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      go(cur - 1);
    }
  };

  return (
    <figure ref={fig} className="spec-fig" onKeyDown={onKey} id="specimen">
      <div className="spec-headrow">
        <span className="fig-n">Fig. 1</span>
        <span className="grow">Specimen · one H100 SXM module, taken apart</span>
        <span className="tag flag">Illustration · not to scale</span>
      </div>
      <div className="spec-body">
      <div className="spec-stage" ref={stage} role="img" aria-label="Isometric line drawing of one H100 SXM module, taken apart in five steps: the heatsink, the lid, the package with its die and five memory stacks, and the one hour of it that Weir prices. Illustration, not to scale.">
        <Drawing L={L} ex={shown.ex} hr={shown.hr} k={k} step={cur} hourLabel={hourLabel} />
      </div>
      <div className="spec-sheetcol">{sheet}</div>
      </div>
      <figcaption className="spec-ui">
        <div className="spec-text">
          <p className="spec-title">
            <span className="spec-n" aria-hidden="true">
              0{cur + 1}
            </span>
            <span className="spec-of">/ 05</span>
            <span className="spec-h">{STEPS[cur]!.h}</span>
          </p>
          <p className="spec-p" aria-live="polite">
            {STEPS[cur]!.p}
            {reduced && !begun.current ? " (still frame, motion reduced: step through with the buttons)" : ""}
          </p>
        </div>
        <div className="spec-ctrl">
          <button type="button" className="round-btn" onClick={() => go(cur - 1)} aria-label="Previous step">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M10 3 L5 8 L10 13" fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
          <div className="pips" role="group" aria-label="Steps">
            {STEPS.map((s, i) => (
              <button key={s.h} type="button" className="pip" aria-pressed={i === cur} aria-label={`Step ${i + 1}: ${s.h}`} onClick={() => go(i)}>
                {i + 1}
              </button>
            ))}
          </div>
          <button type="button" className="round-btn" onClick={() => go(cur + 1)} aria-label="Next step">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M6 3 L11 8 L6 13" fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
          {reduced ? null : (
            <button type="button" className="button ghost spec-play" onClick={togglePlay} aria-pressed={playing}>
              {playing ? "Pause" : "Play"}
            </button>
          )}
        </div>
      </figcaption>
    </figure>
  );
}
