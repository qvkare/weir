// Section 10: the fixing, the void rule and what each unit pays.
import { ERR } from "./errors.ts";

export interface SettlementInput {
  floor: number;
  band: number;
  /** The series' accumulator. */
  sum: bigint;
  count: number;
  /** `now >= delivery_end + void_after_secs`. */
  voidAllowed: boolean;
  minPrints: number;
}

export interface Payouts {
  longPayout: number;
  shortPayout: number;
}

export interface SettlementOutcome extends Payouts {
  fixing: number;
  void: boolean;
}

export function fixingOf(input: SettlementInput): { fixing: number; void: boolean } {
  const { sum, count, floor, band } = input;
  if (count >= input.minPrints) return { fixing: Number(sum / BigInt(count)), void: false };
  if (!input.voidAllowed) throw new Error(ERR.NOT_ENOUGH_PRINTS);
  const fixing = count >= 1 ? Number(sum / BigInt(count)) : floor + Math.floor(band / 2);
  return { fixing, void: true };
}

export function payouts(fixing: number, floor: number, band: number): Payouts {
  const longPayout = Math.min(Math.max(fixing - floor, 0), band);
  return { longPayout, shortPayout: band - longPayout };
}

export function settleSeries(input: SettlementInput): SettlementOutcome {
  const { fixing, void: isVoid } = fixingOf(input);
  return { fixing, void: isVoid, ...payouts(fixing, input.floor, input.band) };
}

/** What `redeem` credits for a position on a settled series. */
export function redeemAmount(position: { long: number; short: number }, p: Payouts): bigint {
  return BigInt(position.long) * BigInt(p.longPayout) + BigInt(position.short) * BigInt(p.shortPayout);
}
