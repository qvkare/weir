import { fairLong, fit, pct, roundShare, type Strategy } from "../strategy.ts";

/** A GPU owner with `capacity` GPU-hours to rent out in the delivery week. SHORT pays it the
 * index's fall below the top of the band, so holding `capacity` SHORT fixes its revenue. */
export function seller(id: string, opts: { capacity: number; premiumBps: number }): Strategy {
  return {
    id,
    role: "seller",
    rule:
      `Rents out ${opts.capacity} GPU-hours in the delivery week; each round bids SHORT for its unhedged hours spread over ` +
      `the rounds left (when that share is below the smallest order worth its fee, the smallest order, on some rounds), accepting a LONG price down to its forecast minus ${pct(opts.premiumBps)} of the band.`,
    decide(v, rng) {
      const fair = fairLong(v);
      const unhedged = opts.capacity - (v.position.short - v.position.long);
      if (fair === null || unhedged <= 0) return [];
      const reservation = fair - (v.band * opts.premiumBps) / 10_000;
      const size = roundShare(v, unhedged, v.band - reservation, rng);
      if (size === 0) return [];
      return fit(v, [{ side: "Short", size, price: reservation }]);
    },
  };
}
