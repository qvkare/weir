// The contract's JSON interface (SPEC sections 3, 5 to 14), served from a Market. These
// types are the single definition of the wire format: snake_case keys, dollar amounts
// (u128) as decimal strings, prices, sizes, times and counts as numbers. A client written
// against `callView` and `callChange` can be pointed at the model or at the chain without
// change; refusals throw the contract's texts (section 16).
import { ERR } from "./errors.ts";
import type { Side } from "./hash.ts";
import type { PrintState } from "./index.ts";
import type { CommitState, Market, PrintView, ResultView, SettlementView, WeirEvent } from "./market.ts";
import type { Phase } from "./time.ts";

/** A u128 dollar amount in micro-USDC, as a decimal string (section 12). */
export type U128 = string;

// Views, section 12

/** `get_params`: the parameters of section 3. */
export interface WireParams {
  usdc: string;
  underlying: string;
  t0: number;
  period_secs: number;
  lead_secs: number;
  cutoff_secs: number;
  commit_secs: number;
  reveal_secs: number;
  band_bps: number;
  tick: number;
  print_interval_secs: number;
  report_grace_secs: number;
  max_spread_bps: number;
  min_prints: number;
  void_after_secs: number;
  max_anchor_age_secs: number;
  forfeit_bps: number;
  min_lock: U128;
  commit_fee: U128;
  max_commits: number;
  max_order_size: number;
  reporters: string[];
  quorum: number;
}

/** `get_status().live[i]` (sections 4 and 12). `round` and `phase_ends_at` are null when `phase` is `Closed`. */
export interface WireLiveSeries {
  series: number;
  delivery_start: number;
  delivery_end: number;
  auction_open: number;
  auction_close: number;
  round: number | null;
  phase: Phase;
  phase_ends_at: number | null;
}

/** `get_status` (section 12): at most 32 series, lowest first. */
export interface WireStatus {
  now: number;
  live: WireLiveSeries[];
}

/** `get_series(series).settlement` (sections 10 and 12). */
export interface WireSettlement {
  fixing: number;
  long_payout: number;
  short_payout: number;
  prints: number;
  void: boolean;
  settled_at: number;
}

/** `get_series` (sections 6.1 and 12), or null for a series never opened. */
export interface WireSeries {
  series: number;
  anchor: number;
  floor: number;
  band: number;
  opened_at: number;
  open_sets: number;
  /** What the series' auctions traded (section 7.3). Informational: no rule reads them. */
  traded_units: number;
  traded_value: U128;
  /** Rounds, ascending, that hold commits and have not been cleared. */
  pending_rounds: number[];
  settlement: WireSettlement | null;
}

/** `get_account` (sections 5, 6.2, 6.4 and 12), or null for an unregistered account. */
export interface WireAccount {
  balance: U128;
  guard: number | null;
  max_round_lock: U128 | null;
}

/** `get_position` (section 12); zeros when the account holds nothing. */
export interface WirePosition {
  long: number;
  short: number;
}

/** An order's terms once revealed (section 6.3). `price` is always a LONG price. */
export interface WireOrder {
  side: Side;
  size: number;
  price: number;
}

/** `get_round(...).commits[i]` (sections 6.2 and 12). `order` is null until revealed. */
export interface WireCommit {
  seq: number;
  owner: string;
  hash: string;
  lock: U128;
  fee: U128;
  state: CommitState;
  order: WireOrder | null;
}

/** `get_round` (section 12), or null once cleared or before the first commit. */
export interface WireRound {
  next_seq: number;
  commits: WireCommit[];
}

/** `get_result(...).fills[i]` (sections 7.2 and 12): only orders that were filled, in seq order. */
export interface WireFill extends WireOrder {
  seq: number;
  owner: string;
  filled: number;
}

/** `get_result` (sections 7 and 12), or null. `price` is null when nothing traded;
 * `forfeited` and `fees` are what the round burned. */
export interface WireResult {
  price: number | null;
  volume: number;
  long_size: number;
  short_size: number;
  orders: number;
  commits: number;
  forfeited: U128;
  fees: U128;
  cleared_at: number;
  fills: WireFill[];
}

/** `get_print(...).reports[i]` (section 9). */
export interface WireReport {
  reporter: string;
  price: number;
  bundle: string;
}

/** `get_print` (sections 9 and 12), or null (never reported, or pruned). `price` is null
 * unless `state` is `Final`. */
export interface WirePrint {
  bucket: number;
  price: number | null;
  state: PrintState;
  reports: WireReport[];
}

/** `get_last_print` (section 12), or null before the first print. */
export interface WireLastPrint {
  bucket: number;
  price: number;
}

/** `get_accumulator` (sections 9 and 12). `sum` is a u128 sum of prices, sent as a string. */
export interface WireAccumulator {
  sum: U128;
  count: number;
}

/** `get_totals` (sections 11 and 12): the five terms of invariant 1, which sum to the
 * contract's USDC. `locked` includes the fees held in rounds not yet cleared. */
export interface WireTotals {
  free: U128;
  locked: U128;
  sets_backing: U128;
  unredeemed: U128;
  burned: U128;
}

type NoArgs = Record<string, never>;

/** Every view: its JSON arguments and what it returns (section 12). */
export interface ViewMethods {
  get_params: { args: NoArgs; result: WireParams };
  get_status: { args: NoArgs; result: WireStatus };
  get_series: { args: { series: number }; result: WireSeries | null };
  get_account: { args: { account_id: string }; result: WireAccount | null };
  get_position: { args: { series: number; account_id: string }; result: WirePosition };
  get_round: { args: { series: number; round: number }; result: WireRound | null };
  get_result: { args: { series: number; round: number }; result: WireResult | null };
  /** A `limit` above 100 is treated as 100. */
  get_results: { args: { series: number; from_round: number; limit: number }; result: [number, WireResult][] };
  get_print: { args: { bucket: number }; result: WirePrint | null };
  /** The undecided buckets that have reports, ascending. */
  get_pending_prints: { args: NoArgs; result: number[] };
  get_last_print: { args: NoArgs; result: WireLastPrint | null };
  /** A `limit` above 200 is treated as 200. */
  get_prints: { args: { from_bucket: number; limit: number }; result: WirePrint[] };
  get_accumulator: { args: { series: number }; result: WireAccumulator };
  get_totals: { args: NoArgs; result: WireTotals };
  commit_hash: {
    args: { series: number; round: number; account_id: string; side: Side; size: number; price: number; salt: string };
    result: string;
  };
}

export type ViewMethod = keyof ViewMethods;

// Change methods, sections 5 to 10 and 14

/** Every state-changing method: its JSON arguments and what it returns (section 12):
 * `commit` the seq, `report` and `finalize_print` a boolean, `deposit` what `ft_on_transfer`
 * returns, and null for every method that returns nothing. */
export interface ChangeMethods {
  /** Section 5. Registers `account_id`, or the caller. */
  register: { args: { account_id?: string }; result: null };
  /** Section 5: `ft_on_transfer`, called by the token contract, which must be `usdc`.
   * Credits `msg` if not empty, else `sender_id`. Returns the amount sent back. */
  deposit: { args: { sender_id: string; amount: U128; msg: string }; result: U128 };
  /** Section 5. */
  withdraw: { args: { amount: U128 }; result: null };
  /** Sections 5 and 6.4. Sets both limits; a missing or null one is cleared. */
  set_guard: { args: { guard?: number | null; max_round_lock?: U128 | null }; result: null };
  /** Section 6.2. Returns the commit's seq. */
  commit: { args: { series: number; hash: string; lock: U128 }; result: number };
  /** Section 6.3. */
  reveal: {
    args: { series: number; round: number; seq: number; side: Side; size: number; price: number; salt: string };
    result: null;
  };
  /** Section 7. */
  clear: { args: { series: number; round: number }; result: null };
  /** Section 8. */
  mint: { args: { series: number; sets: number }; result: null };
  /** Section 8. */
  merge: { args: { series: number; sets: number }; result: null };
  /** Section 8. */
  transfer_position: { args: { series: number; to: string; long: number; short: number }; result: null };
  /** Section 9. Returns true when this call gave the bucket a final print. */
  report: { args: { bucket: number; price: number; bundle: string }; result: boolean };
  /** Section 9. Decides a closed bucket; returns whether it got a final print. */
  finalize_print: { args: { bucket: number }; result: boolean };
  /** Sections 9 and 14. */
  prune_print: { args: { bucket: number }; result: null };
  /** Section 10. */
  settle: { args: { series: number }; result: null };
  /** Section 10. Redeems for `account_id`, or the caller. */
  redeem: { args: { series: number; account_id?: string }; result: null };
  /** Section 14. */
  prune_result: { args: { series: number; round: number }; result: null };
}

export type ChangeMethod = keyof ChangeMethods;

// Events, section 13

/** The `data` of each event of section 13, keys in the order the contract writes them. */
export interface WireEventData {
  register: { account_id: string };
  deposit: { account_id: string; amount: U128 };
  withdraw: { account_id: string; amount: U128 };
  withdraw_failed: { account_id: string; amount: U128 };
  series_opened: { series: number; anchor: number; floor: number; band: number };
  commit: { series: number; round: number; seq: number; account_id: string; hash: string; lock: U128; fee: U128 };
  evict: { series: number; round: number; seq: number; account_id: string; lock: U128; fee: U128 };
  reveal: {
    series: number;
    round: number;
    seq: number;
    account_id: string;
    side: Side;
    size: number;
    price: number;
    void: boolean;
  };
  clear: { series: number; round: number; price: number | null; volume: number; forfeited: U128; fees: U128 };
  mint: { series: number; account_id: string; sets: number };
  merge: { series: number; account_id: string; sets: number };
  transfer_position: { series: number; from: string; to: string; long: number; short: number };
  report: { bucket: number; reporter: string; price: number; bundle: string };
  /** `reports` is the number of reports behind the print. */
  print: { bucket: number; price: number; reports: number };
  no_print: { bucket: number; reports: number };
  prune_print: { bucket: number };
  prune_result: { series: number; round: number };
  settle: { series: number; fixing: number; long_payout: number; short_payout: number; void: boolean };
  redeem: { series: number; account_id: string; amount: U128 };
  guard: { account_id: string; guard: number | null; max_round_lock: U128 | null };
}

/** A NEP-297 event as logged after `EVENT_JSON:` (section 13). */
export type WireEvent = {
  [E in keyof WireEventData]: { standard: "weir"; version: "1.0.0"; event: E; data: WireEventData[E] };
}[keyof WireEventData];

// Conversion

const u128 = (v: bigint): U128 => v.toString();
const u128OrNull = (v: bigint | null): U128 | null => (v === null ? null : v.toString());

function parseU128(name: string, v: unknown): bigint {
  if (typeof v !== "string" || !/^(0|[1-9][0-9]*)$/.test(v)) throw new Error(`${name} must be a decimal string`);
  return BigInt(v);
}

function wireSettlement(s: SettlementView): WireSettlement {
  return {
    fixing: s.fixing,
    long_payout: s.longPayout,
    short_payout: s.shortPayout,
    prints: s.prints,
    void: s.void,
    settled_at: s.settledAt,
  };
}

function wireResult(r: ResultView): WireResult {
  return {
    price: r.price,
    volume: r.volume,
    long_size: r.longSize,
    short_size: r.shortSize,
    orders: r.orders,
    commits: r.commits,
    forfeited: u128(r.forfeited),
    fees: u128(r.fees),
    cleared_at: r.clearedAt,
    fills: r.fills.map((f) => ({ seq: f.seq, owner: f.owner, side: f.side, size: f.size, price: f.price, filled: f.filled })),
  };
}

const wirePrint = (p: PrintView): WirePrint => ({ bucket: p.bucket, price: p.price, state: p.state, reports: p.reports });

type Handlers<M, Extra extends unknown[]> = {
  [K in keyof M]: (
    m: Market,
    ...rest: [...Extra, M[K] extends { args: infer A } ? A : never]
  ) => M[K] extends { result: infer R } ? R : never;
};

const views: Handlers<ViewMethods, []> = {
  get_params: (m) => {
    const p = m.params;
    return {
      usdc: p.usdc,
      underlying: p.underlying,
      t0: p.t0,
      period_secs: p.periodSecs,
      lead_secs: p.leadSecs,
      cutoff_secs: p.cutoffSecs,
      commit_secs: p.commitSecs,
      reveal_secs: p.revealSecs,
      band_bps: p.bandBps,
      tick: p.tick,
      print_interval_secs: p.printIntervalSecs,
      report_grace_secs: p.reportGraceSecs,
      max_spread_bps: p.maxSpreadBps,
      min_prints: p.minPrints,
      void_after_secs: p.voidAfterSecs,
      max_anchor_age_secs: p.maxAnchorAgeSecs,
      forfeit_bps: p.forfeitBps,
      min_lock: u128(p.minLock),
      commit_fee: u128(p.commitFee),
      max_commits: p.maxCommits,
      max_order_size: p.maxOrderSize,
      reporters: [...p.reporters],
      quorum: p.quorum,
    };
  },
  get_status: (m) => {
    const s = m.getStatus();
    return {
      now: s.now,
      live: s.live.map((l) => ({
        series: l.series,
        delivery_start: l.deliveryStart,
        delivery_end: l.deliveryEnd,
        auction_open: l.auctionOpen,
        auction_close: l.auctionClose,
        round: l.round,
        phase: l.phase,
        phase_ends_at: l.phaseEndsAt,
      })),
    };
  },
  get_series: (m, { series }) => {
    const s = m.getSeries(series);
    return (
      s && {
        series: s.series,
        anchor: s.anchor,
        floor: s.floor,
        band: s.band,
        opened_at: s.openedAt,
        open_sets: s.openSets,
        traded_units: s.tradedUnits,
        traded_value: u128(s.tradedValue),
        pending_rounds: s.pendingRounds,
        settlement: s.settlement && wireSettlement(s.settlement),
      }
    );
  },
  get_account: (m, { account_id }) => {
    const a = m.getAccount(account_id);
    return a && { balance: u128(a.balance), guard: a.guard, max_round_lock: u128OrNull(a.maxRoundLock) };
  },
  get_position: (m, { series, account_id }) => m.getPosition(series, account_id),
  get_round: (m, { series, round }) => {
    const r = m.getRound(series, round);
    return (
      r && {
        next_seq: r.nextSeq,
        commits: r.commits.map((c) => ({
          seq: c.seq,
          owner: c.owner,
          hash: c.hash,
          lock: u128(c.lock),
          fee: u128(c.fee),
          state: c.state,
          order: c.order,
        })),
      }
    );
  },
  get_result: (m, { series, round }) => {
    const r = m.getResult(series, round);
    return r && wireResult(r);
  },
  get_results: (m, { series, from_round, limit }) =>
    m.getResults(series, from_round, limit).map(([round, r]) => [round, wireResult(r)]),
  get_print: (m, { bucket }) => {
    const p = m.getPrint(bucket);
    return p && wirePrint(p);
  },
  get_pending_prints: (m) => m.getPendingPrints(),
  get_last_print: (m) => m.getLastPrint(),
  get_prints: (m, { from_bucket, limit }) => m.getPrints(from_bucket, limit).map(wirePrint),
  get_accumulator: (m, { series }) => {
    const a = m.getAccumulator(series);
    return { sum: u128(a.sum), count: a.count };
  },
  get_totals: (m) => {
    const t = m.getTotals();
    return {
      free: u128(t.free),
      locked: u128(t.locked),
      sets_backing: u128(t.setsBacking),
      unredeemed: u128(t.unredeemed),
      burned: u128(t.burned),
    };
  },
  commit_hash: (m, a) => m.commitHash(a.series, a.round, a.account_id, a.side, a.size, a.price, a.salt),
};

const changes: Handlers<ChangeMethods, [caller: string]> = {
  register: (m, caller, { account_id }) => {
    m.register(account_id ?? caller);
    return null;
  },
  deposit: (m, caller, { sender_id, amount, msg }) => {
    if (caller !== m.params.usdc) throw new Error(ERR.WRONG_TOKEN);
    return u128(m.deposit(msg === "" ? sender_id : msg, parseU128("amount", amount)));
  },
  withdraw: (m, caller, { amount }) => {
    m.withdraw(caller, parseU128("amount", amount));
    return null;
  },
  set_guard: (m, caller, { guard, max_round_lock }) => {
    const limit = max_round_lock == null ? null : parseU128("max_round_lock", max_round_lock);
    m.setGuard(caller, guard ?? null, limit);
    return null;
  },
  commit: (m, caller, { series, hash, lock }) => m.commit(caller, series, hash, parseU128("lock", lock)),
  reveal: (m, caller, a) => {
    m.reveal(caller, a.series, a.round, a.seq, a.side, a.size, a.price, a.salt);
    return null;
  },
  clear: (m, _caller, { series, round }) => {
    m.clear(series, round);
    return null;
  },
  mint: (m, caller, { series, sets }) => {
    m.mint(caller, series, sets);
    return null;
  },
  merge: (m, caller, { series, sets }) => {
    m.merge(caller, series, sets);
    return null;
  },
  transfer_position: (m, caller, { series, to, long, short }) => {
    m.transferPosition(caller, series, to, long, short);
    return null;
  },
  report: (m, caller, { bucket, price, bundle }) => m.report(caller, bucket, price, bundle),
  finalize_print: (m, _caller, { bucket }) => m.finalizePrint(bucket),
  prune_print: (m, _caller, { bucket }) => {
    m.prunePrint(bucket);
    return null;
  },
  settle: (m, _caller, { series }) => {
    m.settle(series);
    return null;
  },
  redeem: (m, caller, { series, account_id }) => {
    m.redeem(series, account_id ?? caller);
    return null;
  },
  prune_result: (m, _caller, { series, round }) => {
    m.pruneResult(series, round);
    return null;
  },
};

/** Calls a view by its contract name with the contract's JSON arguments. */
export function callView<M extends ViewMethod>(market: Market, method: M, args: ViewMethods[M]["args"]): ViewMethods[M]["result"] {
  if (!Object.hasOwn(views, method)) throw new Error(`unknown view ${String(method)}`);
  const handler = views[method] as (m: Market, a: ViewMethods[M]["args"]) => ViewMethods[M]["result"];
  return handler(market, args);
}

/** Calls a state-changing method as `caller`, by its contract name with the contract's JSON arguments. */
export function callChange<M extends ChangeMethod>(
  market: Market,
  caller: string,
  method: M,
  args: ChangeMethods[M]["args"],
): ChangeMethods[M]["result"] {
  if (!Object.hasOwn(changes, method)) throw new Error(`unknown method ${String(method)}`);
  const handler = changes[method] as (m: Market, c: string, a: ChangeMethods[M]["args"]) => ChangeMethods[M]["result"];
  return handler(market, caller, args);
}

/** The NEP-297 form of an event of `market.events` (section 13). Keys follow the order of
 * section 13, so the log line matches the contract's byte for byte. */
export function wireEvent(e: WeirEvent): WireEvent {
  const event = <E extends keyof WireEventData>(name: E, data: WireEventData[E]) =>
    ({ standard: "weir", version: "1.0.0", event: name, data }) as WireEvent;
  switch (e.event) {
    case "register":
      return event(e.event, { account_id: e.data.accountId });
    case "deposit":
    case "withdraw":
    case "withdraw_failed":
      return event(e.event, { account_id: e.data.accountId, amount: u128(e.data.amount) });
    case "series_opened":
    case "transfer_position":
    case "report":
    case "print":
    case "no_print":
    case "prune_print":
    case "prune_result":
      return event(e.event, e.data);
    case "commit": {
      const { series, round, seq, accountId, hash, lock, fee } = e.data;
      return event(e.event, { series, round, seq, account_id: accountId, hash, lock: u128(lock), fee: u128(fee) });
    }
    case "evict": {
      const { series, round, seq, accountId, lock, fee } = e.data;
      return event(e.event, { series, round, seq, account_id: accountId, lock: u128(lock), fee: u128(fee) });
    }
    case "reveal": {
      const { series, round, seq, accountId, side, size, price } = e.data;
      return event(e.event, { series, round, seq, account_id: accountId, side, size, price, void: e.data.void });
    }
    case "clear":
      return event(e.event, { ...e.data, forfeited: u128(e.data.forfeited), fees: u128(e.data.fees) });
    case "mint":
    case "merge":
      return event(e.event, { series: e.data.series, account_id: e.data.accountId, sets: e.data.sets });
    case "settle": {
      const { series, fixing, longPayout, shortPayout } = e.data;
      return event(e.event, { series, fixing, long_payout: longPayout, short_payout: shortPayout, void: e.data.void });
    }
    case "redeem":
      return event(e.event, { series: e.data.series, account_id: e.data.accountId, amount: u128(e.data.amount) });
    case "guard":
      return event(e.event, {
        account_id: e.data.accountId,
        guard: e.data.guard,
        max_round_lock: u128OrNull(e.data.maxRoundLock),
      });
  }
}

/** The log line the contract writes for an event. */
export const eventLog = (e: WeirEvent): string => `EVENT_JSON:${JSON.stringify(wireEvent(e))}`;
