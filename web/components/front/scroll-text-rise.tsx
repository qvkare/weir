"use client";
// Adapted from Ruixen UI "scroll-text-rise" (https://ruixen.com/r/scroll-text-rise.json).
// MIT, Copyright (c) 2025 Ruixen UI. Changes: driven by the page's scroll over a runway (not an
// inner scroll box); unread words at 20% opacity; a note under the sentence; with reduced motion
// (the system setting or ?motion=reduce) the sentence is simply shown, with no runway. Fail open:
// the static HTML and any browser that has not yet run an animation frame show the whole
// sentence; the runway and the 20%-to-full reveal start only once a frame has fired.
import { motion, useReducedMotion, useScroll, useTransform, type MotionValue } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";

export function ScrollTextRise({ id, label, text, note }: { id: string; label: string; text: string; note?: ReactNode }) {
  const ref = useRef<HTMLElement | null>(null);
  const system = useReducedMotion();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (document.documentElement.getAttribute("data-motion") === "reduce") return;
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const still = !!system || !ready;
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end end"] });
  const words = text.split(" ");
  const sentence = (
    <p className="mx-auto max-w-4xl text-balance text-center text-4xl font-medium tracking-[-0.02em] text-foreground">
      {words.map((w, i) =>
        // Real spaces between the words, so copying and screen readers get the sentence.
        still ? (
          <span key={i}>{i ? " " : ""}{w}</span>
        ) : (
          <span key={i}>
            {i ? " " : ""}
            <Word progress={scrollYProgress} range={[(i / words.length) * 0.8, (i / words.length) * 0.8 + 0.06]}>
              {w}
            </Word>
          </span>
        ),
      )}
    </p>
  );
  const body = (
    <div className="mx-auto max-w-[1278px] px-6">
      <h2 className="sr-only">{label}</h2>
      {sentence}
      {note ? <p className="mx-auto mt-8 max-w-2xl text-center text-sm text-muted-foreground">{note}</p> : null}
    </div>
  );
  // One <section> in both states, so the scroll target is the same element from the first render.
  return (
    <section id={id} ref={ref} aria-label={label} className={still ? "py-28 md:py-40" : "relative h-[170vh]"}>
      <div className={still ? undefined : "sticky top-0 flex h-screen items-center"}>{body}</div>
    </section>
  );
}

function Word({ children, progress, range }: { children: ReactNode; progress: MotionValue<number>; range: [number, number] }) {
  const opacity = useTransform(progress, range, [0.2, 1]);
  const y = useTransform(progress, range, [8, 0]);
  return (
    <motion.span style={{ opacity, y }} className="inline-block">
      {children}
    </motion.span>
  );
}
