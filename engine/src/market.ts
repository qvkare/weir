// An in-memory model of the whole Weir contract (sections 5 to 13) with a settable clock.
// Every method checks everything before it changes anything, so a call that throws leaves
// the state exactly as it was, like a panicking transaction on chain. Chain-only details
// (the registration fee, 1 yoctoNEAR deposits, the token contract) are left out.
import { computeBand } from "./band.ts";
import { clearRound, type Order } from "./clearing.ts";
import { commitHash, isHex64, isSalt, type Side } from "./hash.ts";
import { printDecision } from "./index.ts";
import { redeemAmount, settleSeries } from "./settlement.ts";
import {
  auctionClose,
  auctionOpen,
  deliveryEnd,
  deliveryStart,
  liveSeries,
  phaseAt,
  phaseEndsAt,
  roundEnd,
  roundStart,
  seriesOf,
  MAX_SERIES,
  type Phase,
  type TimeParams,
} from "./time.ts";

export interface Params extends TimeParams {
  /** The NEP-141 token used as the dollar. */
  usdc: string;
  underlying: string;
  bandBps: number;
  tick: number;
  printIntervalSecs: number;
  reportGraceSecs: number;
  maxMoveBps: number;
  minPrints: number;
  voidAfterSecs: number;
  maxAnchorAgeSecs: number;
  forfeitBps: number;
  minLock: bigint;
  maxCommits: number;
  maxOrderSize: number;
  reporters: readonly string[];
  quorum: number;
}

export type CommitState = "Committed" | "Revealed" | "Void";

export interface OrderTerms {
  side: Side;
  size: number;
  price: number;
}

export interface CommitView {
  seq: number;
  owner: string;
  hash: string;
  lock: bigint;
  state: CommitState;
  order: OrderTerms | null;
}

export interface RoundView {
  nextSeq: number;
  commits: CommitView[];
}

export interface FillView extends OrderTerms {
  seq: number;
  owner: string;
  filled: number;
}

export interface ResultView {
  price: number | null;
  volume: number;
  /** Total size of the LONG orders that took part in clearing. */
  longSize: number;
  /** Total size of the SHORT orders that took part in clearing. */
  shortSize: number;
  /** Orders that took part in clearing: revealed and not void. */
  orders: number;
  /** Commits the round held when it was cleared. */
  commits: number;
  forfeited: bigint;
  clearedAt: number;
  fills: FillView[];
}

export interface SettlementView {
  fixing: number;
  longPayout: number;
  shortPayout: number;
  bonusLong: bigint;
  bonusShort: bigint;
  prints: number;
  void: boolean;
  settledAt: number;
}

export interface SeriesView {
  series: number;
  anchor: number;
  floor: number;
  band: number;
  openedAt: number;
  openSets: number;
  bonusPool: bigint;
  /** Rounds, ascending, that hold commits and have not been cleared. */
  pendingRounds: number[];
  settlement: SettlementView | null;
}

export interface AccountView {
  balance: bigint;
  guard: number | null;
}

export interface Position {
  long: number;
  short: number;
}

export interface ReportView {
  reporter: string;
  price: number;
  bundle: string;
}

export interface PrintView {
  bucket: number;
  /** Null until the print is final. */
  price: number | null;
  final: boolean;
  reports: ReportView[];
}

export interface LastPrint {
  bucket: number;
  price: number;
}

export interface Accumulator {
  sum: bigint;
  count: number;
}

/** The five terms of invariant 1. */
export interface Totals {
  free: bigint;
  locked: bigint;
  setsBacking: bigint;
  pools: bigint;
  unredeemed: bigint;
}

export interface LiveSeries {
  series: number;
  deliveryStart: number;
  deliveryEnd: number;
  auctionOpen: number;
  auctionClose: number;
  round: number | null;
  phase: Phase;
  phaseEndsAt: number | null;
}

export interface Status {
  now: number;
  live: LiveSeries[];
}

export type WeirEvent =
  | { event: "register"; data: { accountId: string } }
  | { event: "deposit"; data: { accountId: string; amount: bigint } }
  | { event: "withdraw"; data: { accountId: string; amount: bigint } }
  | { event: "withdraw_failed"; data: { accountId: string; amount: bigint } }
  | { event: "series_opened"; data: { series: number; anchor: number; floor: number; band: number } }
  | { event: "commit"; data: { series: number; round: number; seq: number; accountId: string; hash: string; lock: bigint } }
  | { event: "evict"; data: { series: number; round: number; seq: number; accountId: string; lock: bigint } }
  | {
      event: "reveal";
      data: { series: number; round: number; seq: number; accountId: string; side: Side; size: number; price: number; void: boolean };
    }
  | { event: "clear"; data: { series: number; round: number; price: number | null; volume: number; forfeited: bigint } }
  | { event: "mint" | "merge"; data: { series: number; accountId: string; sets: number } }
  | { event: "transfer_position"; data: { series: number; from: string; to: string; long: number; short: number } }
  | { event: "report"; data: { bucket: number; reporter: string; price: number; bundle: string } }
  | { event: "print"; data: { bucket: number; price: number; reports: number } }
  | { event: "settle"; data: { series: number; fixing: number; longPayout: number; shortPayout: number; void: boolean } }
  | { event: "redeem"; data: { series: number; accountId: string; amount: bigint } }
  | { event: "guard"; data: { accountId: string; guard: number | null } };

interface Commit {
  seq: number;
  owner: string;
  lock: bigint;
  hash: string;
  state: CommitState;
  order: OrderTerms | null;
}

interface Book {
  nextSeq: number;
  commits: Commit[];
}

interface SeriesRecord {
  series: number;
  anchor: number;
  floor: number;
  band: number;
  openedAt: number;
  openSets: number;
  bonusPool: bigint;
  settlement: SettlementView | null;
  /** What redeem still owes on a settled series. */
  unredeemed: bigint;
}

interface PrintRecord {
  bucket: number;
  price: number | null;
  reports: ReportView[];
}

const PRINTS_LIMIT = 200;
const RESULTS_LIMIT = 100;
const STATUS_LIMIT = 32;

/** NEAR's account id rule: 2 to 64 characters of lowercase letters and digits, with `-`, `_`
 * and `.` as separators that cannot start, end or repeat. */
export const isAccountId = (s: string): boolean => /^(?=.{2,64}$)[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(s);

export class Market {
  readonly params: Readonly<Params>;
  /** Every event in the order it was logged. */
  readonly events: WeirEvent[] = [];

  #now: number;
  readonly #accounts = new Map<string, AccountView>();
  readonly #series = new Map<number, SeriesRecord>();
  readonly #positions = new Map<number, Map<string, Position>>();
  readonly #books = new Map<number, Map<number, Book>>();
  readonly #results = new Map<number, Map<number, ResultView>>();
  readonly #prints = new Map<number, PrintRecord>();
  readonly #accumulators = new Map<number, Accumulator>();
  #lastPrint: LastPrint | null = null;
  #carryPool = 0n;

  constructor(params: Params, now = 0) {
    validateParams(params);
    uint("now", now);
    this.params = Object.freeze({ ...params, reporters: Object.freeze([...params.reporters]) });
    this.#now = now;
  }

  // Clock

  get now(): number {
    return this.#now;
  }

  /** Moves the clock to `time`. Like block time, it never goes back. */
  setTime(time: number): void {
    uint("time", time);
    if (time < this.#now) throw new Error("time cannot go backwards");
    this.#now = time;
  }

  advance(secs: number): void {
    uint("secs", secs);
    this.setTime(this.#now + secs);
  }

  // Section 5: accounts and dollars

  register(accountId: string): void {
    if (!isAccountId(accountId)) throw new Error("account id is not valid");
    if (this.#accounts.has(accountId)) throw new Error("account is already registered");
    this.#accounts.set(accountId, { balance: 0n, guard: null });
    this.#emit({ event: "register", data: { accountId } });
  }

  /** Models `ft_on_transfer`. Returns the amount sent back: all of it when `accountId` is not
   * a valid account id or not registered. */
  deposit(accountId: string, amount: bigint): bigint {
    positive("amount", amount);
    const account = isAccountId(accountId) ? this.#accounts.get(accountId) : undefined;
    if (!account) return amount;
    account.balance += amount;
    this.#emit({ event: "deposit", data: { accountId, amount } });
    return 0n;
  }

  /** `transferFails` models a failed `ft_transfer`, whose callback credits the amount back. */
  withdraw(caller: string, amount: bigint, opts: { transferFails?: boolean } = {}): void {
    const account = this.#account(caller);
    positive("amount", amount);
    if (account.balance < amount) throw new Error("balance is too low");
    account.balance -= amount;
    this.#emit({ event: "withdraw", data: { accountId: caller, amount } });
    if (opts.transferFails) {
      account.balance += amount;
      this.#emit({ event: "withdraw_failed", data: { accountId: caller, amount } });
    }
  }

  setGuard(caller: string, guard: number | null): void {
    const account = this.#account(caller);
    if (guard !== null) uint("guard", guard);
    account.guard = guard;
    this.#emit({ event: "guard", data: { accountId: caller, guard } });
  }

  // Section 6: orders

  /** Locks `lock` behind a sealed order in the current round. Returns the commit's seq. */
  commit(caller: string, series: number, hash: string, lock: bigint): number {
    const account = this.#account(caller);
    seriesId(series);
    if (!isHex64(hash)) throw new Error("hash must be 64 lowercase hex characters");
    if (lock < this.params.minLock) throw new Error("lock is below min_lock");
    const { round, phase } = phaseAt(this.params, series, this.#now);
    if (round === null || phase !== "Commit") throw new Error("series is not in a commit phase");
    const opening = this.#prepareOpening(series);
    if (account.balance < lock) throw new Error("balance does not cover lock");
    const book = this.#books.get(series)?.get(round);
    let evicted: Commit | null = null;
    if (book && book.commits.length >= this.params.maxCommits) {
      evicted = smallestLock(book.commits);
      if (lock <= evicted.lock) throw new Error("round is full");
    }

    if (opening) this.#open(opening);
    const target = book ?? this.#newBook(series, round);
    if (evicted) {
      target.commits.splice(target.commits.indexOf(evicted), 1);
      this.#accounts.get(evicted.owner)!.balance += evicted.lock;
      this.#emit({
        event: "evict",
        data: { series, round, seq: evicted.seq, accountId: evicted.owner, lock: evicted.lock },
      });
    }
    account.balance -= lock;
    const seq = target.nextSeq++;
    target.commits.push({ seq, owner: caller, lock, hash, state: "Committed", order: null });
    this.#emit({ event: "commit", data: { series, round, seq, accountId: caller, hash, lock } });
    return seq;
  }

  reveal(
    caller: string,
    series: number,
    round: number,
    seq: number,
    side: Side,
    size: number,
    price: number,
    salt: string,
  ): void {
    const account = this.#account(caller);
    const book = this.#books.get(series)?.get(round);
    if (!book) throw new Error("round has no open book");
    const commit = book.commits.find((c) => c.seq === seq);
    if (!commit) throw new Error("commit not found");
    if (commit.owner !== caller) throw new Error("commit belongs to another account");
    if (commit.state !== "Committed") throw new Error("commit is already revealed");
    const start = roundStart(this.params, series, round);
    if (this.#now < start + this.params.commitSecs || this.#now >= roundEnd(this.params, series, round)) {
      throw new Error("round is not in its reveal phase");
    }
    if (side !== "Long" && side !== "Short") throw new Error("side must be Long or Short");
    uint("size", size);
    uint("price", price);
    if (!isSalt(salt)) throw new Error("salt must be 32 to 64 lowercase hex characters");
    if (commitHash({ series, round, accountId: caller, side, size, price, salt }) !== commit.hash) {
      throw new Error("revealed order does not match the hash");
    }
    if (size < 1 || size > this.params.maxOrderSize) throw new Error("size is out of range");
    const { floor, band } = this.#series.get(series)!;
    if (price % this.params.tick !== 0 || price <= 0 || price >= band) throw new Error("price is out of range");
    const cost = BigInt(size) * BigInt(side === "Long" ? price : band - price);
    if (commit.lock < cost) throw new Error("lock does not cover the order");

    const isVoid = this.#guardVoids(account.guard, side, price, floor, band);
    commit.order = { side, size, price };
    commit.state = isVoid ? "Void" : "Revealed";
    if (isVoid) account.balance += commit.lock;
    this.#emit({
      event: "reveal",
      data: { series, round, seq, accountId: caller, side, size, price, void: isVoid },
    });
  }

  // Section 7: clearing

  clear(series: number, round: number): ResultView {
    const book = this.#books.get(series)?.get(round);
    if (!book) {
      throw new Error(this.#results.get(series)?.has(round) ? "round is already cleared" : "round has no commits");
    }
    if (this.#now < roundEnd(this.params, series, round)) throw new Error("round is not over");

    const record = this.#series.get(series)!;
    const revealed = book.commits.filter((c) => c.state === "Revealed");
    const orders: Order[] = revealed.map((c) => ({ seq: c.seq, ...c.order! }));
    const { price, volume, fills } = clearRound(orders, this.params.tick);

    let forfeited = 0n;
    for (const c of book.commits) {
      const owner = this.#accounts.get(c.owner)!;
      if (c.state === "Committed") {
        const forfeit = (c.lock * BigInt(this.params.forfeitBps)) / 10_000n;
        forfeited += forfeit;
        owner.balance += c.lock - forfeit;
      } else if (c.state === "Revealed") {
        const { side } = c.order!;
        const filled = fills[revealed.indexOf(c)]!;
        const unit = price === null ? 0 : side === "Long" ? price : record.band - price;
        owner.balance += c.lock - BigInt(filled) * BigInt(unit);
        if (filled > 0) {
          const position = this.#position(series, c.owner);
          if (side === "Long") position.long += filled;
          else position.short += filled;
        }
      }
    }
    record.bonusPool += forfeited;
    record.openSets += volume;

    const result: ResultView = {
      price,
      volume,
      longSize: sumSize(orders, "Long"),
      shortSize: sumSize(orders, "Short"),
      orders: orders.length,
      commits: book.commits.length,
      forfeited,
      clearedAt: this.#now,
      fills: revealed.map((c, i) => ({ seq: c.seq, owner: c.owner, ...c.order!, filled: fills[i]! })),
    };
    this.#books.get(series)!.delete(round);
    mapIn(this.#results, series).set(round, result);
    this.#emit({ event: "clear", data: { series, round, price, volume, forfeited } });
    return copyResult(result);
  }

  // Section 8: mint, merge, transfer

  mint(caller: string, series: number, sets: number): void {
    const account = this.#account(caller);
    seriesId(series);
    count("sets", sets);
    if (this.#now < auctionOpen(this.params, series) || this.#now >= auctionClose(this.params, series)) {
      throw new Error("series is outside its auction window");
    }
    const opening = this.#prepareOpening(series);
    const band = opening?.band ?? this.#series.get(series)!.band;
    const cost = BigInt(sets) * BigInt(band);
    if (account.balance < cost) throw new Error("balance does not cover the sets");

    if (opening) this.#open(opening);
    account.balance -= cost;
    const position = this.#position(series, caller);
    position.long += sets;
    position.short += sets;
    this.#series.get(series)!.openSets += sets;
    this.#emit({ event: "mint", data: { series, accountId: caller, sets } });
  }

  merge(caller: string, series: number, sets: number): void {
    const account = this.#account(caller);
    const record = this.#unsettled(series);
    count("sets", sets);
    const position = this.#positions.get(series)?.get(caller);
    if (!position || position.long < sets || position.short < sets) throw new Error("not enough units to merge");

    position.long -= sets;
    position.short -= sets;
    this.#dropIfEmpty(series, caller);
    account.balance += BigInt(sets) * BigInt(record.band);
    record.openSets -= sets;
    this.#emit({ event: "merge", data: { series, accountId: caller, sets } });
  }

  transferPosition(caller: string, series: number, to: string, long: number, short: number): void {
    this.#account(caller);
    this.#account(to, "receiver is not registered");
    if (to === caller) throw new Error("cannot transfer to yourself");
    uint("long", long);
    uint("short", short);
    if (long + short === 0) throw new Error("nothing to transfer");
    const from = this.#positions.get(series)?.get(caller);
    if (!from || from.long < long || from.short < short) throw new Error("not enough units to transfer");

    from.long -= long;
    from.short -= short;
    const into = this.#position(series, to);
    into.long += long;
    into.short += short;
    this.#dropIfEmpty(series, caller);
    this.#emit({ event: "transfer_position", data: { series, from: caller, to, long, short } });
  }

  // Section 9: index

  /** Returns true when this report made the bucket's print final. */
  report(caller: string, bucket: number, price: number, bundle: string): boolean {
    const p = this.params;
    if (!p.reporters.includes(caller)) throw new Error("caller is not a reporter");
    uint("bucket", bucket);
    if (bucket % p.printIntervalSecs !== 0) throw new Error("bucket is not a multiple of print_interval_secs");
    if (this.#now < bucket || this.#now >= bucket + p.printIntervalSecs + p.reportGraceSecs) {
      throw new Error("bucket is outside its report window");
    }
    uint("price", price);
    if (price === 0) throw new Error("price must be above zero");
    if (!isHex64(bundle)) throw new Error("bundle must be 64 lowercase hex characters");
    const existing = this.#prints.get(bucket);
    // A final print ignores the call before the duplicate check, so a late repeat is not an error.
    if (existing && existing.price !== null) return false;
    if (existing?.reports.some((r) => r.reporter === caller)) throw new Error("reporter already reported this bucket");

    const print = existing ?? { bucket, price: null, reports: [] };
    this.#prints.set(bucket, print);
    print.reports.push({ reporter: caller, price, bundle });
    this.#emit({ event: "report", data: { bucket, reporter: caller, price, bundle } });

    const last = this.#lastPrint;
    const decision = printDecision({
      reports: print.reports.map((r) => r.price),
      last: last !== null && last.bucket < bucket ? last.price : null,
      quorum: p.quorum,
      reporters: p.reporters.length,
      maxMoveBps: p.maxMoveBps,
    });
    if (decision.price === null) return false;

    print.price = decision.price;
    if (last === null || bucket > last.bucket) this.#lastPrint = { bucket, price: decision.price };
    const series = seriesOf(p, bucket);
    if (series !== null) {
      const acc = this.#accumulators.get(series) ?? { sum: 0n, count: 0 };
      this.#accumulators.set(series, { sum: acc.sum + BigInt(decision.price), count: acc.count + 1 });
    }
    this.#emit({
      event: "print",
      data: { bucket, price: decision.price, reports: print.reports.length },
    });
    return true;
  }

  // Section 10: settlement

  settle(series: number): SettlementView {
    const record = this.#series.get(series);
    if (!record) throw new Error("series is not open");
    if (record.settlement) throw new Error("series is already settled");
    const end = deliveryEnd(this.params, series);
    if (this.#now < end + this.params.reportGraceSecs) throw new Error("report window of the delivery is still open");
    if (this.#pendingRounds(series).length > 0) throw new Error("series has rounds waiting to be cleared");
    const acc = this.getAccumulator(series);
    const outcome = settleSeries({
      floor: record.floor,
      band: record.band,
      sum: acc.sum,
      count: acc.count,
      openSets: record.openSets,
      pool: record.bonusPool + this.#carryPool,
      voidAllowed: this.#now >= end + this.params.voidAfterSecs,
      minPrints: this.params.minPrints,
    });

    const settlement: SettlementView = {
      fixing: outcome.fixing,
      longPayout: outcome.longPayout,
      shortPayout: outcome.shortPayout,
      bonusLong: outcome.bonusLong,
      bonusShort: outcome.bonusShort,
      prints: acc.count,
      void: outcome.void,
      settledAt: this.#now,
    };
    this.#carryPool = outcome.carry;
    record.bonusPool = 0n;
    record.settlement = settlement;
    // Total LONG and total SHORT both equal open_sets, so this is exactly what redeem will pay.
    record.unredeemed = redeemAmount({ long: record.openSets, short: record.openSets }, outcome);
    this.#emit({
      event: "settle",
      data: {
        series,
        fixing: outcome.fixing,
        longPayout: outcome.longPayout,
        shortPayout: outcome.shortPayout,
        void: outcome.void,
      },
    });
    return { ...settlement };
  }

  /** Pays out `accountId`'s position on a settled series. Anyone may call it. Returns the amount. */
  redeem(series: number, accountId: string): bigint {
    const record = this.#series.get(series);
    if (!record?.settlement) throw new Error("series is not settled");
    const position = this.#positions.get(series)?.get(accountId);
    if (!position) throw new Error("nothing to redeem");
    const amount = redeemAmount(position, record.settlement);

    this.#positions.get(series)!.delete(accountId);
    this.#accounts.get(accountId)!.balance += amount;
    record.unredeemed -= amount;
    this.#emit({ event: "redeem", data: { series, accountId, amount } });
    return amount;
  }

  /** Section 14: deletes a stored result once its series is settled. */
  pruneResult(series: number, round: number): void {
    if (!this.#series.get(series)?.settlement) throw new Error("series is not settled");
    if (!this.#results.get(series)?.delete(round)) throw new Error("no result for this round");
  }

  // Section 12: views. They return copies, so callers cannot reach the state.

  getParams(): Params {
    return { ...this.params, reporters: [...this.params.reporters] };
  }

  getStatus(): Status {
    const now = this.#now;
    const live = liveSeries(this.params, now).slice(0, STATUS_LIMIT).map((series) => {
      const info = phaseAt(this.params, series, now);
      return {
        series,
        deliveryStart: deliveryStart(this.params, series),
        deliveryEnd: deliveryEnd(this.params, series),
        auctionOpen: auctionOpen(this.params, series),
        auctionClose: auctionClose(this.params, series),
        round: info.round,
        phase: info.phase,
        phaseEndsAt: phaseEndsAt(this.params, series, info),
      };
    });
    return { now, live };
  }

  getSeries(series: number): SeriesView | null {
    const r = this.#series.get(series);
    if (!r) return null;
    return {
      series: r.series,
      anchor: r.anchor,
      floor: r.floor,
      band: r.band,
      openedAt: r.openedAt,
      openSets: r.openSets,
      bonusPool: r.bonusPool,
      pendingRounds: this.#pendingRounds(series),
      settlement: r.settlement && { ...r.settlement },
    };
  }

  getAccount(accountId: string): AccountView | null {
    const a = this.#accounts.get(accountId);
    return a ? { ...a } : null;
  }

  getPosition(series: number, accountId: string): Position {
    const p = this.#positions.get(series)?.get(accountId);
    return p ? { ...p } : { long: 0, short: 0 };
  }

  getRound(series: number, round: number): RoundView | null {
    const book = this.#books.get(series)?.get(round);
    if (!book) return null;
    return {
      nextSeq: book.nextSeq,
      commits: book.commits.map((c) => ({
        seq: c.seq,
        owner: c.owner,
        hash: c.hash,
        lock: c.lock,
        state: c.state,
        order: c.order && { ...c.order },
      })),
    };
  }

  getResult(series: number, round: number): ResultView | null {
    const r = this.#results.get(series)?.get(round);
    return r ? copyResult(r) : null;
  }

  /** Results for rounds `fromRound .. fromRound + limit - 1` that have one; `limit` is capped at 100. */
  getResults(series: number, fromRound: number, limit: number): [number, ResultView][] {
    const stored = this.#results.get(series);
    if (!stored) return [];
    const end = fromRound + Math.min(limit, RESULTS_LIMIT);
    return [...stored.entries()]
      .filter(([round]) => round >= fromRound && round < end)
      .sort(([a], [b]) => a - b)
      .map(([round, r]) => [round, copyResult(r)]);
  }

  getPrint(bucket: number): PrintView | null {
    const p = this.#prints.get(bucket);
    return p ? copyPrint(p) : null;
  }

  getLastPrint(): LastPrint | null {
    return this.#lastPrint && { ...this.#lastPrint };
  }

  /** Final prints from `fromBucket` upward, at most `limit` (capped at 200). */
  getPrints(fromBucket: number, limit: number): PrintView[] {
    return [...this.#prints.values()]
      .filter((p) => p.price !== null && p.bucket >= fromBucket)
      .sort((a, b) => a.bucket - b.bucket)
      .slice(0, Math.max(0, Math.min(limit, PRINTS_LIMIT)))
      .map(copyPrint);
  }

  getAccumulator(series: number): Accumulator {
    const acc = this.#accumulators.get(series);
    return acc ? { ...acc } : { sum: 0n, count: 0 };
  }

  getTotals(): Totals {
    let free = 0n;
    for (const a of this.#accounts.values()) free += a.balance;
    let locked = 0n;
    for (const books of this.#books.values()) {
      for (const book of books.values()) {
        for (const c of book.commits) if (c.state !== "Void") locked += c.lock;
      }
    }
    let setsBacking = 0n;
    let pools = this.#carryPool;
    let unredeemed = 0n;
    for (const r of this.#series.values()) {
      if (r.settlement) unredeemed += r.unredeemed;
      else setsBacking += BigInt(r.openSets) * BigInt(r.band);
      pools += r.bonusPool;
    }
    return { free, locked, setsBacking, pools, unredeemed };
  }

  /** The hash of section 6.2, so a client can check its own. */
  commitHash(series: number, round: number, accountId: string, side: Side, size: number, price: number, salt: string): string {
    return commitHash({ series, round, accountId, side, size, price, salt });
  }

  // Internals

  #emit(e: WeirEvent): void {
    this.events.push(e);
  }

  #account(accountId: string, message = "account is not registered"): AccountView {
    const a = this.#accounts.get(accountId);
    if (!a) throw new Error(message);
    return a;
  }

  #unsettled(series: number): SeriesRecord {
    const r = this.#series.get(series);
    if (!r) throw new Error("series is not open");
    if (r.settlement) throw new Error("series is already settled");
    return r;
  }

  /** The record to create if `series` is not open yet, or null if it is. Throws if it cannot open. */
  #prepareOpening(series: number): Omit<SeriesRecord, "openedAt"> | null {
    if (this.#series.has(series)) return null;
    const last = this.#lastPrint;
    if (last === null || this.#now - last.bucket > this.params.maxAnchorAgeSecs) throw new Error("index is stale");
    const { floor, band } = computeBand(last.price, this.params.tick, this.params.bandBps);
    return { series, anchor: last.price, floor, band, openSets: 0, bonusPool: 0n, settlement: null, unredeemed: 0n };
  }

  #open(opening: Omit<SeriesRecord, "openedAt">): void {
    this.#series.set(opening.series, { ...opening, openedAt: this.#now });
    const { series, anchor, floor, band } = opening;
    this.#emit({ event: "series_opened", data: { series, anchor, floor, band } });
  }

  #newBook(series: number, round: number): Book {
    const book: Book = { nextSeq: 0, commits: [] };
    mapIn(this.#books, series).set(round, book);
    return book;
  }

  #pendingRounds(series: number): number[] {
    return [...(this.#books.get(series)?.keys() ?? [])].sort((a, b) => a - b);
  }

  #position(series: number, accountId: string): Position {
    const positions = mapIn(this.#positions, series);
    let p = positions.get(accountId);
    if (!p) positions.set(accountId, (p = { long: 0, short: 0 }));
    return p;
  }

  #dropIfEmpty(series: number, accountId: string): void {
    const p = this.#positions.get(series)?.get(accountId);
    if (p && p.long === 0 && p.short === 0) this.#positions.get(series)!.delete(accountId);
  }

  /** Section 6.4. Without a guard or a print there is nothing to compare with. */
  #guardVoids(guard: number | null, side: Side, price: number, floor: number, band: number): boolean {
    if (guard === null || this.#lastPrint === null) return false;
    const ref = Math.min(Math.max(this.#lastPrint.price - floor, 0), band);
    return side === "Long" ? price > ref + guard : price + guard < ref;
  }
}

function validateParams(p: Params): void {
  // cutoff_secs is the one duration that may be zero: auctions may run up to delivery.
  uint("cutoffSecs", p.cutoffSecs);
  const durations = [
    "periodSecs",
    "leadSecs",
    "commitSecs",
    "revealSecs",
    "printIntervalSecs",
    "reportGraceSecs",
    "voidAfterSecs",
    "maxAnchorAgeSecs",
  ] as const;
  for (const name of durations) {
    uint(name, p[name]);
    if (p[name] === 0) throw new Error(`${name} must be above zero`);
  }
  for (const name of ["t0", "bandBps", "tick", "maxMoveBps", "minPrints", "forfeitBps", "maxCommits", "maxOrderSize", "quorum"] as const) {
    uint(name, p[name]);
  }
  if (p.tick === 0) throw new Error("tick must be above zero");
  if (p.bandBps === 0 || p.bandBps >= 10_000) throw new Error("band_bps must be between 0 and 10000");
  if (p.forfeitBps > 10_000) throw new Error("forfeit_bps must be at most 10000");
  if (p.maxCommits < 1 || p.maxCommits > 128) throw new Error("max_commits must be 1 to 128");
  if (p.maxOrderSize < 1) throw new Error("max_order_size must be at least 1");
  if (p.cutoffSecs >= p.leadSecs) throw new Error("cutoff_secs must be below lead_secs");
  if (p.minPrints < 1) throw new Error("min_prints must be at least 1");
  if (p.minLock < 0n) throw new Error("min_lock must not be negative");
  if (!isAccountId(p.usdc)) throw new Error("usdc must be an account id");
  if (!p.reporters.every(isAccountId)) throw new Error("reporters must be account ids");
  if (p.t0 % p.printIntervalSecs !== 0 || p.periodSecs % p.printIntervalSecs !== 0) {
    throw new Error("t0 and period_secs must be multiples of print_interval_secs");
  }
  if (p.reporters.length < 1 || p.reporters.length > 9) throw new Error("there must be 1 to 9 reporters");
  if (new Set(p.reporters).size !== p.reporters.length) throw new Error("reporters must not repeat");
  if (p.quorum < 1 || p.quorum > p.reporters.length) throw new Error("quorum must be 1 to the number of reporters");
}

function uint(name: string, v: number): void {
  if (!Number.isSafeInteger(v) || v < 0) throw new Error(`${name} must be a non-negative integer`);
}

function count(name: string, v: number): void {
  uint(name, v);
  if (v === 0) throw new Error(`${name} must be at least 1`);
}

function positive(name: string, v: bigint): void {
  if (v <= 0n) throw new Error(`${name} must be above zero`);
}

function seriesId(series: number): void {
  uint("series", series);
  if (series > MAX_SERIES) throw new Error("series must fit in a u32");
}

/** The commit an over-full round evicts: the smallest lock, the latest seq among equals. */
function smallestLock(commits: readonly Commit[]): Commit {
  return commits.reduce((min, c) => (c.lock < min.lock || (c.lock === min.lock && c.seq > min.seq) ? c : min));
}

function sumSize(orders: readonly Order[], side: Side): number {
  return orders.reduce((total, o) => (o.side === side ? total + o.size : total), 0);
}

function mapIn<K, V>(outer: Map<number, Map<K, V>>, key: number): Map<K, V> {
  let inner = outer.get(key);
  if (!inner) outer.set(key, (inner = new Map()));
  return inner;
}

function copyResult(r: ResultView): ResultView {
  return { ...r, fills: r.fills.map((f) => ({ ...f })) };
}

function copyPrint(p: PrintRecord): PrintView {
  return { bucket: p.bucket, price: p.price, final: p.price !== null, reports: p.reports.map((r) => ({ ...r })) };
}
