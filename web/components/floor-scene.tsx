"use client";
import { motionQuery } from "@/lib/reduced-motion.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { floorBeat, floorTime, scanRow, type FloorPlan, type FloorTicket } from "@/lib/floor.ts";
import { dollarsOfPrice, fmtInt } from "@/lib/format.ts";
import { eyePath, MARK_PARTS } from "@/lib/logo.ts";
import { clamp01, EASE_FN, seg } from "@/lib/motion.ts";
import { Clock } from "@/lib/clock.ts";

// "One round, as work" (DESIGN section 7.4). The plan (lib/floor.ts) is built on the server from
// an example book cleared by the engine; this component poses it at time t, frame by frame, in
// SILICON's drawing language: an elevation in fine lines, the bench, the rack, the tickets, and
// the house heatsink, the one thing on the site with a face. The markup is always a real frame:
// the server sends the last one, reduced motion keeps it, and play starts from the first.

interface Layout {
  wide: boolean;
  W: number;
  H: number;
  G: number;
  cx: number;
  spine: number;
  bay: number;
  rowH: number;
  tw: number;
  th: number;
  qL0: number;
  qS0: number;
  qGap: number;
  yT: number;
  xl: number;
  xr: number;
  rackH: number;
}

function layout(wide: boolean, rows: number): Layout {
  if (wide) {
    const W = 960, H = 392, G = 334, cx = 480, spine = 72, bay = 108, rowH = 20;
    const rackH = rows * rowH + 16;
    const xl = cx - spine / 2 - bay, xr = cx + spine / 2 + bay;
    return { wide, W, H, G, cx, spine, bay, rowH, tw: 58, th: 20, qL0: xl - 48, qS0: xr + 48, qGap: 64, yT: G - 40 - rackH, xl, xr, rackH };
  }
  const cx = 180, spine = 50, bay = 74, rowH = 19, yT = 56;
  const rackH = rows * rowH + 16;
  const G = yT + rackH + 156, H = G + 40, W = 360;
  const xl = cx - spine / 2 - bay, xr = cx + spine / 2 + bay;
  return { wide, W, H, G, cx, spine, bay, rowH, tw: 44, th: 20, qL0: 155, qS0: 205, qGap: 50, yT, xl, xr, rackH };
}

const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

interface Pose {
  x: number;
  y: number;
  s: number;
  rot: number;
  cover: number;
  coverY: number;
  lit: number;
  op: number;
}

/** A queue place. Narrow: two lanes on the bench, so five tickets fit at a readable size. */
function slotX(L: Layout, t: FloorTicket, i: number) {
  const col = L.wide ? i : Math.floor(i / 2);
  return t.side === "Long" ? L.qL0 - col * L.qGap : L.qS0 + col * L.qGap;
}

function laneY(L: Layout, i: number) {
  return L.wide || i % 2 === 0 ? 0 : -(L.th + 6);
}

function rowY(L: Layout, row: number) {
  return L.yT + 8 + row * L.rowH + L.rowH / 2;
}

function rackSlot(L: Layout, t: FloorTicket): [number, number] {
  const off = t.lane * 8;
  return [t.side === "Long" ? L.xl + L.bay / 2 - off : L.xr - L.bay / 2 + off, rowY(L, t.row)];
}

/** Where a ticket is, and how it looks, at time t. */
function pose(L: Layout, plan: FloorPlan, tk: FloorTicket, t: number): Pose {
  const bench = L.G - L.th / 2 - 1;
  const inRack = L.wide ? 0.88 : 0.92;
  const start = tk.side === "Long" ? -L.tw : L.W + L.tw;
  const qA = slotX(L, tk, tk.arrival);
  const qR = slotX(L, tk, tk.rank);
  const [rx, ry] = rackSlot(L, tk);
  const yA = bench + laneY(L, tk.arrival);
  const yR = bench + laneY(L, tk.rank);
  let x = start, y = yA, s = 1, rot = 0, op = 1;
  // Arrive: slide in with weight, a small lean into the stop.
  const ua = seg(t, tk.arriveAt, tk.arriveEnd - tk.arriveAt);
  x = lerp(start, qA, EASE_FN.weighted(ua));
  if (ua > 0 && ua < 1) rot = (tk.side === "Long" ? 1 : -1) * 4 * Math.sin(Math.PI * ua) * (ua > 0.78 ? -0.6 : 1);
  // Line up: a hop to the ranked place.
  const ur = seg(t, tk.rankAt, tk.rankEnd - tk.rankAt);
  if (ur > 0) {
    x = lerp(qA, qR, EASE_FN.travel(ur));
    y = lerp(yA, yR, EASE_FN.travel(ur)) - Math.sin(Math.PI * ur) * (qA === qR ? 4 : 12);
  }
  // Rack: a toss into the row for its price, landing with a small overshoot.
  const uk = seg(t, tk.rackAt, tk.rackEnd - tk.rackAt);
  if (uk > 0) {
    const e = EASE_FN.travel(uk);
    x = lerp(qR, rx, e);
    y = lerp(yR, ry, e) - Math.sin(Math.PI * uk) * (L.wide ? 54 : 40);
    s = lerp(1, inRack, e);
    if (uk >= 1) {
      const settle = seg(t, tk.rackEnd, 0.22);
      y = ry + Math.sin(Math.PI * settle) * 1.6 * (1 - settle);
    }
  }
  // Unfilled: back down to the bench, dimmed.
  if (tk.state === "out" && t >= tk.returnAt) {
    const ub = seg(t, tk.returnAt, 0.6);
    const e = EASE_FN.travel(ub);
    x = lerp(rx, qR, e);
    y = lerp(ry, yR, e) - Math.sin(Math.PI * ub) * 26;
    s = lerp(inRack, 1, e);
    op = 1 - 0.5 * EASE_FN.out(ub);
  }
  const ucov = seg(t, tk.revealAt, 0.34);
  const lit = tk.state === "out" ? 0 : EASE_FN.overshoot(seg(t, plan.T.lit + 0.1 + tk.rank * 0.06, 0.4));
  return { x, y, s, rot, cover: 1 - ucov, coverY: -14 * EASE_FN.out(ucov), lit, op };
}

function Ticket({ L, plan, tk, p }: { L: Layout; plan: FloorPlan; tk: FloorTicket; p: Pose }) {
  const w = L.tw, h = L.th;
  const long = tk.side === "Long";
  const price = dollarsOfPrice(tk.price, plan.tick);
  const share = tk.filled / tk.size;
  return (
    <g transform={`translate(${p.x.toFixed(2)} ${p.y.toFixed(2)}) rotate(${p.rot.toFixed(2)}) scale(${p.s.toFixed(3)})`} opacity={p.op}>
      <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={2} className="fl-tk" />
      <rect x={-w / 2 + 3} y={L.wide ? -3.5 : -3} width={L.wide ? 7 : 6} height={L.wide ? 7 : 6} rx={1} fill={long ? "var(--long)" : "url(#hatch-short)"} stroke={long ? "none" : "var(--short)"} strokeWidth={0.8} />
      <text x={-w / 2 + (L.wide ? 13 : 12)} y={L.wide ? 3.2 : 3.8} className={L.wide ? "fl-price" : "fl-price fl-price-s"}>
        {L.wide ? price : price.slice(1)}
      </text>
      {p.lit > 0 ? (
        <g opacity={clamp01(p.lit)}>
          <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={2} fill="none" stroke={long ? "var(--long)" : "var(--short)"} strokeWidth={2} />
          <rect x={-w / 2} y={h / 2 - 3.5} width={w * share * Math.min(1, p.lit)} height={3.5} fill={long ? "var(--long)" : "url(#hatch-short)"} />
        </g>
      ) : null}
      {p.cover > 0.001 ? (
        <g opacity={p.cover} transform={`translate(0 ${p.coverY.toFixed(2)})`}>
          <rect x={-w / 2 - 1} y={-h / 2 - 1} width={w + 2} height={h + 2} rx={2.5} className="fl-cover" />
          <path d="M-2.6 -1.4v-1.8a2.6 2.6 0 0 1 5.2 0v1.8" className="fl-lock" />
          <rect x={-3.6} y={-1.6} width={7.2} height={5.4} rx={1} fill="var(--ink)" />
        </g>
      ) : null}
    </g>
  );
}

function Heatsink({ x, y, s, t, plan, scanY }: { x: number; y: number; s: number; t: number; plan: FloorPlan; scanY: number | null }) {
  // The face: looks toward each arrival, down at the scanner, then straight out once it clears.
  const T = plan.T;
  let dx = 0, dy = 0;
  if (t < T.reveal) dx = Math.sin(t * 2.1) * 1.4;
  else if (t < T.scan) dx = -0.8;
  else if (t < T.lit + 0.2 && scanY !== null) {
    dx = -1.4;
    dy = Math.max(-1.5, Math.min(2.4, (scanY - (y + 32 * s)) / 40));
  }
  // Blink every 3.4 s for 120 ms; and a long, satisfied blink at the hold.
  const blink = t % 3.4 < 0.12 || (t > T.hold + 0.2 && t < T.hold + 0.42);
  const hu = seg(t, T.lit + 0.15, 0.5);
  const hop = -Math.sin(Math.PI * hu) * 7;
  const squash = hu > 0 && hu < 0.16 ? 0.9 : hu > 0.86 && hu < 1 ? 0.94 : 1;
  return (
    <g transform={`translate(${x} ${y + hop}) scale(${s}) translate(24 43) scale(${(2 - squash).toFixed(3)} ${squash.toFixed(3)}) translate(-24 -43)`} className="fl-sink">
      <path d={MARK_PARTS.body} fill="var(--ink)" />
      {MARK_PARTS.eyes.map((e, i) =>
        blink ? (
          <rect key={i} x={e.x + dx} y={e.bottom - 1.6 + dy * 0.4} width={e.w} height={1.4} fill="var(--sheet)" />
        ) : (
          <path key={i} d={eyePath(e.x + dx, e.w, e.top + dy, e.bottom + dy * 0.4)} fill="var(--sheet)" />
        ),
      )}
    </g>
  );
}

export function FloorScene({ plan, label = "Example round" }: { plan: FloorPlan; label?: string }) {
  const root = useRef<HTMLElement>(null);
  const [wide, setWide] = useState(true);
  const [t, setT] = useState(plan.total);
  const [playing, setPlaying] = useState(false);
  const [reduced, setReduced] = useState(false);
  const tRef = useRef(plan.total);
  const raf = useRef(0);
  // Time-based (lib/clock.ts): t is the clock's elapsed time, which stops off screen and in a
  // hidden tab and resumes without a jump. A slow frame rate only makes it less smooth.
  const clock = useRef(new Clock());
  const visible = useRef(false);
  const seen = useRef(false);
  const wantPlay = useRef(false);

  const L = useMemo(() => layout(wide, plan.rows.length), [wide, plan.rows.length]);

  const stopLoop = () => {
    clock.current.pause(performance.now());
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = 0;
  };
  const loop = useCallback(
    (now: number) => {
      raf.current = 0;
      const nt = floorTime(plan, clock.current.elapsed(now));
      tRef.current = nt;
      setT(nt);
      if (nt >= plan.total) {
        wantPlay.current = false;
        clock.current.pause(now);
        setPlaying(false);
        return;
      }
      raf.current = requestAnimationFrame(loop);
    },
    [plan],
  );
  const startLoop = useCallback(() => {
    if (raf.current || !visible.current || document.hidden) return;
    clock.current.start(performance.now());
    raf.current = requestAnimationFrame(loop);
  }, [loop]);

  const seekTo = (sec: number) => {
    clock.current.seek(sec * 1000, performance.now());
    tRef.current = sec;
    setT(sec);
  };
  const play = useCallback(() => {
    if (tRef.current >= plan.total - 0.01) seekTo(0);
    wantPlay.current = true;
    setPlaying(true);
    startLoop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan.total, startLoop]);
  const pause = () => {
    wantPlay.current = false;
    setPlaying(false);
    stopLoop();
  };
  const replay = () => {
    stopLoop();
    seekTo(0);
    wantPlay.current = true;
    setPlaying(true);
    startLoop();
  };

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const mq = motionQuery();
    setReduced(mq.matches);
    const onMq = () => {
      setReduced(mq.matches);
      if (mq.matches) {
        pause();
        seekTo(plan.total);
      }
    };
    mq.addEventListener("change", onMq);
    const ro = new ResizeObserver(() => setWide(el.getBoundingClientRect().width >= 620));
    ro.observe(el);
    // Play once the first time 40% of it is in view; pause off screen and in a hidden tab.
    const io = new IntersectionObserver(
      (es) => {
        visible.current = es.some((e) => e.isIntersecting);
        if (!visible.current) return stopLoop();
        if (!seen.current && !mq.matches) {
          seen.current = true;
          seekTo(0);
          wantPlay.current = true;
          setPlaying(true);
        }
        if (wantPlay.current) startLoop();
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    const onVis = () => (document.hidden ? stopLoop() : wantPlay.current && startLoop());
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stopLoop();
      ro.disconnect();
      io.disconnect();
      mq.removeEventListener("change", onMq);
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan.total, startLoop]);

  const T = plan.T;
  const beat = floorBeat(plan, t);
  const caption = reduced ? plan.summary : plan.beats[beat]!.label;
  const sr = scanRow(plan, t);
  const scanOn = clamp01(seg(t, T.scan - 0.15, 0.15)) * (1 - seg(t, T.lit + 0.3, 0.3));
  const scanY = t >= T.scan - 0.15 ? rowY(L, Math.max(-0.6, sr)) : null;
  const cur = plan.rows[Math.max(0, Math.min(plan.rows.length - 1, Math.round(sr)))]!;
  const lit = seg(t, T.lit, 0.3);
  const clearY = rowY(L, plan.clearRow);
  const stamp = EASE_FN.overshoot(seg(t, T.hold - 0.5, 0.45));
  const gate = EASE_FN.overshoot(seg(t, T.reveal - 0.25, 0.3));
  const price = dollarsOfPrice(plan.clearing.price, plan.tick);
  const lateU = seg(t, T.late, 1.25);
  const lateX = (() => {
    const out = L.W + L.tw, hit = L.W - 10 - L.tw / 2;
    if (lateU < 0.36) return lerp(out, hit, EASE_FN.travel(lateU / 0.36));
    if (lateU < 0.52) return hit + Math.sin(((lateU - 0.36) / 0.16) * Math.PI) * 3;
    return lerp(hit, out, EASE_FN.anticipate((lateU - 0.52) / 0.48));
  })();
  const progress = t / plan.total;

  return (
    <figure ref={root} className="floor" aria-roledescription="animation">
      <div className="floor-stage" role="img" aria-label={plan.summary}>
        <svg viewBox={`0 0 ${L.W} ${L.H}`} className="floor-svg" aria-hidden="true" focusable="false">
          {/* The room: a fine back wall of racks, the bench, its tick marks. */}
          <g className="fl-room">
            {Array.from({ length: L.wide ? 13 : 5 }, (_, i) => {
              const x = (L.wide ? 14 : 8) + i * (L.wide ? 74 : 72);
              const h = 150 + ((i * 37) % 50);
              return <rect key={i} x={x} y={L.G - h} width={L.wide ? 58 : 56} height={h} />;
            })}
          </g>
          <line x1={0} x2={L.W} y1={L.G} y2={L.G} className="fl-bench" />
          {Array.from({ length: Math.floor(L.W / 12) }, (_, i) => (
            <line key={i} x1={6 + i * 12} x2={6 + i * 12} y1={L.G + 4} y2={L.G + (i % 5 ? 7 : 11)} className="fl-tick" />
          ))}
          <text x={L.wide ? L.qL0 + L.tw / 2 : 4} y={L.G + 26} className="fl-cap" textAnchor={L.wide ? "end" : "start"}>
            BUYERS · LONG
          </text>
          <text x={L.wide ? L.qS0 - L.tw / 2 : L.W - 4} y={L.G + 26} className="fl-cap" textAnchor={L.wide ? "start" : "end"}>
            SELLERS · SHORT
          </text>
          {/* The commit window's gates: they drop when it closes. */}
          {[6, L.W - 6].map((gx) => (
            <g key={gx} transform={`translate(${gx} ${L.G})`}>
              <rect x={-2} y={-34 * gate} width={4} height={34 * gate} className="fl-gate" />
            </g>
          ))}
          {/* The rack. */}
          <g className="fl-rack">
            <rect x={L.xl - 3} y={L.yT + L.rackH} width={L.wide ? 4 : 2} height={L.G - L.yT - L.rackH} className="fl-leg" />
            <rect x={L.xr + (L.wide ? -1 : 1)} y={L.yT + L.rackH} width={L.wide ? 4 : 2} height={L.G - L.yT - L.rackH} className="fl-leg" />
            <rect x={L.xl - 4} y={L.yT} width={L.xr - L.xl + 8} height={L.rackH} rx={3} className="fl-frame" />
            <rect x={L.cx - L.spine / 2} y={L.yT + 4} width={L.spine} height={L.rackH - 8} className="fl-spine" />
            {plan.rows.map((r, i) => (
              <g key={r.price}>
                {i ? <line x1={L.xl} x2={L.xr} y1={L.yT + 8 + i * L.rowH} y2={L.yT + 8 + i * L.rowH} className="fl-row" /> : null}
                <text x={L.cx} y={rowY(L, i) + 3.5} textAnchor="middle" className="fl-rowp">
                  {L.wide ? dollarsOfPrice(r.price, plan.tick) : dollarsOfPrice(r.price, plan.tick).slice(1)}
                </text>
              </g>
            ))}
            <rect x={L.xl - 2} y={clearY - L.rowH / 2} width={L.xr - L.xl + 4} height={L.rowH} className="fl-hit" opacity={lit} />
            <text x={L.xl - 4} y={L.yT - 10} className="fl-plate">
              {label.toUpperCase()} · H100
            </text>
          </g>
          {/* The scanner and its two readings, straight from the engine's curves. */}
          {scanY !== null ? (
            <g opacity={scanOn}>
              <rect x={L.xl - 26} y={scanY - L.rowH / 2} width={L.xr - L.xl + 52} height={L.rowH} className="fl-scanglow" />
              <line x1={L.xl - 26} x2={L.xl - 8} y1={scanY} y2={scanY} className="fl-scan" />
              <line x1={L.xr + 8} x2={L.xr + 26} y1={scanY} y2={scanY} className="fl-scan" />
            </g>
          ) : null}
          {t >= T.scan - 0.1 ? (
            <g opacity={clamp01(seg(t, T.scan - 0.1, 0.2))}>
              <text x={L.xl - 10} y={L.wide ? L.yT + 14 : L.yT + L.rackH + 18} textAnchor="end" className="fl-count fl-long">
                {L.wide ? "BID AT OR ABOVE " : "BID "}
                {fmtInt(t >= T.lit ? plan.clearing.volume : cur.demand)}
                {L.wide ? " GPU-H" : ""}
              </text>
              <text x={L.xr + 10} y={L.wide ? L.yT + 14 : L.yT + L.rackH + 18} className="fl-count fl-short">
                {L.wide ? "OFFERED AT OR BELOW " : "ASK "}
                {fmtInt(t >= T.lit ? plan.clearing.volume : cur.supply)}
                {L.wide ? " GPU-H" : ""}
              </text>
            </g>
          ) : null}
          {/* The one price, across the whole floor. */}
          <g opacity={lit}>
            <line x1={0} x2={L.W} y1={clearY} y2={clearY} className="fl-pline" />
          </g>
          {plan.tickets.map((tk) => (
            <Ticket key={tk.seq} L={L} plan={plan} tk={tk} p={pose(L, plan, tk, t)} />
          ))}
          {/* The late bid, turned away at the gate. */}
          {lateU > 0 && lateU < 1 ? (
            <g transform={`translate(${lateX.toFixed(2)} ${L.G - L.th / 2 - 1 - (L.wide ? 0 : L.th + 6)})`}>
              <rect x={-L.tw / 2} y={-L.th / 2} width={L.tw} height={L.th} rx={2} className="fl-cover" />
              <rect x={-3.6} y={-1.6} width={7.2} height={5.4} rx={1} fill="var(--ink)" />
              <path d="M-2.6 -1.4v-1.8a2.6 2.6 0 0 1 5.2 0v1.8" className="fl-lock" />
            </g>
          ) : null}
          {lit > 0 ? (
            <g opacity={lit} transform={`translate(${L.wide ? L.W - 92 : L.cx} ${L.wide ? clearY : L.yT + L.rackH + 46})`}>
              <rect x={-74} y={-12} width={148} height={24} rx={12} className="fl-pill" />
              <text x={0} y={4.5} textAnchor="middle" className="fl-pilltx">
                {price} /GPU-h
              </text>
            </g>
          ) : null}
          {stamp > 0 ? (
            <g transform={`translate(${L.wide ? L.W - 96 : L.cx} ${L.wide ? clearY - 46 : L.yT + L.rackH + 80}) rotate(-5) scale(${(1.5 - 0.5 * stamp).toFixed(3)})`} opacity={clamp01(stamp)}>
              <rect x={-52} y={-13} width={104} height={26} className="fl-stamp" />
              <text x={0} y={5} textAnchor="middle" className="fl-stamptx">
                CLEARED
              </text>
            </g>
          ) : null}
          <Heatsink x={L.xr - (L.wide ? 54 : 44)} y={L.yT - (L.wide ? 50 : 41)} s={L.wide ? 1.1 : 0.9} t={t} plan={plan} scanY={scanY} />
        </svg>
      </div>
      <figcaption className="mf-bar">
        <span className="mf-progress" aria-hidden="true">
          <span style={{ transform: `scaleX(${progress.toFixed(4)})` }} />
        </span>
        <div className="mf-row">
          {reduced ? null : (
            <div className="mf-buttons">
              <button type="button" className="mf-btn mf-main" onClick={() => (playing ? pause() : play())} aria-label={playing ? "Pause the round" : t >= plan.total - 0.01 ? "Play the round again" : "Play the round"}>
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor">
                  {playing ? <path d="M4.5 3.5h2.5v9H4.5zM9 3.5h2.5v9H9z" /> : <path d="M5 3.5v9l7-4.5Z" />}
                </svg>
                <span>{playing ? "Pause" : t >= plan.total - 0.01 ? "Replay" : "Play"}</span>
              </button>
              <button type="button" className="mf-btn" onClick={replay} aria-label="Replay the round from the start">
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 8a5 5 0 1 0 1.6-3.7M3 2.5v2.8h2.8" />
                </svg>
              </button>
            </div>
          )}
          <p className="mf-caption" aria-live={playing ? "off" : "polite"}>
            <span className="mf-count">
              {reduced ? "Still" : `${beat + 1}/${plan.beats.length}`}
            </span>
            {caption}
          </p>
        </div>
      </figcaption>
    </figure>
  );
}
