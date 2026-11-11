// Section 10: the fixing, what each unit pays, and how forfeits are shared out.

export interface SettlementInput {
  floor: number;
  band: number;
  /** The series' accumulator. */
  sum: bigint;
  count: number;
  openSets: number;
  /** The series' bonus pool plus the carry pool. */
  pool: bigint;
  /** `now >= delivery_end + void_after_secs`. */
  voidAllowed: boolean;
  minPrints: number;
}

export interface Payouts {
  longPayout: number;
  shortPayout: number;
}

export interface Bonus {
  bonusLong: bigint;
  bonusShort: bigint;
  /** What is left of the pool; it becomes the new carry pool. */
  carry: bigint;
}

export interface SettlementOutcome extends Payouts, Bonus {
  fixing: number;
  void: boolean;
}

export function fixingOf(input: SettlementInput): { fixing: number; void: boolean } {
  const { sum, count, floor, band } = input;
  if (count >= input.minPrints) return { fixing: Number(sum / BigInt(count)), void: false };
  if (!input.voidAllowed) throw new Error("not enough prints yet");
  const fixing = count >= 1 ? Number(sum / BigInt(count)) : floor + Math.floor(band / 2);
  return { fixing, void: true };
}

export function payouts(fixing: number, floor: number, band: number): Payouts {
  const longPayout = Math.min(Math.max(fixing - floor, 0), band);
  return { longPayout, shortPayout: band - longPayout };
}

export function bonus(pool: bigint, openSets: number): Bonus {
  if (openSets === 0) return { bonusLong: 0n, bonusShort: 0n, carry: pool };
  const sets = BigInt(openSets);
  const perSet = pool / sets;
  const bonusLong = perSet / 2n;
  return { bonusLong, bonusShort: perSet - bonusLong, carry: pool - perSet * sets };
}

export function settleSeries(input: SettlementInput): SettlementOutcome {
  const { fixing, void: isVoid } = fixingOf(input);
  return { fixing, void: isVoid, ...payouts(fixing, input.floor, input.band), ...bonus(input.pool, input.openSets) };
}

/** What `redeem` credits for a position on a settled series. */
export function redeemAmount(
  position: { long: number; short: number },
  s: Payouts & Pick<Bonus, "bonusLong" | "bonusShort">,
): bigint {
  return (
    BigInt(position.long) * (BigInt(s.longPayout) + s.bonusLong) +
    BigInt(position.short) * (BigInt(s.shortPayout) + s.bonusShort)
  );
}
