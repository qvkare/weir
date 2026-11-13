"use client";
// "One market, four views": a tablist over the application's own views (ours). The active tab
// carries a progress fill and advances by itself every 9 s; it pauses while the pointer or the
// focus is in the section and while the tab is hidden, and never moves under reduced motion or
// ?motion=reduce. The panel cross-fades. A real tablist: arrow keys, Home and End move between tabs.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils.ts";

export interface ViewTab {
  id: string;
  label: string;
  caption: ReactNode;
  panel: ReactNode;
}

const STEP_MS = 9000;

export function FourViews({ tabs }: { tabs: ViewTab[] }) {
  const [i, setI] = useState(0);
  const [held, setHeld] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [moving, setMoving] = useState(false);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    const reduce = document.documentElement.getAttribute("data-motion") === "reduce" || matchMedia("(prefers-reduced-motion: reduce)").matches;
    setMoving(!reduce);
    const vis = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", vis);
    return () => document.removeEventListener("visibilitychange", vis);
  }, []);
  const paused = !moving || held || hidden;
  const go = (n: number, focus = false) => {
    const k = (n + tabs.length) % tabs.length;
    setI(k);
    if (focus) refs.current[k]?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight") go(i + 1, true);
    else if (e.key === "ArrowLeft") go(i - 1, true);
    else if (e.key === "Home") go(0, true);
    else if (e.key === "End") go(tabs.length - 1, true);
    else return;
    e.preventDefault();
  };
  const t = tabs[i]!;
  return (
    <div onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)} onFocusCapture={() => setHeld(true)} onBlurCapture={() => setHeld(false)}>
      <div role="tablist" aria-label="Views of the market" className="mb-6 flex flex-wrap gap-x-8 gap-y-2 border-b border-border" onKeyDown={onKey}>
        {tabs.map((x, k) => (
          <button
            key={x.id}
            ref={(el) => {
              refs.current[k] = el;
            }}
            id={`tab-${x.id}`}
            type="button"
            role="tab"
            aria-selected={k === i}
            aria-controls={`panel-${x.id}`}
            tabIndex={k === i ? 0 : -1}
            onClick={() => go(k)}
            className={cn("relative -mb-px cursor-pointer border-0 bg-transparent px-0 pb-3 pt-1 font-sans text-base transition-colors", k === i ? "text-foreground" : "text-muted-foreground hover:text-foreground")}
          >
            {x.label}
            <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-0.5 bg-border" />
            {k === i ? (
              moving ? (
                <span key={`${x.id}-${i}`} aria-hidden="true" className="tab-progress absolute bottom-0 left-0 h-0.5 bg-foreground" style={{ animationPlayState: paused ? "paused" : "running", animationDuration: `${STEP_MS}ms` }} onAnimationEnd={() => go(i + 1)} />
              ) : (
                <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-0.5 bg-foreground" />
              )
            ) : null}
          </button>
        ))}
      </div>
      <div id={`panel-${t.id}`} role="tabpanel" aria-labelledby={`tab-${t.id}`} key={t.id} className="front-fade">
        {t.panel}
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-4">
        <div className="flex gap-2">
          <button type="button" onClick={() => go(i - 1)} aria-label="Previous view" className="grid size-9 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-foreground ring-1 ring-border transition-colors hover:bg-muted">
            &larr;
          </button>
          <button type="button" onClick={() => go(i + 1)} aria-label="Next view" className="grid size-9 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-foreground ring-1 ring-border transition-colors hover:bg-muted">
            &rarr;
          </button>
        </div>
        <p className="m-0 max-w-none text-sm text-muted-foreground">{t.caption}</p>
      </div>
    </div>
  );
}
