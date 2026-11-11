"use client";
import { motionQuery } from "@/lib/reduced-motion.ts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Clock } from "@/lib/clock.ts";
import { dollarsOfPrice, fmtInt } from "@/lib/format.ts";
import { dieLook, layoutDies, waferClock, WAFER_ANCHOR, WAFER_T, WAFER_TICK, waferBook, waferProgress, type Die, type DieLook, type WaferBook, type WaferGeom } from "@/lib/wafer.ts";

// The first screen's living object: a wafer under test, one die per order of a simulated round
// cleared by the engine (lib/wafer.ts). One canvas, no library. It paints only while on screen
// in a visible tab, skips frames when nothing on it changes, caps the pixel ratio at 2 and the
// dies at MAX_DIES, and under reduced motion paints one composed, cleared frame and stops.

const MAX_DIES = 1400;

const useIsoLayout = typeof window === "undefined" ? useEffect : useLayoutEffect;

interface Caption {
  orders: number;
  price: number | null;
  volume: number;
  filledPct: number;
}

function geometry(w: number, h: number): { g: WaferGeom; fadeX: [number, number] | null } {
  if (w >= 900) {
    const r = Math.min(h * 0.54, w * 0.33);
    let pitch = 17;
    while (Math.PI * (r / pitch) ** 2 > MAX_DIES * 1.35) pitch += 1;
    return { g: { cx: w * 0.78, cy: h * 0.55, r, pitch }, fadeX: [w * 0.42, w * 0.6] };
  }
  const r = Math.min(w * 0.46, h * 0.38);
  return { g: { cx: w / 2, cy: h * 0.4, r, pitch: w < 480 ? 10 : 12 }, fadeX: null };
}

const css = (el: Element, n: string) => getComputedStyle(el).getPropertyValue(n).trim();

export function Wafer({ anchor, anchorIsLive }: { anchor: number | null; anchorIsLive: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [cap, setCap] = useState<Caption | null>(null);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(false);
  const pausedRef = useRef(false);

  // A layout effect: the first frame (the sealed wafer, every die grey) is drawn before the
  // browser paints, so the hero is never blank, and no animation frame is asked for until then.
  useIsoLayout(() => {
    const el = host.current;
    const cv = canvas.current;
    if (!el || !cv) return;
    const ctx = cv.getContext("2d", { alpha: false });
    if (!ctx) return;
    const mq = motionQuery();
    let W = 0;
    let H = 0;
    let geom: WaferGeom | null = null;
    let fadeX: [number, number] | null = null;
    let dies: Die[] = [];
    let alpha: number[] = [];
    let book: WaferBook | null = null;
    let seed = (Date.now() / 1000) | 0;
    // Time-based: the round's position is the clock's elapsed time (lib/clock.ts), which stops
    // off screen, in a hidden tab and when paused, and resumes where it stopped.
    const clock = new Clock();
    let round = 0;
    let raf = 0;
    let visible = false;
    let lastKey = "";
    let col: Record<string, string> = {};

    const readColours = () => {
      col = {
        ground: css(el, "--paper"),
        sheet: css(el, "--sheet"),
        rule: css(el, "--rule"),
        die: css(el, "--die"),
        ink: css(el, "--ink"),
        long: css(el, "--long"),
        lit: css(el, "--short-lit"),
        short: css(el, "--short"),
      };
    };

    const newBook = () => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      book = waferBook(dies, seed, anchor ?? WAFER_ANCHOR, WAFER_TICK);
      setCap({ orders: dies.length, price: book.clearing.price, volume: book.clearing.volume, filledPct: dies.length ? Math.round((book.filledCount / dies.length) * 100) : 0 });
    };

    const build = () => {
      const r = el.getBoundingClientRect();
      W = Math.round(r.width);
      H = Math.round(r.height);
      if (!W || !H) return false;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = W * dpr;
      cv.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const gg = geometry(W, H);
      geom = gg.g;
      fadeX = gg.fadeX;
      dies = layoutDies(geom, { w: W + 20, h: H + 20 });
      alpha = dies.map((d) => (fadeX ? Math.min(1, Math.max(0.16, (d.x - fadeX[0]) / (fadeX[1] - fadeX[0]))) : 1));
      readColours();
      newBook();
      lastKey = "";
      return true;
    };

    const draw = (t: number) => {
      if (!geom || !book) return;
      const g = geom;
      const prog = waferProgress(t, g);
      // Nothing changes on the wafer during the hold: skip those frames entirely.
      const key = t > WAFER_T.clearEnd + 0.05 && t < WAFER_T.fadeStart ? "hold" : `${t.toFixed(3)}`;
      if (key === lastKey) return;
      lastKey = key;
      const p = g.pitch;
      const gap = p < 12 ? 1.6 : 2.4;
      const s = p - gap;
      ctx.globalAlpha = 1;
      ctx.fillStyle = col.ground!;
      ctx.fillRect(0, 0, W, H);
      // The wafer: disc, edge-exclusion ring, flat notch.
      ctx.beginPath();
      ctx.arc(g.cx, g.cy, g.r, 0, Math.PI * 2);
      ctx.fillStyle = col.sheet!;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = col.rule!;
      ctx.stroke();
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.arc(g.cx, g.cy, g.r - 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      const na = Math.PI * 0.75;
      ctx.beginPath();
      ctx.arc(g.cx + Math.cos(na) * g.r, g.cy + Math.sin(na) * g.r, 7, 0, Math.PI * 2);
      ctx.fillStyle = col.ground!;
      ctx.fill();

      const fadeK = 1;
      // Group dies by look so each colour is one fill.
      const groups: Record<string, number[]> = {};
      const hatch: number[] = [];
      dies.forEach((d, k) => {
        const o = book!.orders[k]!;
        const look: DieLook = dieLook(t, d, p, book!.fill[k]!, o.size, prog);
        const long = o.side === "Long";
        const name = look === "sealed" ? "sealed" : look === "out" ? "out" : look === "open" ? (long ? "openL" : "openS") : long ? "litL" : "litS";
        (groups[name] ??= []).push(k);
        if (!long && look !== "sealed" && look !== "out") hatch.push(k);
      });
      const style: Record<string, [string, number]> = {
        sealed: [col.die!, 1],
        out: [col.die!, 0.7],
        openL: [col.long!, 0.32],
        openS: [col.lit!, 0.32],
        litL: [col.long!, 1],
        litS: [col.lit!, 1],
      };
      for (const [name, ks] of Object.entries(groups)) {
        const [c, a] = style[name]!;
        ctx.fillStyle = c;
        // Alpha varies per die only near the copy (fadeX), so bucket by it.
        const buckets = new Map<number, number[]>();
        for (const k of ks) {
          const ak = Math.round(alpha[k]! * 8) / 8;
          let b = buckets.get(ak);
          if (!b) buckets.set(ak, (b = []));
          b.push(k);
        }
        for (const [ak, list] of buckets) {
          ctx.globalAlpha = a * ak * fadeK;
          ctx.beginPath();
          for (const k of list) ctx.rect(dies[k]!.x + gap / 2, dies[k]!.y + gap / 2, s, s);
          ctx.fill();
        }
      }
      // Sellers are hatched as well as gold, so the two sides never rest on colour alone.
      ctx.strokeStyle = col.ground!;
      ctx.lineWidth = p < 12 ? 1 : 1.3;
      ctx.globalAlpha = 0.75 * fadeK;
      ctx.beginPath();
      for (const k of hatch) {
        const x = dies[k]!.x + gap / 2;
        const y = dies[k]!.y + gap / 2;
        ctx.moveTo(x, y + s * 0.5);
        ctx.lineTo(x + s * 0.5, y);
        ctx.moveTo(x + s * 0.5, y + s);
        ctx.lineTo(x + s, y + s * 0.5);
      }
      ctx.stroke();
      // Part-filled: the unfilled share of the die is cut away.
      ctx.globalAlpha = fadeK;
      ctx.fillStyle = col.ground!;
      dies.forEach((d, k) => {
        const f = book!.fill[k]!;
        const size = book!.orders[k]!.size;
        if (f > 0 && f < size && dieLook(t, d, p, f, size, prog) === "part") ctx.fillRect(d.x + gap / 2 + s * (f / size), d.y + gap / 2, s * (1 - f / size), s);
      });
      ctx.globalAlpha = 1;
      // The probe and the clearing ring.
      if (t > WAFER_T.probeStart && t < WAFER_T.probeEnd) {
        const hw = Math.sqrt(Math.max(0, g.r * g.r - (prog.probeY - g.cy) ** 2));
        ctx.strokeStyle = col.ink!;
        ctx.globalAlpha = 0.75;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(g.cx - hw, prog.probeY);
        ctx.lineTo(g.cx + hw, prog.probeY);
        ctx.stroke();
      }
      if (t > WAFER_T.clearStart && t < WAFER_T.clearEnd + 0.4) {
        ctx.strokeStyle = col.ink!;
        ctx.globalAlpha = 0.4 * (1 - (t - WAFER_T.clearStart) / (WAFER_T.clearEnd + 0.4 - WAFER_T.clearStart));
        ctx.beginPath();
        ctx.arc(g.cx, g.cy, Math.max(0.1, prog.ring), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };

    const frame = (now: number) => {
      raf = 0;
      if (!visible || document.hidden || pausedRef.current || mq.matches) return;
      const { round: r, t } = waferClock(clock.elapsed(now));
      // A new book at each round boundary; every round starts and ends sealed, so even a long
      // frame that skips a boundary lands on a complete wafer.
      if (r !== round) {
        round = r;
        newBook();
        lastKey = "";
      }
      draw(t);
      raf = requestAnimationFrame(frame);
    };
    const play = () => {
      if (raf || !visible || document.hidden || pausedRef.current || mq.matches) return;
      clock.start(performance.now());
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      clock.pause(performance.now());
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };
    const still = () => {
      lastKey = "";
      draw(WAFER_T.still);
    };
    // Pausing keeps the frame on screen; resuming continues the round where it stopped.
    const onPause = (e: Event) => {
      if ((e as CustomEvent<boolean>).detail) stop();
      else play();
    };

    // The stage may have no size yet (a narrow layout still settling): the resize observer builds it then.
    if (build()) {
      if (mq.matches) still();
      else draw(0);
    }

    const io = new IntersectionObserver((es) => {
      visible = es.some((e) => e.isIntersecting);
      if (visible) play();
      else stop();
    });
    io.observe(el);
    const onVis = () => (document.hidden ? stop() : play());
    document.addEventListener("visibilitychange", onVis);
    const onMq = () => {
      setReduced(mq.matches);
      if (mq.matches) {
        stop();
        still();
      } else play();
    };
    mq.addEventListener("change", onMq);
    let rt = 0;
    const ro = new ResizeObserver(() => {
      window.clearTimeout(rt);
      rt = window.setTimeout(() => {
        const r = el.getBoundingClientRect();
        if (Math.round(r.width) === W && Math.round(r.height) === H) return;
        if (!build()) return;
        if (mq.matches || pausedRef.current) still();
        else draw(waferClock(clock.elapsed(performance.now())).t);
      }, 150);
    });
    ro.observe(el);
    // Theme changes: read the palette again and repaint the current frame.
    const retheme = () => {
      readColours();
      lastKey = "";
      if (mq.matches || pausedRef.current) still();
    };
    const mo = new MutationObserver(retheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    dark.addEventListener("change", retheme);
    el.addEventListener("wafer-pause", onPause);
    return () => {
      stop();
      io.disconnect();
      ro.disconnect();
      mo.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      mq.removeEventListener("change", onMq);
      dark.removeEventListener("change", retheme);
      el.removeEventListener("wafer-pause", onPause);
      window.clearTimeout(rt);
    };
  }, [anchor]);

  useEffect(() => {
    const mq = motionQuery();
    setReduced(mq.matches);
  }, []);

  const toggle = () => {
    const p = !paused;
    setPaused(p);
    pausedRef.current = p;
    host.current?.dispatchEvent(new CustomEvent("wafer-pause", { detail: p }));
  };

  return (
    <div className="wafer" ref={host}>
      <canvas ref={canvas} aria-hidden="true" />
      <div className="wafer-cap">
        <p aria-live="off">
          <span className="tag flag">Simulated</span>{" "}
          {cap ? (
            <>
              <b>{fmtInt(cap.orders)}</b> sealed orders, one per die, cleared {cap.price === null ? <b>with no trade</b> : <>at <b>{dollarsOfPrice(cap.price, WAFER_TICK)} /GPU-h</b></>}
              <span className="wafer-more">
                {" "}
                · {fmtInt(cap.volume)} GPU-h matched · {cap.filledPct}% of orders filled
              </span>
            </>
          ) : (
            "A sealed round on a wafer: each die is one order."
          )}
          <span className="wafer-more"> · book centred on {anchorIsLive ? "the live index" : "an example price"}</span>
          {reduced ? <span className="wafer-more"> · still frame, motion reduced</span> : null}
        </p>
        <span className="wafer-key" aria-hidden="true">
          <i className="key-long" /> buyers <i className="key-short" /> sellers
        </span>
        {reduced ? null : (
          <button type="button" className="wafer-pause" onClick={toggle} aria-pressed={paused} aria-label={paused ? "Play the wafer" : "Pause the wafer"}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor">
              {paused ? <path d="M5 3.5v9l7-4.5Z" /> : <path d="M4.5 3.5h2.5v9H4.5zM9 3.5h2.5v9H9z" />}
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
