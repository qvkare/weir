// An in-memory model of the whole Weir contract (sections 5 to 14) with a settable clock.
// Every method checks everything before it changes anything, so a call that throws leaves
// the state exactly as it was, like a panicking transaction on chain. Refusals use the
// contract's texts (section 16, `ERR`). Chain-only details (the registration fee,
// 1 yoctoNEAR deposits, the token contract) are left out.
import { computeBand } from "./band.ts";
import { clearRound, type Order } from "./clearing.ts";
import { ERR } from "./errors.ts";
import { commitHash, isHex64, isSalt, type Side } from "./hash.ts";
import { decidePrint, type PrintState } from "./index.ts";
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
  roundsPerSeries,
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
  maxSpreadBps: number;
  minPrints: number;
  voidAfterSecs: number;
  maxAnchorAgeSecs: number;
  forfeitBps: number;
  minLock: bigint;
  /** Burned for every commit that reaches clearing. May be zero. */
  commitFee: bigint;
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
  fee: bigint;
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
  /** Burned from unrevealed locks. */
  forfeited: bigint;
  /** Burned commit fees. */
  fees: bigint;
  clearedAt: number;
  /** The orders that were filled, in seq order. */
  fills: FillView[];
}

export interface SettlementView {
  fixing: number;
  longPayout: number;
  shortPayout: number;
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
  /** Rounds, ascending, that hold commits and have not been cleared. */
  pendingRounds: number[];
  settlement: SettlementView | null;
}

export interface AccountView {
  balance: bigint;
  /** Section 6.4: how far from the reference an order may bid. */
  guard: number | null;
  /** Section 6.2: the most the account's commits may lock in one round. */
  maxRoundLock: bigint | null;
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
  /** Null unless `state` is `Final`. */
  price: number | null;
  state: PrintState;
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

/** The five terms of invariant 1; their sum is the USDC the contract holds. */
export interface Totals {
  free: bigint;
  /** Locks of commits not void, and fees of all commits, in rounds not yet cleared. */
  locked: bigint;
  setsBacking: bigint;
  unredeemed: bigint;
  burned: bigint;
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

type CommitData = { series: number; round: number; seq: number; accountId: string };

export type WeirEvent =
  | { event: "register"; data: { accountId: string } }
  | { event: "deposit" | "withdraw" | "withdraw_failed"; data: { accountId: string; amount: bigint } }
  | { event: "series_opened"; data: { series: number; anchor: number; floor: number; band: number } }
  | { event: "commit"; data: CommitData & { hash: string; lock: bigint; fee: bigint } }
  | { event: "evict"; data: CommitData & { lock: bigint; fee: bigint } }
  | { event: "reveal"; data: CommitData & { side: Side; size: number; price: number; void: boolean } }
  | {
      event: "clear";
      data: { series: number; round: number; price: number | null; volume: number; forfeited: bigint; fees: bigint };
    }
  | { event: "mint" | "merge"; data: { series: number; accountId: string; sets: number } }
  | { event: "transfer_position"; data: { series: number; from: string; to: string; long: number; short: number } }
  | { event: "report"; data: { bucket: number; reporter: string; price: number; bundle: string } }
  | { event: "print"; data: { bucket: number; price: number; reports: number } }
  | { event: "no_print"; data: { bucket: number; reports: number } }
  | { event: "prune_print"; data: { bucket: number } }
  | { event: "prune_result"; data: { series: number; round: number } }
  | { event: "settle"; data: { series: number; fixing: number; longPayout: number; shortPayout: number; void: boolean } }
  | { event: "redeem"; data: { series: number; accountId: string; amount: bigint } }
  | { event: "guard"; data: { accountId: string; guard: number | null; maxRoundLock: bigint | null } };

interface Commit {
  seq: number;
  owner: string;
  lock: bigint;
  fee: bigint;
  hash: string;
  state: CommitState;
  order: OrderTerms | null;
  /** The owner's guard and the reference price when the commit was made (section 6.2). */
  guard: number | null;
  ref: number;
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
  settlement: SettlementView | null;
  /** What redeem still owes on a settled series. */
  unredeemed: bigint;
}

interface PrintRecord {
  bucket: number;
  price: number | null;
  state: PrintState;
  reports: ReportView[];
}

const PRINTS_LIMIT = 200;
const RESULTS_LIMIT = 100;
const STATUS_LIMIT = 32;
/** How many earlier closed buckets one report decides on its way out (section 9). */
const SWEEP_LIMIT = 4;
const MAX_SAFE = 2n ** 53n - 1n;

/** NEAR's account id rule: 2 to 64 characters of lowercase letters and digits, with `-`, `_`
 * and `.` as separators that cannot start, end or repeat. */
export const isAccountId = (s: string): boolean => /^(?=.{2,64}$)[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(s);

/** What a series' auctions can add to `open_sets` at most: `max_order_size * max_commits *
 * rounds_per_series` (sections 3 and 8). */
export const auctionCapacity = (p: Params): bigint =>
  BigInt(p.maxOrderSize) * BigInt(p.maxCommits) * BigInt(roundsPerSeries(p));

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
  #burned = 0n;

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
    if (!isAccountId(accountId)) throw new Error(ERR.BAD_ACCOUNT_ID);
    if (this.#accounts.has(accountId)) throw new Error(ERR.REGISTERED);
    this.#accounts.set(accountId, { balance: 0n, guard: null, maxRoundLock: null });
    this.#emit({ event: "register", data: { accountId } });
  }

  /** Models `ft_on_transfer`. Returns the amount sent back: all of it when `accountId` is not
   * a valid account id or not registered. */
  deposit(accountId: string, amount: bigint): bigint {
    if (amount <= 0n) throw new Error(ERR.ZERO_AMOUNT);
    const account = isAccountId(accountId) ? this.#accounts.get(accountId) : undefined;
    if (!account) return amount;
    account.balance += amount;
    this.#emit({ event: "deposit", data: { accountId, amount } });
    return 0n;
  }

  /** `transferFails` models a failed `ft_transfer`, whose callback credits the amount back. */
  withdraw(caller: string, amount: bigint, opts: { transferFails?: boolean } = {}): void {
    const account = this.#account(caller);
    if (amount <= 0n) throw new Error(ERR.ZERO_AMOUNT);
    if (account.balance < amount) throw new Error(ERR.BALANCE);
    account.balance -= amount;
    this.#emit({ event: "withdraw", data: { accountId: caller, amount } });
    if (opts.transferFails) {
      account.balance += amount;
      this.#emit({ event: "withdraw_failed", data: { accountId: caller, amount } });
    }
  }

  /** Sets both limits of section 6.4; null clears one. */
  setGuard(caller: string, guard: number | null, maxRoundLock: bigint | null = null): void {
    const account = this.#account(caller);
    if (guard !== null) uint("guard", guard);
    if (maxRoundLock !== null && maxRoundLock < 0n) throw new Error("max_round_lock must not be negative");
    account.guard = guard;
    account.maxRoundLock = maxRoundLock;
    this.#emit({ event: "guard", data: { accountId: caller, guard, maxRoundLock } });
  }

  // Section 6: orders

  /** Locks `lock` plus the commit fee behind a sealed order in the current round. Returns the seq. */
  commit(caller: string, series: number, hash: string, lock: bigint): number {
    const account = this.#account(caller);
    seriesId(series);
    if (!isHex64(hash)) throw new Error(ERR.BAD_HASH);
    if (lock < this.params.minLock) throw new Error(ERR.LOCK_TOO_SMALL);
    const { round, phase } = phaseAt(this.params, series, this.#now);
    if (round === null || phase !== "Commit") throw new Error(ERR.NOT_COMMIT_PHASE);
    const opening = this.#prepareOpening(series);
    const fee = this.params.commitFee;
    if (account.balance < lock + fee) throw new Error(ERR.BALANCE);
    const book = this.#books.get(series)?.get(round);
    if (account.maxRoundLock !== null) {
      const held = (book?.commits ?? []).reduce((sum, c) => (c.owner === caller ? sum + c.lock : sum), 0n);
      if (held + lock > account.maxRoundLock) throw new Error(ERR.ROUND_LOCK);
    }
    let evicted: Commit | null = null;
    if (book && book.commits.length >= this.params.maxCommits) {
      evicted = smallestLock(book.commits);
      if (lock <= evicted.lock) throw new Error(ERR.ROUND_FULL);
    }

    if (opening) this.#open(opening);
    const { floor, band } = this.#series.get(series)!;
    const target = book ?? this.#newBook(series, round);
    if (evicted) {
      target.commits.splice(target.commits.indexOf(evicted), 1);
      this.#accounts.get(evicted.owner)!.balance += evicted.lock + evicted.fee;
      this.#emit({
        event: "evict",
        data: { series, round, seq: evicted.seq, accountId: evicted.owner, lock: evicted.lock, fee: evicted.fee },
      });
    }
    account.balance -= lock + fee;
    const seq = target.nextSeq++;
    // An open series always has a last print: it was opened on one and prints are never unset.
    const ref = Math.min(Math.max(this.#lastPrint!.price - floor, 0), band);
    target.commits.push({ seq, owner: caller, lock, fee, hash, state: "Committed", order: null, guard: account.guard, ref });
    this.#emit({ event: "commit", data: { series, round, seq, accountId: caller, hash, lock, fee } });
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
    const commit = this.#books.get(series)?.get(round)?.commits.find((c) => c.seq === seq);
    if (!commit) throw new Error(ERR.NO_COMMIT);
    if (commit.owner !== caller) throw new Error(ERR.NOT_OWNER);
    if (commit.state !== "Committed") throw new Error(ERR.ALREADY_REVEALED);
    const start = roundStart(this.params, series, round);
    if (this.#now < start + this.params.commitSecs || this.#now >= roundEnd(this.params, series, round)) {
      throw new Error(ERR.NOT_REVEAL_PHASE);
    }
    if (side !== "Long" && side !== "Short") throw new Error("side must be Long or Short");
    uint("size", size);
    uint("price", price);
    if (!isSalt(salt)) throw new Error(ERR.BAD_SALT);
    if (commitHash({ series, round, accountId: caller, side, size, price, salt }) !== commit.hash) {
      throw new Error(ERR.HASH_MISMATCH);
    }
    if (size < 1 || size > this.params.maxOrderSize) throw new Error(ERR.BAD_SIZE);
    const { band } = this.#series.get(series)!;
    if (price % this.params.tick !== 0 || price <= 0 || price >= band) throw new Error(ERR.BAD_PRICE);
    const cost = BigInt(size) * BigInt(side === "Long" ? price : band - price);
    if (commit.lock < cost) throw new Error(ERR.UNDER_LOCKED);

    const isVoid = guardVoids(commit, side, price);
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
    if (!book) throw new Error(this.#results.get(series)?.has(round) ? ERR.CLEARED : ERR.NO_COMMITS);
    if (this.#now < roundEnd(this.params, series, round)) throw new Error(ERR.ROUND_NOT_OVER);

    const record = this.#series.get(series)!;
    const revealed = book.commits.filter((c) => c.state === "Revealed");
    const orders: Order[] = revealed.map((c) => ({ seq: c.seq, ...c.order! }));
    const { price, volume, fills } = clearRound(orders, this.params.tick);

    let forfeited = 0n;
    let fees = 0n;
    for (const c of book.commits) {
      const owner = this.#accounts.get(c.owner)!;
      fees += c.fee;
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
    this.#burned += forfeited + fees;
    record.openSets += volume;

    const result: ResultView = {
      price,
      volume,
      longSize: sumSize(orders, "Long"),
      shortSize: sumSize(orders, "Short"),
      orders: orders.length,
      commits: book.commits.length,
      forfeited,
      fees,
      clearedAt: this.#now,
      fills: revealed
        .map((c, i) => ({ seq: c.seq, owner: c.owner, ...c.order!, filled: fills[i]! }))
        .filter((f) => f.filled > 0),
    };
    this.#books.get(series)!.delete(round);
    mapIn(this.#results, series).set(round, result);
    this.#emit({ event: "clear", data: { series, round, price, volume, forfeited, fees } });
    return copyResult(result);
  }

  // Section 8: mint, merge, transfer

  mint(caller: string, series: number, sets: number): void {
    const account = this.#account(caller);
    seriesId(series);
    uint("sets", sets);
    if (sets === 0) throw new Error(ERR.ZERO_SETS);
    if (this.#now < auctionOpen(this.params, series) || this.#now >= auctionClose(this.params, series)) {
      throw new Error(ERR.WINDOW_CLOSED);
    }
    const opening = this.#prepareOpening(series);
    const record = opening ?? this.#series.get(series)!;
    if (BigInt(record.openSets) + BigInt(sets) > MAX_SAFE - auctionCapacity(this.params)) {
      throw new Error(ERR.TOO_MANY_SETS);
    }
    const cost = BigInt(sets) * BigInt(record.band);
    if (account.balance < cost) throw new Error(ERR.BALANCE);

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
    uint("sets", sets);
    if (sets === 0) throw new Error(ERR.ZERO_SETS);
    const position = this.#positions.get(series)?.get(caller);
    if (!position || position.long < sets || position.short < sets) throw new Error(ERR.POSITION_TOO_SMALL);

    position.long -= sets;
    position.short -= sets;
    this.#dropIfEmpty(series, caller);
    account.balance += BigInt(sets) * BigInt(record.band);
    record.openSets -= sets;
    this.#emit({ event: "merge", data: { series, accountId: caller, sets } });
  }

  transferPosition(caller: string, series: number, to: string, long: number, short: number): void {
    this.#account(caller);
    this.#account(to);
    if (to === caller) throw new Error(ERR.SELF_TRANSFER);
    uint("long", long);
    uint("short", short);
    if (long + short === 0) throw new Error(ERR.NOTHING_TO_TRANSFER);
    const from = this.#positions.get(series)?.get(caller);
    if (!from || from.long < long || from.short < short) throw new Error(ERR.POSITION_TOO_SMALL);

    from.long -= long;
    from.short -= short;
    const into = this.#position(series, to);
    into.long += long;
    into.short += short;
    this.#dropIfEmpty(series, caller);
    this.#emit({ event: "transfer_position", data: { series, from: caller, to, long, short } });
  }

  // Section 9: index

  /** Returns true when this report gave the bucket a final print. */
  report(caller: string, bucket: number, price: number, bundle: string): boolean {
    const p = this.params;
    if (!p.reporters.includes(caller)) throw new Error(ERR.NOT_REPORTER);
    uint("bucket", bucket);
    if (bucket % p.printIntervalSecs !== 0) throw new Error(ERR.BUCKET);
    if (this.#now < bucket || this.#windowClosed(bucket)) throw new Error(ERR.REPORT_WINDOW);
    uint("price", price);
    if (price === 0) throw new Error(ERR.ZERO_PRICE);
    if (!isHex64(bundle)) throw new Error(ERR.BAD_BUNDLE);
    const existing = this.#prints.get(bucket);
    // A decided bucket ignores the call before the duplicate check, so a late repeat is not an error.
    if (existing && existing.state !== "Open") return false;
    if (existing?.reports.some((r) => r.reporter === caller)) throw new Error(ERR.DUPLICATE_REPORT);

    const print = existing ?? { bucket, price: null, state: "Open", reports: [] };
    this.#prints.set(bucket, print);
    print.reports.push({ reporter: caller, price, bundle });
    this.#emit({ event: "report", data: { bucket, reporter: caller, price, bundle } });
    const final = print.reports.length === p.reporters.length && this.#decide(print);
    for (const earlier of this.#undecided().filter((b) => b.bucket < bucket && this.#windowClosed(b.bucket)).slice(0, SWEEP_LIMIT)) {
      this.#decide(earlier);
    }
    return final;
  }

  /** Decides a bucket whose report window has closed. Returns whether it got a final print. */
  finalizePrint(bucket: number): boolean {
    const print = this.#prints.get(bucket);
    if (!print) throw new Error(ERR.NO_REPORTS);
    if (print.state !== "Open") throw new Error(ERR.DECIDED);
    if (!this.#windowClosed(bucket)) throw new Error(ERR.REPORT_WINDOW_OPEN);
    return this.#decide(print);
  }

  /** Deletes a decided bucket's reports and price two periods after the bucket. */
  prunePrint(bucket: number): void {
    const print = this.#prints.get(bucket);
    if (!print) throw new Error(ERR.NO_REPORTS);
    if (print.state === "Open") throw new Error(ERR.NOT_DECIDED);
    if (this.#now < bucket + 2 * this.params.periodSecs) throw new Error(ERR.TOO_EARLY_TO_PRUNE);
    this.#prints.delete(bucket);
    this.#emit({ event: "prune_print", data: { bucket } });
  }

  // Section 10: settlement

  settle(series: number): SettlementView {
    const record = this.#series.get(series);
    if (!record) throw new Error(ERR.UNKNOWN_SERIES);
    if (record.settlement) throw new Error(ERR.SETTLED);
    const start = deliveryStart(this.params, series);
    const end = deliveryEnd(this.params, series);
    if (this.#now < end + this.params.reportGraceSecs) throw new Error(ERR.DELIVERY_NOT_OVER);
    if (this.#pendingRounds(series).length > 0) throw new Error(ERR.PENDING_ROUNDS);

    // Decide the delivery window's open buckets on paper first, so a refusal changes nothing.
    const open = this.#undecided().filter((b) => b.bucket >= start && b.bucket < end);
    const acc = this.getAccumulator(series);
    for (const b of open) {
      const price = decidePrint(b.reports.map((r) => r.price), this.params.quorum, this.params.maxSpreadBps);
      if (price !== null) {
        acc.sum += BigInt(price);
        acc.count += 1;
      }
    }
    const outcome = settleSeries({
      floor: record.floor,
      band: record.band,
      sum: acc.sum,
      count: acc.count,
      voidAllowed: this.#now >= end + this.params.voidAfterSecs,
      minPrints: this.params.minPrints,
    });

    for (const b of open) this.#decide(b);
    const settlement: SettlementView = {
      fixing: outcome.fixing,
      longPayout: outcome.longPayout,
      shortPayout: outcome.shortPayout,
      prints: acc.count,
      void: outcome.void,
      settledAt: this.#now,
    };
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
    if (!record) throw new Error(ERR.UNKNOWN_SERIES);
    if (!record.settlement) throw new Error(ERR.NOT_SETTLED);
    const position = this.#positions.get(series)?.get(accountId);
    if (!position) throw new Error(ERR.NO_POSITION);
    const amount = redeemAmount(position, record.settlement);

    this.#positions.get(series)!.delete(accountId);
    this.#accounts.get(accountId)!.balance += amount;
    record.unredeemed -= amount;
    this.#emit({ event: "redeem", data: { series, accountId, amount } });
    return amount;
  }

  /** Section 14: deletes a stored result once its series is settled. */
  pruneResult(series: number, round: number): void {
    const record = this.#series.get(series);
    if (!record) throw new Error(ERR.UNKNOWN_SERIES);
    if (!record.settlement) throw new Error(ERR.NOT_SETTLED);
    if (!this.#results.get(series)?.delete(round)) throw new Error(ERR.NO_RESULT);
    this.#emit({ event: "prune_result", data: { series, round } });
  }

  // Section 12: views. They return copies, so callers cannot reach the state.

  getParams(): Params {
    return { ...this.params, reporters: [...this.params.reporters] };
  }

  getStatus(): Status {
    const now = this.#now;
    const live = liveSeries(this.params, now)
      .slice(0, STATUS_LIMIT)
      .map((series) => {
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
        fee: c.fee,
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

  /** The undecided buckets that have reports, ascending. */
  getPendingPrints(): number[] {
    return this.#undecided().map((p) => p.bucket);
  }

  getLastPrint(): LastPrint | null {
    return this.#lastPrint && { ...this.#lastPrint };
  }

  /** Final prints from `fromBucket` upward, at most `limit` (capped at 200). */
  getPrints(fromBucket: number, limit: number): PrintView[] {
    return [...this.#prints.values()]
      .filter((p) => p.state === "Final" && p.bucket >= fromBucket)
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
        for (const c of book.commits) locked += (c.state === "Void" ? 0n : c.lock) + c.fee;
      }
    }
    let setsBacking = 0n;
    let unredeemed = 0n;
    for (const r of this.#series.values()) {
      if (r.settlement) unredeemed += r.unredeemed;
      else setsBacking += BigInt(r.openSets) * BigInt(r.band);
    }
    return { free, locked, setsBacking, unredeemed, burned: this.#burned };
  }

  /** The hash of section 6.2, so a client can check its own. */
  commitHash(series: number, round: number, accountId: string, side: Side, size: number, price: number, salt: string): string {
    return commitHash({ series, round, accountId, side, size, price, salt });
  }

  // Internals

  #emit(e: WeirEvent): void {
    this.events.push(e);
  }

  #account(accountId: string): AccountView {
    const a = this.#accounts.get(accountId);
    if (!a) throw new Error(ERR.NOT_REGISTERED);
    return a;
  }

  #unsettled(series: number): SeriesRecord {
    const r = this.#series.get(series);
    if (!r) throw new Error(ERR.UNKNOWN_SERIES);
    if (r.settlement) throw new Error(ERR.SETTLED);
    return r;
  }

  /** The record to create if `series` is not open yet, or null if it is. Throws if it cannot open. */
  #prepareOpening(series: number): Omit<SeriesRecord, "openedAt"> | null {
    if (this.#series.has(series)) return null;
    const last = this.#lastPrint;
    if (last === null || this.#now - last.bucket > this.params.maxAnchorAgeSecs) throw new Error(ERR.STALE);
    const { floor, band } = computeBand(last.price, this.params.tick, this.params.bandBps);
    return { series, anchor: last.price, floor, band, openSets: 0, settlement: null, unredeemed: 0n };
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

  #windowClosed(bucket: number): boolean {
    return this.#now >= bucket + this.params.printIntervalSecs + this.params.reportGraceSecs;
  }

  /** Undecided buckets, oldest first. Every stored bucket has at least one report. */
  #undecided(): PrintRecord[] {
    return [...this.#prints.values()].filter((p) => p.state === "Open").sort((a, b) => a.bucket - b.bucket);
  }

  /** Decides a bucket once and for all (section 9). Returns whether it got a final print. */
  #decide(print: PrintRecord): boolean {
    const p = this.params;
    const reports = print.reports.length;
    const price = decidePrint(print.reports.map((r) => r.price), p.quorum, p.maxSpreadBps);
    if (price === null) {
      print.state = "NoPrint";
      this.#emit({ event: "no_print", data: { bucket: print.bucket, reports } });
      return false;
    }
    print.state = "Final";
    print.price = price;
    if (this.#lastPrint === null || print.bucket > this.#lastPrint.bucket) this.#lastPrint = { bucket: print.bucket, price };
    const series = seriesOf(p, print.bucket);
    if (series !== null) {
      const acc = this.getAccumulator(series);
      this.#accumulators.set(series, { sum: acc.sum + BigInt(price), count: acc.count + 1 });
    }
    this.#emit({ event: "print", data: { bucket: print.bucket, price, reports } });
    return true;
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
}

/** Section 6.4, with the guard and reference the commit recorded. */
function guardVoids(c: Commit, side: Side, price: number): boolean {
  if (c.guard === null) return false;
  return side === "Long" ? price > c.ref + c.guard : price + c.guard < c.ref;
}

function validateParams(p: Params): void {
  for (const name of [
    "t0",
    "cutoffSecs",
    "bandBps",
    "tick",
    "maxSpreadBps",
    "minPrints",
    "forfeitBps",
    "maxCommits",
    "maxOrderSize",
    "quorum",
  ] as const) {
    uint(name, p[name]);
  }
  // cutoff_secs is the one duration that may be zero: auctions may run up to delivery.
  const durations = [
    p.periodSecs,
    p.leadSecs,
    p.commitSecs,
    p.revealSecs,
    p.printIntervalSecs,
    p.reportGraceSecs,
    p.voidAfterSecs,
    p.maxAnchorAgeSecs,
  ];
  if (!durations.every((d) => Number.isSafeInteger(d) && d > 0)) throw new Error(ERR.DURATION);
  if (p.tick === 0) throw new Error(ERR.TICK);
  if (p.bandBps === 0 || p.bandBps >= 10_000) throw new Error(ERR.BAND_BPS);
  if (p.forfeitBps > 10_000) throw new Error(ERR.FORFEIT_BPS);
  if (p.maxCommits < 1 || p.maxCommits > 128) throw new Error(ERR.MAX_COMMITS);
  if (p.maxOrderSize < 1) throw new Error(ERR.MAX_ORDER_SIZE);
  if (p.cutoffSecs >= p.leadSecs) throw new Error(ERR.CUTOFF);
  if (p.minPrints < 1) throw new Error(ERR.MIN_PRINTS);
  if (p.minPrints > Math.floor(p.periodSecs / p.printIntervalSecs)) throw new Error(ERR.MAX_PRINTS);
  if (p.voidAfterSecs < p.reportGraceSecs) throw new Error(ERR.VOID_AFTER);
  if (p.maxSpreadBps === 0 || p.maxSpreadBps > 10_000) throw new Error(ERR.MAX_SPREAD_BPS);
  if (auctionCapacity(p) >= 2n ** 52n) throw new Error(ERR.CAPACITY);
  if (p.t0 % p.printIntervalSecs !== 0 || p.periodSecs % p.printIntervalSecs !== 0) throw new Error(ERR.BUCKET_GRID);
  if (p.minLock < 0n || p.commitFee < 0n) throw new Error("min_lock and commit_fee must not be negative");
  if (!isAccountId(p.usdc)) throw new Error(ERR.BAD_USDC);
  const r = p.reporters;
  if (r.length < 1 || r.length > 9 || new Set(r).size !== r.length || !r.every(isAccountId)) throw new Error(ERR.REPORTERS);
  if (p.quorum < 1 || p.quorum > r.length) throw new Error(ERR.QUORUM);
}

function uint(name: string, v: number): void {
  if (!Number.isSafeInteger(v) || v < 0) throw new Error(`${name} must be a non-negative integer`);
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
  return { bucket: p.bucket, price: p.price, state: p.state, reports: p.reports.map((r) => ({ ...r })) };
}
