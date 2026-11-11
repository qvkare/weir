"use client";
import { motionQuery } from "@/lib/reduced-motion.ts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { beatAt, beatEnd, EASE, type Score } from "@/lib/motion.ts";

// Plays a Score (lib/motion.ts) over the elements inside it that carry `data-track`, with the
// Web Animations API. The markup is always the final frame: with scripts off, under
// prefers-reduced-motion, or before the score is bound, the figure shows how it ends.

type Mode = "film" | "steps";

const useIsoLayout = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function MotionFigure({
  score,
  summary,
  render,
  mode = "steps",
  autoplay = true,
  className,
  name,
}: {
  score: Score;
  /** The final frame in words: the text alternative, and the caption under reduced motion. */
  summary: string;
  /** Draws the stage at its measured width (null before the browser has measured it). */
  render: (width: number | null) => ReactNode;
  /** film: play, pause and replay. steps: back, play and next, one beat at a time. */
  mode?: Mode;
  /** Play once when the figure first comes into view. */
  autoplay?: boolean;
  className?: string;
  /** What the figure shows, for the control labels ("Play the clearing"). */
  name: string;
}) {
  const root = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLSpanElement>(null);
  const anims = useRef<Animation[]>([]);
  const master = useRef<Animation | null>(null);
  const pos = useRef(score.total);
  const wantPlay = useRef(false);
  const seen = useRef(false);

  const [width, setWidth] = useState<number | null>(null);
  const [reduced, setReduced] = useState<boolean | null>(null);
  const [bound, setBound] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [beat, setBeat] = useState(score.beats.length - 1);
  const [touched, setTouched] = useState(false);
  /** The beat on show is complete (its end frame), as after stepping or at the end. */
  const [done, setDone] = useState(true);
  const last = score.beats.length - 1;

  // Width of the stage, for drawings that lay out at real pixels.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => setWidth(Math.floor(el.getBoundingClientRect().width));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const mq = motionQuery();
    const set = () => setReduced(mq.matches);
    set();
    mq.addEventListener("change", set);
    return () => mq.removeEventListener("change", set);
  }, []);

  const now = () => Number(master.current?.currentTime ?? pos.current);

  const bind = useCallback(() => {
    const el = root.current;
    if (!el) return;
    for (const a of anims.current) a.cancel();
    const list: Animation[] = [];
    for (const tr of score.tracks) {
      el.querySelectorAll<HTMLElement | SVGElement>(`[data-track="${tr.target}"]`).forEach((node) => {
        list.push(node.animate(tr.keyframes as Keyframe[], { delay: tr.start, duration: tr.duration, easing: tr.easing ?? EASE.out, fill: "both" }));
      });
    }
    const m = (bar.current ?? el).animate(bar.current ? [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }] : {}, { duration: score.total, easing: "linear", fill: "both" });
    list.push(m);
    m.onfinish = () => {
      pos.current = score.total;
      wantPlay.current = false;
      setPlaying(false);
      setBeat(last);
      setDone(true);
    };
    for (const a of list) {
      a.currentTime = pos.current;
      if (wantPlay.current) a.play();
      else a.pause();
    }
    anims.current = list;
    master.current = m;
    setBound(true);
  }, [score, last]);

  // Bind once motion is allowed and the stage is drawn; rebind when the drawing is redrawn at a new width.
  useIsoLayout(() => {
    if (reduced === null || width === null) return;
    if (reduced && !touched) return;
    if (!bound && autoplay && !reduced && !seen.current) pos.current = 0;
    if (anims.current.length) pos.current = now();
    bind();
    if (!bound && autoplay && !reduced && pos.current === 0) {
      setBeat(0);
      setDone(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced, width, touched]);

  useEffect(() => () => anims.current.forEach((a) => a.cancel()), []);

  const play = useCallback(() => {
    if (!anims.current.length) bind();
    if (now() >= score.total - 1) {
      pos.current = 0;
      for (const a of anims.current) a.currentTime = 0;
    }
    wantPlay.current = true;
    for (const a of anims.current) a.play();
    setPlaying(true);
    setDone(false);
  }, [bind, score.total]);

  const pause = useCallback(() => {
    wantPlay.current = false;
    for (const a of anims.current) a.pause();
    pos.current = now();
    setPlaying(false);
  }, []);

  const seek = (t: number, b: number, complete: boolean) => {
    setTouched(true);
    if (!anims.current.length) {
      pos.current = t;
      bind();
    }
    wantPlay.current = false;
    for (const a of anims.current) {
      a.pause();
      a.currentTime = t;
    }
    pos.current = t;
    setPlaying(false);
    setBeat(b);
    setDone(complete);
  };
  const stepTo = (k: number) => seek(beatEnd(score, k), k, true);
  const next = () => stepTo(Math.min(last, playing || !done ? beat : beat + 1));
  const back = () => (beat > 0 ? stepTo(beat - 1) : seek(0, 0, false));

  // Autoplay once, the first time at least a third of the figure is in view.
  useEffect(() => {
    if (!autoplay || reduced !== false || !bound) return;
    const el = root.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting) && !seen.current) {
          seen.current = true;
          play();
          io.disconnect();
        }
      },
      { threshold: 0.33 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [autoplay, reduced, bound, play]);

  // Follow the beats while playing.
  useEffect(() => {
    if (!playing) return;
    let id = 0;
    const step = () => {
      setBeat(beatAt(score, now()));
      id = requestAnimationFrame(step);
    };
    id = requestAnimationFrame(step);
    return () => cancelAnimationFrame(id);
  }, [playing, score]);

  const atEnd = !playing && beat === last && done;
  const caption = reduced && !touched ? summary : score.beats[beat]?.label ?? summary;
  const pending = autoplay && !bound;

  return (
    <figure ref={root} className={`mf mf-${mode}${className ? ` ${className}` : ""}`} data-pending={pending ? "" : undefined} data-playing={playing ? "" : undefined}>
      <div ref={stage} className="mf-stage" role="img" aria-label={summary}>
        {render(width)}
      </div>
      <figcaption className="mf-bar">
        <span className="mf-progress" aria-hidden="true">
          <span ref={bar} />
        </span>
        <div className="mf-row">
          <div className="mf-buttons">
            {mode === "steps" ? (
              <button type="button" className="mf-btn" onClick={back} disabled={beat === 0 && !playing && !done} aria-label={`Back one step: ${name}`}>
                <Glyph kind="back" />
              </button>
            ) : null}
            {reduced && mode === "film" ? null : (
              <button
                type="button"
                className="mf-btn mf-main"
                onClick={() => (playing ? pause() : play())}
                aria-label={playing ? `Pause ${name}` : atEnd ? `Play ${name} again` : `Play ${name}`}
                hidden={reduced === true && mode === "steps"}
              >
                <Glyph kind={playing ? "pause" : atEnd ? "replay" : "play"} />
                <span className="mf-btn-text">{playing ? "Pause" : atEnd ? "Replay" : "Play"}</span>
              </button>
            )}
            {mode === "steps" ? (
              <button type="button" className="mf-btn" onClick={next} disabled={atEnd} aria-label={`Next step: ${name}`}>
                <Glyph kind="next" />
              </button>
            ) : !reduced ? (
              <button type="button" className="mf-btn" onClick={() => {
                  seek(0, 0, false);
                  play();
                }} aria-label={`Replay ${name} from the start`}>
                <Glyph kind="replay" />
              </button>
            ) : null}
          </div>
          <p className="mf-caption" aria-live={playing ? "off" : "polite"}>
            {mode === "steps" ? (
              <span className="mf-count">
                {beat + 1}/{score.beats.length}
              </span>
            ) : null}
            {caption}
          </p>
        </div>
      </figcaption>
    </figure>
  );
}

function Glyph({ kind }: { kind: "play" | "pause" | "replay" | "back" | "next" }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      {kind === "play" ? <path d="M5 3.5v9l7-4.5Z" fill="currentColor" /> : null}
      {kind === "pause" ? <path d="M5.5 3.5v9M10.5 3.5v9" strokeWidth="2" /> : null}
      {kind === "replay" ? <path d="M3 8a5 5 0 1 0 1.6-3.7M3 2.5v2.8h2.8" /> : null}
      {kind === "back" ? <path d="M10 3.5 5.5 8l4.5 4.5" /> : null}
      {kind === "next" ? <path d="M6 3.5 10.5 8 6 12.5" /> : null}
    </svg>
  );
}
