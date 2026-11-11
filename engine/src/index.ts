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

/** The price a bucket's reports decide, or null for no print. With an even count the two
 * middle reports must agree within `maxSpreadBps` of the lower one; the product is bigint
 * because price * 10000 can pass 2^53. */
export function decidePrint(reports: readonly number[], quorum: number, maxSpreadBps: number): number | null {
  const n = reports.length;
  if (n < quorum || n === 0) return null;
  if (n % 2 === 0) {
    const sorted = [...reports].sort((a, b) => a - b);
    const lo = sorted[n / 2 - 1]!;
    const hi = sorted[n / 2]!;
    if (BigInt(hi - lo) * 10_000n > BigInt(lo) * BigInt(maxSpreadBps)) return null;
  }
  return median(reports);
}

export type PrintState = "Open" | "Final" | "NoPrint";

export interface PrintInput {
  /** The prices reported for the bucket so far. */
  reports: readonly number[];
  quorum: number;
  /** How many reporters there are. */
  reporters: number;
  maxSpreadBps: number;
  /** Whether the bucket's report window has closed. */
  windowClosed: boolean;
}

export interface PrintDecision {
  state: PrintState;
  /** The print's price when `state` is `Final`, else null. */
  price: number | null;
}

/** A bucket is decided once every reporter has reported or its window has closed. */
export function printDecision(input: PrintInput): PrintDecision {
  if (input.reports.length < input.reporters && !input.windowClosed) return { state: "Open", price: null };
  const price = decidePrint(input.reports, input.quorum, input.maxSpreadBps);
  return price === null ? { state: "NoPrint", price: null } : { state: "Final", price };
}
