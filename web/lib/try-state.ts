// The test bid's view state (components/front/app/try-view.tsx), kept apart from the chain code
// so it is tested in Node and so the page can draw a stored bid before the guest module loads.
// Nothing here signs or reads the chain: the guest (@weir/chain/guest, loaded lazily) does, and
// tells the view what happened through its events.
//
// Who signed the setup does not change the steps: a throwaway guest account sets itself up, and
// a wallet would sign the same two setup transactions (`setupTransactions`) before a local key
// trades. `signer` changes only the setup rows' labels; the reducer reads the same events.
//
// Types are written out here (not imported from @weir/chain) so this file stays small and the
// guest module stays out of every chunk but the one that loads it.

export type Signer = "guest" | "wallet";

/** The rows the view lists, in order. */
export const STEP_IDS = ["account", "register", "fund", "commit", "revealWait", "reveal", "clearWait", "clear"] as const;
export type StepId = (typeof STEP_IDS)[number];

export function stepLabel(id: StepId, signer: Signer): string {
  switch (id) {
    case "account":
      return signer === "wallet" ? "Wallet connected" : "Account created";
    case "register":
      return "Registered with the market";
    case "fund":
      return "Funded with test dollars";
    case "commit":
      return "Committed and sealed";
    case "revealWait":
      return "Waiting for the reveal phase";
    case "reveal":
      return "Revealed";
    case "clearWait":
      return "Waiting for the round to clear";
    case "clear":
      return "Cleared";
  }
}

// The guest's events and stored state, as much of them as the view reads (chain/src/guest.ts).
type GuestStep = "plan" | "key" | "account" | "register" | "fund" | "commit" | "reveal" | "clear" | "result" | "settle" | "redeem";
export type GuestEventLike =
  | { type: "step" | "done"; step: GuestStep; message: string }
  | { type: "tx"; step: GuestStep; method: string; hash: string; url: string; ok: boolean }
  | { type: "refused"; step: GuestStep; method: string; text: string; hash: string | null; url: string | null }
  | { type: "wait"; step: GuestStep; seconds: number; message: string };

export interface OrderLike {
  series: number;
  round: number;
  side: string;
  size: number;
  price: number;
  lock: string;
  floor: number;
  band: number;
  seqs: number[] | null;
  /** `missed`: the reveal phase ended before it was revealed (chain/src/guest.ts). */
  reveal?: "done" | "missed" | "evicted";
}

export interface ResultLike {
  accountId: string;
  series: number;
  round: number;
  order: OrderLike;
  clearingPrice: number | null;
  clearingPriceAbs: number | null;
  filled: number;
  outcome: string;
  position: { long: number; short: number };
  balance: string;
  seconds: number;
}

export interface TxLike {
  step: string;
  method: string;
  hash: string;
  ok: boolean;
}

/** What the page keeps of the stored guest: everything but the secret key. */
export interface StoredGuest {
  accountId: string;
  external: boolean;
  order: OrderLike | null;
  result: ResultLike | null;
  txs: TxLike[];
  history: ResultLike[];
}

export const EXPLORER_TX = "https://testnet.nearblocks.io/txns/";
export const guestKey = (contractId: string): string => `weir-guest:${contractId}`;
/** The guest state (`Guest.forAccount`) of the wallet's account, apart from the throwaway guest's. */
export const walletGuestKey = (contractId: string): string => `weir-wallet-guest:${contractId}`;

// The wallet's record lives in lib/wallet-record.ts, which the header reads on every page.
export { readWallet, walletAccount, walletKey, type WalletRecord } from "./wallet-record.ts";

// ── Storage ──────────────────────────────────────────────────────

/** The part of `localStorage` the page uses. */
export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** `window.localStorage`, or null where the browser refuses it (some private windows, blocked
 * site data). Reading the property itself can throw. */
export function localKV(): KV | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** True when a value can be written, read back and removed. */
export function storageWorks(kv: KV | null): boolean {
  if (!kv) return false;
  const probe = "weir-guest:probe";
  try {
    kv.setItem(probe, "1");
    const ok = kv.getItem(probe) === "1";
    kv.removeItem(probe);
    return ok;
  } catch {
    return false;
  }
}

/** The guest's storage (`GuestStorage` in chain/src/guest.ts) on `localStorage`. The throwaway
 * key lives here and nowhere else. A write that fails throws, so the guest stops before it
 * sends anything it could not resume. */
export function guestStorage(kv: KV): { get(key: string): string | null; set(key: string, value: string): void; forget(key: string): void } {
  return {
    get: (key) => {
      try {
        return kv.getItem(key);
      } catch {
        return null;
      }
    },
    set: (key, value) => {
      try {
        kv.setItem(key, value);
      } catch (e) {
        throw new Error(`this browser refused to store the test account (${e instanceof Error ? e.message : String(e)}); nothing more is sent`);
      }
    },
    forget: (key) => {
      try {
        kv.removeItem(key);
      } catch {
        // Nothing stored, or storage blocked: nothing to forget.
      }
    },
  };
}

/** The stored guest without its secret key, or null when there is none or it cannot be read. */
export function readStored(raw: string | null): StoredGuest | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Record<string, unknown>;
    if (typeof s.accountId !== "string") return null;
    return {
      accountId: s.accountId,
      external: s.external === true,
      order: (s.order as OrderLike | null) ?? null,
      result: (s.result as ResultLike | null) ?? null,
      txs: Array.isArray(s.txs) ? (s.txs as TxLike[]) : [],
      history: Array.isArray(s.history) ? (s.history as ResultLike[]) : [],
    };
  } catch {
    return null;
  }
}

/** The bid ended without its reveal: 1% of the lock forfeited at clearing, the rest returned. */
export const missedReveal = (r: ResultLike | null): boolean => r?.order.reveal === "missed";

/** Every row done, except the reveal of a bid whose reveal was missed. */
function finished(rows: Record<StepId, Row>, r: ResultLike): Record<StepId, Row> {
  const out = Object.fromEntries(STEP_IDS.map((id) => [id, { ...rows[id], status: "done" }])) as unknown as Record<StepId, Row>;
  if (missedReveal(r)) out.reveal = { ...out.reveal, status: "failed" };
  return out;
}

/** The reveal row of an order whose reveal phase ended unrevealed, before the round is read:
 * failed, not done, while the page checks the round (it read "Revealed: done" for about 20 s
 * on 13 Nov 2026, while the clear waited for the keeper). */
function markMissed(rows: Record<StepId, Row>, o: OrderLike | null | undefined): Record<StepId, Row> {
  if (o?.reveal !== "missed") return rows;
  return { ...rows, reveal: { ...rows.reveal, status: "failed", note: "The reveal phase ended before the order was revealed. Checking the round." } };
}

/** The bid ended, or is ending, without its reveal. */
export const revealMissed = (s: Pick<TryState, "result" | "sealed">): boolean => missedReveal(s.result) || s.sealed?.reveal === "missed";

/** A committed order not yet cleared: it must be revealed, so the page resumes it on open. */
export const hasOpenBid = (s: StoredGuest | null): boolean => !!s?.order && !s.result;

// ── The steps ────────────────────────────────────────────────────

export type RowStatus = "todo" | "active" | "done" | "failed";

export interface RowTx {
  method: string;
  url: string;
  ok: boolean;
}

export interface Row {
  status: RowStatus;
  /** The guest's own words for the last thing it did in this step. */
  note: string | null;
  txs: RowTx[];
  /** Refusals in this step the guest went past (a clear that lost the race, say), verbatim. */
  refusals: string[];
}

export interface ViewError {
  kind: string;
  message: string;
  /** The contract's text, verbatim, when a call was refused. */
  refusal: string | null;
  /** One plain sentence on what to do. */
  advice: string;
}

export interface SettleView {
  status: "running" | "done" | "failed";
  note: string | null;
  /** The contract's text when settling was refused. */
  refusal: string | null;
  balance: string | null;
  txs: RowTx[];
}

export interface TryState {
  signer: Signer;
  run: "idle" | "running" | "done" | "failed";
  accountId: string | null;
  rows: Record<StepId, Row>;
  /** What the guest is waiting for, with the wall-clock time (ms) it expects it. */
  wait: { step: GuestStep; until: number; message: string } | null;
  error: ViewError | null;
  result: ResultLike | null;
  /** The order committed and not yet cleared (the page says to keep the tab open). */
  sealed: OrderLike | null;
  history: ResultLike[];
  settle: SettleView | null;
}

const emptyRows = (): Record<StepId, Row> => Object.fromEntries(STEP_IDS.map((id) => [id, { status: "todo", note: null, txs: [], refusals: [] }])) as unknown as Record<StepId, Row>;

export const initialTry = (signer: Signer = "guest"): TryState => ({ signer, run: "idle", accountId: null, rows: emptyRows(), wait: null, error: null, result: null, sealed: null, history: [], settle: null });

/** The row a guest event belongs to. Waits in the reveal and clear steps are rows of their own. */
export function rowOf(step: GuestStep, type: GuestEventLike["type"]): StepId | null {
  switch (step) {
    case "key":
    case "account":
      return "account";
    case "register":
      return "register";
    case "fund":
      return "fund";
    case "commit":
      return "commit";
    case "reveal":
      return type === "wait" ? "revealWait" : "reveal";
    case "clear":
      return type === "wait" ? "clearWait" : "clear";
    case "result":
      return "clear";
    default:
      return null;
  }
}

const txRow = (step: string): StepId | null => rowOf(step as GuestStep, "tx");

function withRow(rows: Record<StepId, Row>, id: StepId, f: (r: Row) => Row, settleEarlier: boolean): Record<StepId, Row> {
  const next = { ...rows };
  const at = STEP_IDS.indexOf(id);
  if (settleEarlier) for (const e of STEP_IDS.slice(0, at)) if (next[e].status === "todo" || next[e].status === "active") next[e] = { ...next[e], status: "done" };
  next[id] = f(next[id]);
  return next;
}

/** Rows rebuilt from the stored guest: what its transactions and its order show is done. */
export function rowsFromStored(s: StoredGuest): Record<StepId, Row> {
  let rows = emptyRows();
  for (const t of s.txs) {
    const id = txRow(t.step);
    if (!id) continue;
    rows = withRow(rows, id, (r) => ({ ...r, status: t.ok ? "done" : r.status, txs: [...r.txs, { method: t.method, url: EXPLORER_TX + t.hash, ok: t.ok }] }), t.ok);
  }
  if (s.order?.seqs) rows = withRow(rows, "commit", (r) => ({ ...r, status: "done" }), true);
  return s.result ? finished(rows, s.result) : markMissed(rows, s.order);
}

export type TryAction =
  | { type: "restore"; stored: StoredGuest | null }
  | { type: "start"; at: number }
  | { type: "event"; e: GuestEventLike; at: number }
  /** The stored guest after an event: the account name once its key is made, and the order
   * once it is stored (the guest stores it before it sends the commit). */
  | { type: "stored"; stored: StoredGuest | null }
  | { type: "result"; result: ResultLike }
  | { type: "error"; error: ViewError }
  | { type: "next"; stored: StoredGuest | null }
  | { type: "settle-start" }
  | { type: "settle-done"; settled: boolean; reason: string | null; balance: string; txs: Omit<TxLike, "step">[] }
  | { type: "settle-error"; error: ViewError }
  | { type: "forget" };

export function tryReducer(s: TryState, a: TryAction): TryState {
  switch (a.type) {
    case "restore":
    case "next": {
      const base = initialTry(s.signer);
      if (!a.stored) return base;
      const st = a.stored;
      return { ...base, accountId: st.accountId, rows: rowsFromStored(st), run: st.result ? "done" : "idle", result: st.result, sealed: hasOpenBid(st) ? st.order : null, history: st.history };
    }
    case "start":
      return { ...s, run: "running", error: null, wait: null, settle: null, rows: Object.fromEntries(STEP_IDS.map((id) => [id, s.rows[id].status === "failed" ? { ...s.rows[id], status: "todo" } : s.rows[id]])) as unknown as Record<StepId, Row> };
    case "stored":
      if (!a.stored) return s;
      return {
        ...s,
        accountId: a.stored.accountId,
        sealed: a.stored.order?.seqs?.length && !a.stored.result ? a.stored.order : null,
        history: a.stored.history,
        rows: a.stored.result ? s.rows : markMissed(s.rows, a.stored.order),
      };
    case "event": {
      const e = a.e;
      if (e.step === "settle" || e.step === "redeem") {
        const st = s.settle ?? { status: "running", note: null, refusal: null, balance: null, txs: [] };
        if (e.type === "tx") return { ...s, settle: { ...st, txs: [...st.txs, { method: e.method, url: e.url, ok: e.ok }] } };
        if (e.type === "refused") return { ...s, settle: { ...st, refusal: e.text } };
        return { ...s, settle: { ...st, note: e.message } };
      }
      if (e.type === "wait") {
        const wait = { step: e.step, until: a.at + e.seconds * 1000, message: e.message };
        const id = rowOf(e.step, "wait");
        if (!id) return { ...s, wait };
        return { ...s, wait, rows: withRow(s.rows, id, (r) => ({ ...r, status: "active", note: e.message }), true) };
      }
      const id = rowOf(e.step, e.type);
      if (e.type === "tx") {
        if (!id) return s;
        return { ...s, rows: withRow(s.rows, id, (r) => ({ ...r, txs: [...r.txs, { method: e.method, url: e.url, ok: e.ok }] }), false) };
      }
      if (e.type === "refused") {
        if (!id) return s;
        return { ...s, rows: withRow(s.rows, id, (r) => ({ ...r, refusals: [...r.refusals, e.text] }), false) };
      }
      // step or done
      if (!id) return { ...s, wait: e.step === "plan" ? s.wait : null };
      // A key made is not an account made: the row is done when the faucet has created it.
      const status: RowStatus = e.type === "done" && e.step !== "key" ? "done" : "active";
      let rows = withRow(s.rows, id, (r) => ({ ...r, status: r.status === "done" && status === "active" ? "done" : status, note: e.message }), true);
      // "found already done" messages are steps that need nothing more.
      if (e.type === "step" && /\b(exists|is registered|covers|already)\b/.test(e.message)) rows = withRow(rows, id, (r) => ({ ...r, status: "done" }), false);
      // A reveal or a clear that begins ends its wait.
      if (id === "reveal") rows = withRow(rows, "revealWait", (r) => ({ ...r, status: "done" }), false);
      if (id === "clear") rows = withRow(rows, "clearWait", (r) => ({ ...r, status: "done" }), false);
      return { ...s, rows, wait: null };
    }
    case "result":
      return { ...s, run: "done", wait: null, sealed: null, result: a.result, accountId: a.result.accountId, rows: finished(s.rows, a.result) };
    case "error": {
      const rows = { ...s.rows };
      for (const id of STEP_IDS) if (rows[id].status === "active") rows[id] = { ...rows[id], status: "failed" };
      return { ...s, run: "failed", wait: null, rows, error: a.error };
    }
    case "settle-start":
      return { ...s, settle: { status: "running", note: null, refusal: null, balance: null, txs: [] } };
    case "settle-done":
      return { ...s, settle: { ...(s.settle ?? { note: null, refusal: null, txs: [] }), status: a.settled ? "done" : "failed", refusal: a.reason, balance: a.balance, txs: a.txs.map((t) => ({ method: t.method, url: EXPLORER_TX + t.hash, ok: t.ok })) } };
    case "settle-error":
      return { ...s, settle: { ...(s.settle ?? { note: null, refusal: null, balance: null, txs: [] }), status: "failed", note: a.error.message, refusal: a.error.refusal } };
    case "forget":
      return initialTry(s.signer);
  }
}

/** What an unrevealed order forfeits: `forfeitBps` of its lock, micro-USDC (SPEC: burned at clearing). */
export const forfeitOf = (lock: string, forfeitBps: number): bigint => (BigInt(lock) * BigInt(forfeitBps)) / 10_000n;

// ── What to do after a failure ───────────────────────────────────

/** One plain sentence on what to do, by the guest's error kind and step. */
export function adviceFor(kind: string, step: string | null): string {
  switch (kind) {
    case "closed":
      return "No series is taking bids now. Try again when the next series opens.";
    case "stale":
      return "No new series can open until the index prints again. Try again in a few minutes.";
    case "timeout":
      return step === "account" ? "The testnet faucet did not create the account in time. Try again in a few minutes; the same account is used." : "Nothing was committed. Try again in the next round.";
    case "faucet":
      return "The testnet faucet refused to create the account. Forget this account and try again later.";
    case "unfunded":
      return "Deposit more test dollars into the market, then try again.";
    case "allowance":
      return "The round is left to the keeper; open this page again later to read the fill.";
    case "refused":
      if (step === "commit") return "Nothing was committed and no fee was paid. Try again in the next round.";
      if (step === "reveal") return "The bid was not revealed in time, so 1% of its lock is forfeited when the round clears. You can bid again in the next round.";
      if (step === "fund") return "Press the button again to deposit again; finished steps are not repeated.";
      return "Press the button again; finished steps are read from the chain and not repeated.";
    case "rpc":
      return "The NEAR RPC did not answer. Press the button again; finished steps are read from the chain and not repeated.";
    default:
      return "Press the button again; finished steps are read from the chain and not repeated.";
  }
}

// ── The button ───────────────────────────────────────────────────

/** What the view needs of the guest's plan (`GuestPlan` and its params). */
export interface PlanView {
  /** Chain time, Unix seconds, when read. */
  now: number;
  /** Wall-clock ms when read: the page counts from here. */
  readAt: number;
  status: "ready" | "wait" | "closed" | "stale";
  reason: string;
  series: number | null;
  round: number | null;
  phase: string | null;
  phaseEndsAt: number | null;
  floor: number | null;
  band: number | null;
  tick: number;
  lastClearing: { round: number; price: number } | null;
  order: { side: string; size: number; price: number; lock: string; fee: string; maxNeed: string } | null;
  commitSecs: number;
  revealSecs: number;
  t0: number;
  periodSecs: number;
  forfeitBps: number;
}

/** A commit phase with less than this left is not started (the guest's own default). */
export const MIN_COMMIT_LEFT = 30;

/** The phase at chain time `now`, carried forward from what the plan read: rounds repeat every
 * commit + reveal seconds, so a plan read a minute ago still says when the next commit opens. */
export function phaseNow(p: PlanView, now: number): { phase: "Commit" | "Reveal"; endsAt: number; nextCommitAt: number } | null {
  if (p.phaseEndsAt === null || (p.phase !== "Commit" && p.phase !== "Reveal")) return null;
  const round = p.commitSecs + p.revealSecs;
  if (round <= 0) return null;
  const commitStart = p.phase === "Commit" ? p.phaseEndsAt - p.commitSecs : p.phaseEndsAt;
  const k = Math.floor((now - commitStart) / round);
  const start = commitStart + k * round;
  const commitEnd = start + p.commitSecs;
  return now < commitEnd ? { phase: "Commit", endsAt: commitEnd, nextCommitAt: start + round } : { phase: "Reveal", endsAt: start + round, nextCommitAt: start + round };
}

export interface ButtonInput {
  /** Where the page's figures come from: only "chain" can bid. */
  mode: string;
  storage: boolean;
  /** A call is in flight (this tab or another holds the bid). */
  busy: boolean;
  /** A committed order is waiting for its reveal or its clearing. */
  open: boolean;
  plan: PlanView | null;
  planError: string | null;
  /** Chain time now, Unix seconds (the plan's clock carried forward). */
  now: number;
}

export interface ButtonState {
  enabled: boolean;
  /** Why it is disabled, in one sentence. */
  reason: string | null;
  /** Chain time (s) the next commit phase opens, for the countdown. */
  until: number | null;
}

export function bidButton(i: ButtonInput): ButtonState {
  const off = (reason: string, until: number | null = null): ButtonState => ({ enabled: false, reason, until });
  if (i.mode !== "chain") return off(i.mode === "model" ? "This build shows the model, not the testnet market, so there is nothing to bid on." : "The hourly market is not deployed.");
  if (!i.storage) return off("This browser does not let the page keep data, and the test account's key has to be kept until the reveal.");
  if (i.open) return off("Your sealed bid is still open: it is revealed and cleared first.");
  if (i.busy) return off("A call is in flight.");
  if (!i.plan) return off(i.planError ? `The market could not be read: ${i.planError}` : "Reading the market.");
  const p = i.plan;
  if (p.status === "closed") return off("No series is in its auction window now.");
  if (p.status === "stale") return off("The index is stale, so the series cannot open until the reporters print again.");
  const ph = phaseNow(p, i.now);
  if (!ph) return off("No round is in progress.");
  if (ph.phase === "Commit" && ph.endsAt - i.now >= MIN_COMMIT_LEFT) return { enabled: true, reason: null, until: null };
  return off(ph.phase === "Commit" ? `Less than ${MIN_COMMIT_LEFT} s of the commit phase is left.` : "The round is in its reveal phase.", ph.nextCommitAt);
}

/** The end of a series' delivery hour (SPEC section 4): `t0 + (series + 1) x period`. */
export const deliveryEnd = (p: Pick<PlanView, "t0" | "periodSecs">, series: number): number => p.t0 + (series + 1) * p.periodSecs;

/** Series of this account's bids whose delivery has ended, oldest first, each once. */
export function settleable(s: Pick<TryState, "result" | "history">, p: Pick<PlanView, "t0" | "periodSecs"> | null, now: number): number[] {
  if (!p) return [];
  const series = [...new Set([...s.history, ...(s.result ? [s.result] : [])].map((r) => r.series))].sort((a, b) => a - b);
  return series.filter((x) => now >= deliveryEnd(p, x));
}
