import { fairLong, fit, pct, type Strategy } from "../strategy.ts";

/** A market maker: buys LONG below its fair value and SHORT above it, earning the spread
 * when both fill (a filled LONG and SHORT together are a fully backed set). */
export function maker(id: string, opts: { spreadBps: number; shareBps: number; maxSize: number }): Strategy {
  return {
    id,
    role: "maker",
    rule:
      `Quotes both sides around its forecast, a spread of ${pct(opts.spreadBps)} of the band wide, ` +
      `each side sized to ${pct(opts.shareBps)} of its free balance (at most ${opts.maxSize} GPU-hours).`,
    decide(v) {
      const fair = fairLong(v);
      if (fair === null) return [];
      const half = (v.band * opts.spreadBps) / 20_000;
      const budget = (v.free * BigInt(opts.shareBps)) / 10_000n;
      const bid = fair - half;
      const ask = fair + half;
      const sizeAt = (unit: number) => Math.min(opts.maxSize, Number(budget / BigInt(Math.max(1, Math.round(unit)))));
      return fit(v, [
        { side: "Long", size: sizeAt(bid), price: bid },
        { side: "Short", size: sizeAt(v.band - ask), price: ask },
      ]);
    },
  };
}
