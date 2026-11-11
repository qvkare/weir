// Section 6.1: the band a series is opened with, fixed for its whole life.

export interface Band {
  mid: number;
  half: number;
  floor: number;
  band: number;
}

export function computeBand(anchor: number, tick: number, bandBps: number): Band {
  const mid = anchor - (anchor % tick);
  // anchor * band_bps can pass 2^53 for large anchors, so the product is taken in bigint.
  const raw = Number((BigInt(anchor) * BigInt(bandBps)) / 10_000n);
  const half = raw - (raw % tick);
  if (half < tick) throw new Error("band is narrower than one tick");
  if (half > mid) throw new Error("band is wider than the anchor");
  return { mid, half, floor: mid - half, band: 2 * half };
}
