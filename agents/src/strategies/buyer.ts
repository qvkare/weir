import { fairLong, fit, minSize, pct, type Strategy } from "../strategy.ts";

/** A compute buyer who will use `need` GPU-hours in the delivery week. LONG pays it the
 * index's rise above the floor, so holding `need` LONG fixes its compute bill. */
export function buyer(id: string, opts: { need: number; premiumBps: number }): Strategy {
  return {
    id,
    role: "buyer",
    rule:
      `Uses ${opts.need} GPU-hours in the delivery week; each round bids LONG for its unhedged hours spread over ` +
      `the rounds left, paying up to its forecast plus ${pct(opts.premiumBps)} of the band.`,
    decide(v) {
      const fair = fairLong(v);
      const unhedged = opts.need - (v.position.long - v.position.short);
      if (fair === null || unhedged <= 0) return [];
      const reservation = fair + (v.band * opts.premiumBps) / 10_000;
      const size = Math.min(unhedged, Math.max(Math.ceil(unhedged / Math.max(1, v.roundsLeft)), minSize(v, reservation)));
      return fit(v, [{ side: "Long", size, price: reservation }]);
    },
  };
}
