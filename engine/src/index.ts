// Section 9: turning reporters' numbers into a print.

/** Median; for an even count, the mean of the two middle values rounded down. */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median of no values");
  const sorted = [...values].sort((a, b) => a - b);
  const upper = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[upper]!;
  const a = sorted[upper - 1]!;
  const b = sorted[upper]!;
  // a + (b - a) / 2 equals floor((a + b) / 2) for a <= b and never leaves the safe range.
  return a + Math.floor((b - a) / 2);
}

/** Whether `candidate` moved further than `maxMoveBps` from `last`. Products are bigint
 * because price * 10000 can pass 2^53. */
export function isFar(candidate: number, last: number, maxMoveBps: number): boolean {
  const move = BigInt(Math.abs(candidate - last));
  return move * 10_000n > BigInt(last) * BigInt(maxMoveBps);
}

export interface PrintInput {
  /** The prices reported so far for the bucket, including the one just stored. */
  reports: readonly number[];
  /** The last print's price when its bucket is lower than this one, else null. */
  last: number | null;
  quorum: number;
  /** How many reporters there are. */
  reporters: number;
  maxMoveBps: number;
}

export interface PrintDecision {
  final: boolean;
  /** The candidate median when final, else null. */
  price: number | null;
}

export function printDecision(input: PrintInput): PrintDecision {
  const n = input.reports.length;
  const candidate = median(input.reports);
  const far = input.last !== null && isFar(candidate, input.last, input.maxMoveBps);
  const final = (n >= input.quorum && !far) || n === input.reporters;
  return { final, price: final ? candidate : null };
}
