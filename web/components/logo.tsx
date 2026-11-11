// The Weir logo (DESIGN section 3): the Crew cut heatsink and the wordmark "Weir".
import type { SVGProps } from "react";
import { MARK, SMALL_BELOW } from "@/lib/logo.ts";

type MarkProps = SVGProps<SVGSVGElement> & {
  /** Rendered height in px: picks the full or the small cut. */
  size?: number;
  cut?: keyof typeof MARK;
  cropped?: boolean;
};

/** The mark alone, in currentColor. Decorative: the caller names it. */
export function Mark({ size = 48, cut, cropped = false, ...rest }: MarkProps) {
  const m = MARK[cut ?? (size < SMALL_BELOW ? "small" : "full")];
  return (
    <svg viewBox={cropped ? m.crop : m.viewBox} aria-hidden="true" focusable="false" {...rest}>
      <path d={m.d} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}

/**
 * Mark and wordmark. The wordmark is Geist 600 at -0.045 em. The small cut, cropped to its
 * ink, stands 0.92 em tall on the baseline, so the fin tops sit just above the cap height of
 * "Weir"; the gap is 0.3 em.
 */
export function Lockup({ className }: { className?: string }) {
  return (
    <span className={`lockup${className ? ` ${className}` : ""}`}>
      <Mark className="lockup-mark" cut="small" cropped />
      <span className="lockup-word">Weir</span>
    </span>
  );
}
