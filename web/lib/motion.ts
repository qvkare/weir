// The motion system (DESIGN section 7). Durations and easings shared by CSS (globals.css repeats
// them as --dur-* and --ease-*) and by the Web Animations scores that drive the hero and the
// drawings on /how. A score is plain data: tracks keyed by `data-track` names, and beats that
// caption each step. It is built on the server and played in the browser.

export const DUR = {
  /** Hover, press, focus: the interface answering a hand. */
  micro: 120,
  /** Toggles, tabs, a row changing state. */
  quick: 200,
  /** Something arriving or being revealed. */
  base: 320,
  /** A value that changed under you: long enough to notice, short enough to ignore. */
  settle: 560,
  /** A line drawing itself. */
  draw: 900,
} as const;

export const EASE = {
  /** Arrivals and reveals: quick start, soft landing. */
  out: "cubic-bezier(0.22, 0.61, 0.36, 1)",
  /** Lines and sweeps that travel: symmetric, unhurried. */
  inOut: "cubic-bezier(0.65, 0, 0.35, 1)",
  /** Progress and clocks: time itself. */
  linear: "linear",
} as const;

export type Frame = Record<string, string | number>;

export interface Track {
  /** Matches every element with `data-track="<target>"` inside the figure. */
  target: string;
  keyframes: Frame[];
  /** Milliseconds from the start of the score. */
  start: number;
  duration: number;
  easing?: string;
}

export interface Beat {
  /** When this step starts, in ms. A step ends where the next begins, the last at `total`. */
  at: number;
  /** One short sentence: what this step shows. */
  label: string;
}

export interface Score {
  total: number;
  tracks: Track[];
  beats: Beat[];
}

// Common keyframes.
export const enter: Frame[] = [
  { opacity: 0, transform: "translateY(6px)" },
  { opacity: 1, transform: "translateY(0)" },
];
export const fadeIn: Frame[] = [{ opacity: 0 }, { opacity: 1 }];
export const fadeOut: Frame[] = [{ opacity: 1 }, { opacity: 0 }];
/** For a path with pathLength=1 and stroke-dasharray 1. */
export const draw: Frame[] = [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }];
export const pop: Frame[] = [
  { opacity: 0, transform: "scale(0.2)" },
  { opacity: 1, transform: "scale(1.25)", offset: 0.6 },
  { opacity: 1, transform: "scale(1)" },
];
export const grow: Frame[] = [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }];
export const growY: Frame[] = [{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }];

export const track = (target: string, keyframes: Frame[], start: number, duration: number = DUR.base, easing: string = EASE.out): Track => ({ target, keyframes, start, duration, easing });

/** The step showing at time t: the last beat that has started. */
export function beatAt(score: Pick<Score, "beats">, t: number): number {
  let i = 0;
  score.beats.forEach((b, j) => {
    if (b.at <= t) i = j;
  });
  return i;
}

/** Where a step ends: the next beat's start, or the end of the score. Seeking here shows it complete. */
export function beatEnd(score: Pick<Score, "beats" | "total">, i: number): number {
  return score.beats[i + 1]?.at ?? score.total;
}

/** Problems with a score, empty when it is sound: every track inside [0, total], beats in order from 0. */
export function checkScore(score: Score): string[] {
  const out: string[] = [];
  if (!(score.total > 0)) out.push("total must be positive");
  for (const t of score.tracks) {
    if (t.start < 0) out.push(`${t.target} starts before 0`);
    if (t.duration < 0) out.push(`${t.target} has a negative duration`);
    if (t.start + t.duration > score.total + 0.5) out.push(`${t.target} ends after the score (${t.start + t.duration} > ${score.total})`);
    if (t.keyframes.length < 2) out.push(`${t.target} needs two keyframes`);
  }
  if (score.beats[0]?.at !== 0) out.push("the first beat must start at 0");
  for (let i = 1; i < score.beats.length; i++) if (score.beats[i]!.at <= score.beats[i - 1]!.at) out.push(`beat ${i} does not follow beat ${i - 1}`);
  return out;
}
