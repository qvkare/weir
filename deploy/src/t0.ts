// `t0`, the delivery start of series 0 (SPEC sections 3 and 4), chosen at deployment.
//
// The rule: t0 is the delivery start whose auction window contains `now`. Delivery starts sit
// on a natural grid: the top of every hour for the fast market (period 3600 s), Monday 00:00
// UTC for the weekly ones (period 7 days). Series s is auctioned during
//   [t0 + s*period - lead, t0 + s*period - cutoff)
// and with lead = period + cutoff (both presets) these windows follow each other with no gap,
// so exactly one grid point D satisfies  D - lead <= now < D - cutoff,  namely the first grid
// point strictly after now + cutoff. Taking it as t0 makes series 0 the series in auction at
// deployment: its auction is open at once, so trading can start as soon as the index has a
// print, and no earlier series exists whose window has already passed unused.
import type { WireParams } from "../../engine/src/mod.ts";

/** Unix time of Monday 1970-01-05 00:00 UTC, the first Monday of the epoch. */
export const FIRST_MONDAY = 345_600;
export const HOUR = 3600;
export const WEEK = 7 * 86_400;

export interface T0Choice {
  t0: number;
  /** The grid the delivery starts are on: `offset + k * step`. */
  grid: { step: number; offset: number; name: string };
  auctionOpen: number;
  auctionClose: number;
  /** One sentence for the plan. */
  reason: string;
}

type TimeFields = Pick<WireParams, "period_secs" | "lead_secs" | "cutoff_secs" | "print_interval_secs" | "commit_secs" | "reveal_secs">;

export function gridFor(p: TimeFields): T0Choice["grid"] {
  if (p.period_secs === HOUR) return { step: HOUR, offset: 0, name: "the top of an hour" };
  if (p.period_secs === WEEK) return { step: WEEK, offset: FIRST_MONDAY, name: "Monday 00:00 UTC" };
  throw new Error(`no natural boundary is defined for period_secs ${p.period_secs}`);
}

const iso = (t: number) => new Date(t * 1000).toISOString().replace(".000Z", "Z");

export function chooseT0(p: TimeFields, now: number): T0Choice {
  const grid = gridFor(p);
  if (p.lead_secs !== p.period_secs + p.cutoff_secs) throw new Error("t0 rule needs lead_secs = period_secs + cutoff_secs");
  if (grid.step % p.print_interval_secs !== 0 || grid.offset % p.print_interval_secs !== 0) throw new Error("the grid is not a multiple of print_interval_secs");
  const k = Math.floor((now + p.cutoff_secs - grid.offset) / grid.step) + 1;
  const t0 = grid.offset + k * grid.step;
  const auctionOpen = t0 - p.lead_secs;
  const auctionClose = t0 - p.cutoff_secs;
  if (!(auctionOpen <= now && now < auctionClose)) throw new Error("internal: t0 does not put now in series 0's auction window");
  const round = p.commit_secs + p.reveal_secs;
  const r = Math.floor((now - auctionOpen) / round);
  const left = auctionClose - now;
  const reason =
    `t0 = ${iso(t0)} (${t0}), ${grid.name}, the first such time after now + cutoff_secs (${p.cutoff_secs} s). ` +
    `Series 0 is auctioned from ${iso(auctionOpen)} to ${iso(auctionClose)}, which contains now (${iso(now)}): ` +
    `round ${r} of ${Math.floor((p.lead_secs - p.cutoff_secs) / round)} is under way and the window has ${left} s left; ` +
    "series 1's auctions follow without a gap.";
  return { t0, grid, auctionOpen, auctionClose, reason };
}
