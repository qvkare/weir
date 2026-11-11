import { fairLong, fit, minSize, pct, type Strategy } from "../strategy.ts";

/** A small trader with an opinion that is noise: it gives the auction volume and the other
 * strategies someone to trade with at prices away from fair value. */
export function noise(id: string, opts: { viewBps: number; minSize: number; maxSize: number }): Strategy {
  return {
    id,
    role: "noise",
    rule:
      `Each round draws a random view within ${pct(opts.viewBps)} of the band around the forecast and bids ` +
      `${opts.minSize} to ${opts.maxSize} GPU-hours (at least the smallest order worth its fee) at that view: LONG if above the forecast, SHORT if below.`,
    decide(v, rng) {
      const fair = fairLong(v);
      if (fair === null) return [];
      const view = fair + (rng() * 2 - 1) * ((v.band * opts.viewBps) / 10_000);
      const side = view >= fair ? "Long" : "Short";
      const drawn = opts.minSize + Math.floor(rng() * (opts.maxSize - opts.minSize + 1));
      // Never below the smallest order worth its fee.
      const size = Math.max(drawn, minSize(v, side === "Long" ? view : v.band - view));
      return fit(v, [{ side, size, price: view }]);
    },
  };
}
