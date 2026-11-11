// Section 6.1: the band a series is opened with, fixed for its whole life.
import { ERR } from "./errors.ts";

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
  if (half < tick) throw new Error(ERR.BAND_TOO_NARROW);
  if (half > mid) throw new Error(ERR.BAND_TOO_WIDE);
  return { mid, half, floor: mid - half, band: 2 * half };
}
