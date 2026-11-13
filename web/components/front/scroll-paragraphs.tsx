"use client";
// Three short paragraphs; the one being read is in the ink colour, the others grey, changing as
// the page scrolls (ours). Fail open: the static HTML, and any browser where the script or
// animation frames do not run, or where motion is reduced, shows every paragraph in full ink.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils.ts";

export function ScrollParagraphs({ id, label, items, note }: { id: string; label: string; items: ReactNode[]; note?: ReactNode }) {
  const ref = useRef<HTMLElement | null>(null);
  const [active, setActive] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (document.documentElement.getAttribute("data-motion") === "reduce" || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const r = el.getBoundingClientRect();
      const run = Math.max(1, r.height - innerHeight);
      const p = Math.min(0.999, Math.max(0, -r.top / run));
      setActive(Math.floor(p * items.length));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    addEventListener("scroll", onScroll, { passive: true });
    return () => {
      removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [items.length]);
  return (
    <section id={id} ref={ref} aria-label={label} className={cn("relative", active !== null ? "h-[220vh]" : "py-28 md:py-36")}>
      <div className={cn(active !== null && "sticky top-0 flex h-screen items-center")}>
        <div className="mx-auto max-w-[1278px] px-6">
          <h2 className="sr-only">{label}</h2>
          <div className="mx-auto flex max-w-3xl flex-col gap-8">
            {items.map((p, i) => (
              <p key={i} className={cn("m-0 max-w-none text-2xl leading-snug transition-colors duration-[var(--dur-base)] md:text-4xl md:leading-tight", active === null || active === i ? "text-foreground" : "text-muted-foreground/45")}>
                {p}
              </p>
            ))}
          </div>
          {note ? <p className="mx-auto mt-10 max-w-3xl text-sm text-muted-foreground">{note}</p> : null}
        </div>
      </div>
    </section>
  );
}
