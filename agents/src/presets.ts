// The two market presets, as the contract's `new(params)` JSON (SPEC section 3). Deployment
// uses the same numbers and replaces only `usdc`, `reporters` and `t0`.
import type { WireParams } from "@weir/engine";

export type PresetName = "weekly" | "fast";

/** Monday 2026-01-05 00:00 UTC: delivery start of series 0 in the simulation. */
export const SIM_T0 = 1_767_571_200;

const DAY = 86_400;

const common = {
  usdc: "usdc.sim",
  underlying: "H100-USD-HR",
  t0: SIM_T0,
  // 15%: the smallest band holding the fixing in at least 95% of 69 historical delivery
  // weeks (68 of 69). See backtest/results/summary.md.
  band_bps: 1500,
  tick: 1000,
  max_move_bps: 1500,
  forfeit_bps: 100,
  min_lock: "1000000",
  max_commits: 64,
  max_order_size: 10_000,
  reporters: ["reporter-a", "reporter-b", "reporter-c"],
  quorum: 2,
} as const;

export const PRESETS: Readonly<Record<PresetName, Readonly<WireParams>>> = {
  /** Weekly delivery, auctioned the week before: hourly rounds (45 min commit, 15 min reveal)
   * from 7 days + 1 hour before delivery starts until 1 hour before it, 168 rounds. With
   * `lead = period + cutoff` exactly one series is in auction at any time, always the next one
   * to be delivered. Hourly prints; settlement needs 126 of 168 (75%). */
  weekly: {
    ...common,
    reporters: [...common.reporters],
    period_secs: 7 * DAY,
    lead_secs: 7 * DAY + 3600,
    cutoff_secs: 3600,
    commit_secs: 2700,
    reveal_secs: 900,
    print_interval_secs: 3600,
    report_grace_secs: 900,
    min_prints: 126,
    void_after_secs: 2 * DAY,
    max_anchor_age_secs: 3 * 3600,
  },
  /** The same market 168 times faster, for demos: hourly delivery, auctioned the hour before
   * in 5-minute rounds (3 min commit, 2 min reveal) from 65 to 5 minutes before delivery,
   * 12 rounds per series. Prints every 5 minutes; settlement needs 9 of 12. */
  fast: {
    ...common,
    reporters: [...common.reporters],
    period_secs: 3600,
    lead_secs: 3900,
    cutoff_secs: 300,
    commit_secs: 180,
    reveal_secs: 120,
    print_interval_secs: 300,
    report_grace_secs: 60,
    min_prints: 9,
    void_after_secs: 1800,
    max_anchor_age_secs: 900,
  },
};
