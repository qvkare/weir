// Section 10: the fixing, the void rule and what each unit pays.
import { ERR } from "./errors.ts";

export interface SettlementInput {
  floor: number;
  band: number;
  /** The series' accumulator. */
  sum: bigint;
  count: number;
  /** What the series' auctions traded: units, and units times price (section 7.3). */
  tradedUnits: number;
  tradedValue: bigint;
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

export function payouts(fixing: number, floor: number, band: number): Payouts {
  const longPayout = Math.min(Math.max(fixing - floor, 0), band);
  return { longPayout, shortPayout: band - longPayout };
}

export function settleSeries(input: SettlementInput): SettlementOutcome {
  const { floor, band } = input;
  if (input.count >= input.minPrints) {
    const fixing = Number(input.sum / BigInt(input.count));
    return { fixing, void: false, ...payouts(fixing, floor, band) };
  }
  if (!input.voidAllowed) throw new Error(ERR.NOT_ENOUGH_PRINTS);
  // A void series is unwound at the average price its own auctions traded at, so a
  // missing index undoes the hedge instead of deciding it on a partial number.
  const longPayout =
    input.tradedUnits > 0 ? Number(input.tradedValue / BigInt(input.tradedUnits)) : Math.floor(band / 2);
  return { fixing: floor + longPayout, void: true, longPayout, shortPayout: band - longPayout };
}

/** The fixing alone, and whether the series is void. */
export function fixingOf(input: SettlementInput): { fixing: number; void: boolean } {
  const { fixing, void: isVoid } = settleSeries(input);
  return { fixing, void: isVoid };
}

/** What `redeem` credits for a position on a settled series. */
export function redeemAmount(position: { long: number; short: number }, p: Payouts): bigint {
  return BigInt(position.long) * BigInt(p.longPayout) + BigInt(position.short) * BigInt(p.shortPayout);
}
