"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { DUR, EASE } from "@/lib/motion.ts";

/**
 * A figure that comes from live data. When its text changes after a refresh, it settles in
 * once (a short rise and a tint that fades), so a moved number is noticed. Nothing moves on
 * first paint or when the value is unchanged.
 */
export function LiveValue({ text, children }: { text: string; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef(text);
  useEffect(() => {
    if (prev.current === text) return;
    prev.current = text;
    const el = ref.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    el.animate(
      [
        { transform: "translateY(0.18em)", opacity: 0.4, backgroundColor: "var(--flag-soft)" },
        { transform: "translateY(0)", opacity: 1, backgroundColor: "var(--flag-soft)", offset: 0.4 },
        { backgroundColor: "transparent" },
      ],
      { duration: DUR.settle * 2, easing: EASE.out },
    );
  }, [text]);
  return (
    <span ref={ref} className="live-value">
      {children}
    </span>
  );
}
