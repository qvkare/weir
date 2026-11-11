// Section 4: series and round timing. Phases come from the clock alone.

export interface TimeParams {
  t0: number;
  periodSecs: number;
  leadSecs: number;
  cutoffSecs: number;
  commitSecs: number;
  revealSecs: number;
}

export type Phase = "Commit" | "Reveal" | "Closed";

export interface PhaseInfo {
  round: number | null;
  phase: Phase;
}

export const deliveryStart = (p: TimeParams, series: number): number => p.t0 + series * p.periodSecs;

export const deliveryEnd = (p: TimeParams, series: number): number => deliveryStart(p, series) + p.periodSecs;

export const auctionOpen = (p: TimeParams, series: number): number =>
  Math.max(0, deliveryStart(p, series) - p.leadSecs);

export const auctionClose = (p: TimeParams, series: number): number => deliveryEnd(p, series) - p.cutoffSecs;

export const roundSecs = (p: TimeParams): number => p.commitSecs + p.revealSecs;

export const roundStart = (p: TimeParams, series: number, round: number): number =>
  auctionOpen(p, series) + round * roundSecs(p);

export const roundEnd = (p: TimeParams, series: number, round: number): number =>
  roundStart(p, series, round) + roundSecs(p);

export const roundExists = (p: TimeParams, series: number, round: number): boolean =>
  round >= 0 && roundEnd(p, series, round) <= auctionClose(p, series);

/** Rounds series `series` has: rounds `0 .. count-1` exist. */
export const roundCount = (p: TimeParams, series: number): number =>
  Math.max(0, Math.floor((auctionClose(p, series) - auctionOpen(p, series)) / roundSecs(p)));

/** The round and phase of `series` at `now`. `Closed` outside the auction window or between rounds. */
export function phaseAt(p: TimeParams, series: number, now: number): PhaseInfo {
  const open = auctionOpen(p, series);
  if (now < open || now >= auctionClose(p, series)) return { round: null, phase: "Closed" };
  const round = Math.floor((now - open) / roundSecs(p));
  if (!roundExists(p, series, round)) return { round: null, phase: "Closed" };
  const phase = now < roundStart(p, series, round) + p.commitSecs ? "Commit" : "Reveal";
  return { round, phase };
}

/** The time the phase returned by `phaseAt` ends, or null when it is `Closed`. */
export function phaseEndsAt(p: TimeParams, series: number, info: PhaseInfo): number | null {
  if (info.round === null) return null;
  const start = roundStart(p, series, info.round);
  return info.phase === "Commit" ? start + p.commitSecs : start + roundSecs(p);
}

/** The series whose delivery window contains `t`, or null before `t0`. */
export const seriesOf = (p: TimeParams, t: number): number | null =>
  t < p.t0 ? null : Math.floor((t - p.t0) / p.periodSecs);

/** Every series whose auction window contains `now`, in ascending order. */
export function liveSeries(p: TimeParams, now: number): number[] {
  // auction_close(s) > now  <=>  s >= floor((now + cutoff - t0) / period), and it grows with s,
  // so start there and walk up until auctions have not opened yet.
  const first = Math.max(0, Math.floor((now + p.cutoffSecs - p.t0) / p.periodSecs));
  const live: number[] = [];
  for (let s = first; s <= MAX_SERIES && auctionOpen(p, s) <= now; s++) {
    if (auctionClose(p, s) > now) live.push(s);
  }
  return live;
}

/** Series ids are u32. */
export const MAX_SERIES = 4_294_967_295;
