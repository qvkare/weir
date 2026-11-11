// The Weir logo (DESIGN section 3). The mark is one stroke: a level line that runs flat, drops
// into a W and comes back to exactly the same level. Read one way it is a weir holding a
// river's level; read the other it is the W of the name. Two masters share that skeleton:
//   wide     32 x 24 grid, stroke 2.5: the lockup and anything 24 px tall or more
//   compact  24 x 24 grid, stroke 3, a narrower W so the banks stay long: favicons and app icons
// Joins use miterlimit 2: the shoulders (107 degrees) stay sharp, the three acute points are
// cut flat, which keeps them from reading heavier than the level line and makes the centre
// point a small crest.
import type { SVGProps } from "react";
import { MARK } from "@/lib/logo.ts";


type MarkProps = SVGProps<SVGSVGElement> & { variant?: keyof typeof MARK; cropped?: boolean };

/** The mark alone, in currentColor. Decorative: the caller names it. */
export function Mark({ variant = "wide", cropped = false, ...rest }: MarkProps) {
  const m = MARK[variant];
  return (
    <svg viewBox={cropped ? m.crop : m.viewBox} fill="none" aria-hidden="true" focusable="false" overflow="visible" {...rest}>
      <path d={m.d} stroke="currentColor" strokeWidth={m.stroke} strokeLinejoin="miter" strokeMiterlimit={2} strokeLinecap="butt" />
    </svg>
  );
}

/**
 * Mark and wordmark. The wordmark is Archivo at width 125, weight 800, tracking -0.02em. The
 * cropped mark is exactly cap height tall and sits on the baseline, so its level line is the
 * cap line of "Weir"; the gap between them is 0.28 em.
 */
export function Lockup({ className }: { className?: string }) {
  return (
    <span className={`lockup${className ? ` ${className}` : ""}`}>
      <Mark className="lockup-mark" cropped />
      <span className="lockup-word">Weir</span>
    </span>
  );
}
