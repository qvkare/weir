import { fairLong, fit, minSize, pct, type Strategy } from "../strategy.ts";

/** A GPU owner with `capacity` GPU-hours to rent out in the delivery week. SHORT pays it the
 * index's fall below the top of the band, so holding `capacity` SHORT fixes its revenue. */
export function seller(id: string, opts: { capacity: number; premiumBps: number }): Strategy {
  return {
    id,
    role: "seller",
    rule:
      `Rents out ${opts.capacity} GPU-hours in the delivery week; each round bids SHORT for its unhedged hours spread over ` +
      `the rounds left, accepting a LONG price down to its forecast minus ${pct(opts.premiumBps)} of the band.`,
    decide(v) {
      const fair = fairLong(v);
      const unhedged = opts.capacity - (v.position.short - v.position.long);
      if (fair === null || unhedged <= 0) return [];
      const reservation = fair - (v.band * opts.premiumBps) / 10_000;
      const size = Math.min(unhedged, Math.max(Math.ceil(unhedged / Math.max(1, v.roundsLeft)), minSize(v, v.band - reservation)));
      return fit(v, [{ side: "Short", size, price: reservation }]);
    },
  };
}
