// The guest path: a throwaway testnet account places one sealed bid in a Weir market by
// itself. It makes a key, has the faucet create the account, gets test dollars, registers,
// deposits, commits one LONG order, reveals it in the reveal phase, clears the round if nobody
// has, and reads the fill. `settle()` later settles the series and redeems the position.
//
// Portable: the RPC transport, the clock, sleep, random bytes and a small key-value storage
// are passed in, so the same code runs in Node (chain/src/cli.ts, `try`) and in a browser.
//
// Every step can be resumed from storage plus chain views after a restart, and none is done
// twice: the account, the registration and the balance are read from the chain before acting,
// and the order (with its salt) is written to storage before `commit` is sent, so a restart
// finds its own commit by hash in the round instead of committing again, and reveals it.
import {
  commitHash,
  ERR,
  roundEnd,
  roundStart,
  type Params,
  type Side,
  type WireLastPrint,
  type WireParams,
  type WireResult,
} from "@weir/engine";
import { accountExists, createWithFaucet, FAUCET_URL, FaucetError } from "./faucet.ts";
import { EndpointHealth, NearAccount, NearRpc, panicMessage, type FetchLike, type TxOutcome } from "./near.ts";
import { Token, TOKEN_CALLS } from "./token.ts";
import { KeyPair, secretKeyFromSeed } from "./tx.ts";
import { CALLS, CallFailed, ChainWeir, paramsFromWire, type WeirPort } from "./weir.ts";

export const EXPLORER_TX = "https://testnet.nearblocks.io/txns/";
export const txUrl = (hash: string): string => `${EXPLORER_TX}${hash}`;

/** A small key-value store: `localStorage` in a browser, a file in the CLI. */
export interface GuestStorage {
  get(key: string): string | null | Promise<string | null>;
  set(key: string, value: string): void | Promise<void>;
}

/** Storage in memory, for tests and for a page that does not need to survive a reload. */
export function memoryStorage(): GuestStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v) };
}

export interface GuestConfig {
  /** The Weir market, e.g. `weir-h100-fast-w1.testnet`. */
  contractId: string;
  /** RPC endpoints. Views go to dRPC first, transactions to fastnear first (chain/README.md). */
  rpcUrls: readonly string[];
  /** The test dollar. Read from `get_params` when left out. */
  usdcId?: string;
  faucetUrl?: string;
  /** New accounts are `<prefix><12 hex><suffix>`. Default `weir-try-` and `.testnet`. */
  accountPrefix?: string;
  accountSuffix?: string;
  /** Order size in GPU-hours. Default 5. */
  size?: number;
  /** The limit is the last clearing price plus this share of the band, in basis points. Default 1500 (15%). */
  markupBps?: number;
  /** A commit phase with fewer seconds left than this is skipped for the next round. Default 30 s. */
  minCommitLeftSecs?: number;
  /** After the round ends, how long the keeper gets to clear it before the guest does. Default 20 s. */
  keeperGraceSecs?: number;
  /** Between two reads while waiting. Default 5 s; views are never polled faster. */
  pollMs?: number;
  /** At least this long between two RPC requests. Default 1 s. */
  minGapMs?: number;
  /** Giving up: no commit is started after this long. A commit already made is always revealed. Default 15 min. */
  timeLimitMs?: number;
  /** Storage key. Default `weir-guest:<contractId>`. */
  storageKey?: string;
}

export interface GuestDeps {
  /** The RPC transport (`fetch` in a browser and in Node). */
  fetch: FetchLike;
  /** The faucet's transport. Default `fetch`. */
  faucetFetch?: FetchLike;
  /** Milliseconds. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Cryptographically random bytes (`crypto.getRandomValues`). */
  randomBytes: (n: number) => Uint8Array;
  storage: GuestStorage;
  onEvent?: (e: GuestEvent) => void;
}

export type GuestStep = "plan" | "key" | "account" | "register" | "fund" | "commit" | "reveal" | "clear" | "result" | "settle" | "redeem";

/** What the guest tells a page or a terminal, in order. */
export type GuestEvent =
  /** A step began, or was found already done (`message` says which). */
  | { type: "step"; step: GuestStep; message: string }
  /** A step finished. */
  | { type: "done"; step: GuestStep; message: string }
  /** A transaction's final outcome. */
  | { type: "tx"; step: GuestStep; method: string; receiver: string; hash: string; url: string; ok: boolean }
  /** The contract refused a call; `text` is its message verbatim (SPEC section 16). */
  | { type: "refused"; step: GuestStep; method: string; text: string; hash: string | null; url: string | null }
  /** Waiting for the chain's clock. */
  | { type: "wait"; step: GuestStep; seconds: number; message: string };

/** Why the guest stopped. `stop` kinds put nothing at risk: no commit is outstanding. */
export class GuestError extends Error {
  override readonly name = "GuestError";
  /** `unfunded`: an account set up by someone else has too little free balance in Weir.
   * `allowance`: its function-call key has too little gas allowance left. */
  readonly kind: "closed" | "stale" | "timeout" | "refused" | "faucet" | "unfunded" | "allowance" | "unknown";
  readonly step: GuestStep;
  /** The contract's text when a call was refused. */
  readonly refusal: string | null;

  constructor(kind: GuestError["kind"], step: GuestStep, message: string, refusal: string | null = null) {
    super(message);
    this.kind = kind;
    this.step = step;
    this.refusal = refusal;
  }
}

export interface GuestTx {
  step: GuestStep;
  method: string;
  hash: string;
  ok: boolean;
}

export interface GuestOrder {
  series: number;
  round: number;
  side: Side;
  size: number;
  /** LONG price above the series' floor, micro-USD per GPU-hour (SPEC section 6.3). */
  price: number;
  /** micro-USDC. */
  lock: string;
  salt: string;
  hash: string;
  floor: number;
  band: number;
  /** The commits' seqs once known; null while the commit's outcome is not known. */
  seqs: number[] | null;
}

export interface GuestResult {
  accountId: string;
  series: number;
  round: number;
  order: GuestOrder;
  /** LONG clearing price above the floor, or null when the round did not trade. */
  clearingPrice: number | null;
  /** floor + clearing price: micro-USD per GPU-hour. */
  clearingPriceAbs: number | null;
  /** GPU-hours filled of this account's order(s). */
  filled: number;
  /** What happened to the order: filled, not filled, or evicted. */
  outcome: string;
  position: { long: number; short: number };
  /** Free balance in Weir after clearing, micro-USDC. */
  balance: string;
  seconds: number;
  txs: GuestTx[];
}

export interface GuestSettlement {
  settled: boolean;
  /** The contract's text when settling was refused. */
  reason: string | null;
  redeemed: boolean;
  balance: string;
  txs: GuestTx[];
}

export interface GuestState {
  version: 1;
  contractId: string;
  accountId: string;
  /** `ed25519:<base58>`. Never printed. For an account set up elsewhere (`Guest.forAccount`)
   * it may be a function-call key limited to AGENT_KEY_METHODS. */
  secretKey: string;
  /** True when the account was set up by someone else (a wallet): the guest never creates,
   * registers or funds it, and only trades with the key it was given. */
  external: boolean;
  startedAt: number;
  order: GuestOrder | null;
  result: GuestResult | null;
  txs: GuestTx[];
}

/** What the chain says now, and the order the guest would place. Views only. */
export interface GuestPlan {
  /** Chain time, Unix seconds. */
  now: number;
  /** `ready`: a commit phase is open with enough time left. `wait`: until `waitUntil`.
   * `closed`: no series is in its auction window. `stale`: the series cannot open. */
  status: "ready" | "wait" | "closed" | "stale";
  reason: string;
  series: number | null;
  round: number | null;
  phase: string | null;
  phaseEndsAt: number | null;
  waitUntil: number | null;
  seriesOpen: boolean;
  floor: number | null;
  band: number | null;
  tick: number;
  lastPrint: WireLastPrint | null;
  lastClearing: { round: number; price: number } | null;
  order: { side: Side; size: number; price: number; lock: string; fee: string; maxNeed: string } | null;
}

const DEFAULTS = {
  accountPrefix: "weir-try-",
  accountSuffix: ".testnet",
  size: 5,
  markupBps: 1500,
  minCommitLeftSecs: 30,
  keeperGraceSecs: 20,
  pollMs: 5_000,
  minGapMs: 1_000,
  timeLimitMs: 15 * 60_000,
};

const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const big = (v: string | number | bigint): bigint => BigInt(v);
const maxBig = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const ONE_USD = 1_000_000n;

/** Views go to dRPC first (fastnear's free tier rate-limits per address), sends to fastnear
 * first (dRPC's free tier times out a send that waits for finality): chain/README.md. */
export function rpcOrder(urls: readonly string[], use: "view" | "send"): string[] {
  const rank = (u: string) => (/drpc\.org/.test(u) ? 0 : /fastnear/.test(u) ? 1 : 2);
  const sorted = [...urls].sort((a, b) => rank(a) - rank(b));
  return use === "view" ? sorted : [...sorted.filter((u) => /fastnear/.test(u)), ...sorted.filter((u) => !/fastnear/.test(u))];
}

/** Every request through `fetch` at least `gapMs` after the previous one began. */
export function spacedFetch(fetch: FetchLike, gapMs: number, now: () => number, sleep: (ms: number) => Promise<void>): FetchLike {
  if (gapMs <= 0) return fetch;
  let next = 0;
  let queue: Promise<void> = Promise.resolve();
  return (url, init) => {
    const turn = queue.then(async () => {
      const t = now();
      if (t < next) await sleep(next - t);
      next = now() + gapMs;
    });
    queue = turn.catch(() => undefined);
    return turn.then(() => fetch(url, init));
  };
}

/** A read-only port to `contractId` through spaced requests, for `readPlan`. */
export function viewPort(config: GuestConfig, deps: Pick<GuestDeps, "fetch" | "now" | "sleep">): ChainWeir {
  const fetch = spacedFetch(deps.fetch, config.minGapMs ?? DEFAULTS.minGapMs, deps.now, deps.sleep);
  const rpc = new NearRpc({ urls: rpcOrder(config.rpcUrls, "view"), fetch, now: deps.now, sleep: deps.sleep });
  return new ChainWeir({ rpc, contractId: config.contractId, usdcId: config.usdcId });
}

/** The floor and band a series gets when it opens on `anchor` (SPEC section 6.1). */
export function openingBand(p: Pick<WireParams, "tick" | "band_bps">, anchor: number): { floor: number; band: number } {
  const mid = anchor - (anchor % p.tick);
  const raw = Math.floor((anchor * p.band_bps) / 10_000);
  const half = raw - (raw % p.tick);
  return { floor: mid - half, band: 2 * half };
}

/** The suggested order: LONG `size` at the last clearing price (else the reference price
 * `clamp(last print - floor, 0, band)`, else mid-band) plus `markupBps` of the band, at most
 * `band - tick`, rounded down to the tick. Its lock is what it can cost, at least `min_lock`. */
export function suggestOrder(
  p: Pick<WireParams, "tick" | "min_lock" | "commit_fee">,
  band: number,
  base: number | null,
  size: number,
  markupBps: number,
): { side: Side; size: number; price: number; lock: string; fee: string; maxNeed: string } {
  const start = base ?? Math.floor(band / 2);
  let price = Math.min(start + Math.floor((band * markupBps) / 10_000), band - p.tick);
  price -= price % p.tick;
  price = Math.max(price, p.tick);
  const lock = maxBig(big(size) * big(price), big(p.min_lock));
  const fee = big(p.commit_fee);
  const maxNeed = maxBig(big(size) * big(band), big(p.min_lock)) + fee;
  return { side: "Long", size, price, lock: lock.toString(), fee: fee.toString(), maxNeed: maxNeed.toString() };
}

/** One function call of a setup transaction, as a wallet signs it. */
export interface SetupCall {
  methodName: string;
  args: Record<string, unknown>;
  gas: bigint;
  deposit: bigint;
}

/** One setup transaction: calls to one receiver, signed together. */
export interface SetupTx {
  receiverId: string;
  calls: SetupCall[];
}

/** The setup an account needs before it can trade, as data a wallet can sign, in order:
 * 1. to Weir: `register {}` with 0.02 NEAR (left out when `register` is false);
 * 2. to the token: `storage_deposit {account_id, registration_only: true}` with 0.00125 NEAR,
 *    `mint {account_id, amount}` (the test dollar's open mint; left out when `mint` is "0"),
 *    and `ft_transfer_call {receiver_id: Weir, amount, msg: ""}` with 1 yoctoNEAR.
 * The second must be sent after the first has landed: a deposit to an account Weir does not
 * know yet is sent back (SPEC section 5; `depositRefunded` detects it). */
export function setupTransactions(o: { contractId: string; usdcId: string; accountId: string; deposit: string; mint?: string; register?: boolean }): SetupTx[] {
  const txs: SetupTx[] = [];
  if (o.register !== false) {
    txs.push({ receiverId: o.contractId, calls: [{ methodName: "register", args: {}, gas: CALLS.register.gas, deposit: CALLS.register.deposit }] });
  }
  const mint = o.mint ?? o.deposit;
  const token: SetupCall[] = [
    { methodName: "storage_deposit", args: { account_id: o.accountId, registration_only: true }, ...TOKEN_CALLS.storage_deposit },
  ];
  if (big(mint) > 0n) token.push({ methodName: "mint", args: { account_id: o.accountId, amount: mint }, ...TOKEN_CALLS.mint });
  token.push({ methodName: "ft_transfer_call", args: { receiver_id: o.contractId, amount: o.deposit, msg: "" }, ...TOKEN_CALLS.ft_transfer_call });
  txs.push({ receiverId: o.usdcId, calls: token });
  return txs;
}

/** True when the token transaction's result (what `ft_transfer_call` says Weir kept) is less
 * than `amount`: Weir sent the deposit back, as it does when the account is not registered
 * yet (SPEC section 5). The dollars are back in the token account; deposit again once the
 * registration has landed. */
export function depositRefunded(result: unknown, amount: string): boolean {
  const kept = typeof result === "string" && /^\d+$/.test(result) ? BigInt(result) : 0n;
  return kept < big(amount);
}

/** What a function-call key needs left in allowance to send `clear` (150 Tgas): attached gas
 * is bought at 1e9 yocto/gas, plus 5 Tgas of fees, so 0.155 NEAR (deploy/README.md, "NEAR,
 * gas and allowances"). The unburnt part comes back. */
export const CLEAR_ALLOWANCE = 155_000_000_000_000_000_000_000n;

/** A send refused because the function-call key's allowance is too low. */
export const isAllowanceError = (e: unknown): boolean => /NotEnoughAllowance/.test(errText(e));

/** Reads the chain and says what the guest would do now. Views only: nothing is signed. */
export async function readPlan(
  weir: WeirPort,
  opts: { size?: number; markupBps?: number; minCommitLeftSecs?: number } = {},
  params?: WireParams,
): Promise<GuestPlan & { params: WireParams }> {
  const size = opts.size ?? DEFAULTS.size;
  const markup = opts.markupBps ?? DEFAULTS.markupBps;
  const minLeft = opts.minCommitLeftSecs ?? DEFAULTS.minCommitLeftSecs;
  const p = params ?? (await weir.get_params({}));
  const status = await weir.get_status({});
  const now = status.now;
  const empty = {
    now,
    params: p,
    series: null,
    round: null,
    phase: null,
    phaseEndsAt: null,
    waitUntil: null,
    seriesOpen: false,
    floor: null,
    band: null,
    tick: p.tick,
    lastPrint: null,
    lastClearing: null,
    order: null,
  };
  if (status.live.length === 0) {
    return { ...empty, status: "closed", reason: "no series is in its auction window now" };
  }
  const target = status.live.find((l) => l.phase === "Commit" && l.round !== null && (l.phase_ends_at ?? 0) - now >= minLeft);
  if (!target) {
    const ends = status.live.map((l) => l.phase_ends_at ?? l.auction_close).filter((t) => t > now);
    const waitUntil = ends.length ? Math.min(...ends) : now + Math.ceil(minLeft);
    const first = status.live[0]!;
    const left = first.phase === "Commit" ? `only ${(first.phase_ends_at ?? now) - now} s of the commit phase are left` : `series ${first.series} is in its ${first.phase.toLowerCase()} phase`;
    return {
      ...empty,
      status: "wait",
      reason: `${left}; the next commit phase starts in ${waitUntil - now} s`,
      series: first.series,
      round: first.round,
      phase: first.phase,
      phaseEndsAt: first.phase_ends_at,
      waitUntil,
    };
  }
  const lastPrint = await weir.get_last_print({});
  const series = await weir.get_series({ series: target.series });
  const at = { ...empty, series: target.series, round: target.round, phase: target.phase, phaseEndsAt: target.phase_ends_at, lastPrint };
  let floor: number;
  let band: number;
  let lastClearing: { round: number; price: number } | null = null;
  if (series) {
    ({ floor, band } = series);
    const results = await weir.get_results({ series: target.series, from_round: 0, limit: 100 });
    for (const [round, r] of results) if (r.price !== null) lastClearing = { round, price: r.price };
  } else {
    if (!lastPrint || now - lastPrint.bucket > p.max_anchor_age_secs) {
      const age = lastPrint ? `the last index print is ${now - lastPrint.bucket} s old` : "there is no index print";
      return { ...at, status: "stale", reason: `the index is stale: ${age}, more than max_anchor_age_secs ${p.max_anchor_age_secs} s, so series ${target.series} cannot open until the reporters print again` };
    }
    ({ floor, band } = openingBand(p, lastPrint.price));
  }
  const ref = lastPrint ? Math.min(Math.max(lastPrint.price - floor, 0), band) : null;
  const order = suggestOrder(p, band, lastClearing?.price ?? ref, size, markup);
  const left = (target.phase_ends_at ?? now) - now;
  return {
    ...at,
    status: "ready",
    reason: `series ${target.series}, round ${target.round}: ${left} s of the commit phase left`,
    seriesOpen: series !== null,
    floor,
    band,
    lastClearing,
    order,
  };
}

/** One guest: its state in storage, its account on chain. */
export class Guest {
  readonly config: GuestConfig;
  readonly #deps: GuestDeps;
  readonly #key: string;
  readonly #c: typeof DEFAULTS;
  #deadlineAt: number | null = null;
  #state: GuestState | null;
  #params: WireParams | null = null;
  #engineParams: Params | null = null;
  readonly #views: ChainWeir;
  readonly #viewRpc: NearRpc;
  readonly #sendRpc: NearRpc;
  #port: ChainWeir | null = null;
  #signer: NearAccount | null = null;
  #token: Token | null = null;
  #step: GuestStep = "plan";

  private constructor(config: GuestConfig, deps: GuestDeps, state: GuestState | null) {
    this.config = config;
    this.#deps = deps;
    this.#key = config.storageKey ?? `weir-guest:${config.contractId}`;
    this.#c = { ...DEFAULTS, ...Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined)) } as typeof DEFAULTS;
    this.#state = state;
    const fetch = spacedFetch(deps.fetch, this.#c.minGapMs, deps.now, deps.sleep);
    const health = new EndpointHealth();
    const common = { fetch, now: deps.now, sleep: deps.sleep, health };
    this.#viewRpc = new NearRpc({ urls: rpcOrder(config.rpcUrls, "view"), ...common });
    this.#sendRpc = new NearRpc({ urls: rpcOrder(config.rpcUrls, "send"), ...common });
    this.#views = new ChainWeir({ rpc: this.#viewRpc, contractId: config.contractId, usdcId: config.usdcId });
  }

  /** The guest stored under this contract's key, or a new one. Creates nothing. */
  static async load(config: GuestConfig, deps: GuestDeps): Promise<Guest> {
    const key = config.storageKey ?? `weir-guest:${config.contractId}`;
    const raw = await deps.storage.get(key);
    const state = raw ? (JSON.parse(raw) as GuestState) : null;
    if (state && state.contractId !== config.contractId) throw new Error(`the stored guest is for ${state.contractId}, not ${config.contractId}`);
    return new Guest(config, deps, state);
  }

  /** A guest trading for an account that is already set up (created, registered with Weir,
   * funded): a wallet signed `setupTransactions`. `secretKey` may be a function-call key for
   * Weir limited to AGENT_KEY_METHODS: trading attaches no deposit and calls no token. */
  static async forAccount(config: GuestConfig, deps: GuestDeps, account: { accountId: string; secretKey: string }): Promise<Guest> {
    const guest = await Guest.load(config, deps);
    const st = guest.#state;
    if (st && st.accountId !== account.accountId) throw new Error(`storage already holds a guest for ${st.accountId}`);
    if (!st) {
      await KeyPair.fromString(account.secretKey);
      guest.#state = { version: 1, contractId: config.contractId, accountId: account.accountId, secretKey: account.secretKey, external: true, startedAt: deps.now(), order: null, result: null, txs: [] };
      await guest.#save();
    }
    return guest;
  }

  get accountId(): string | null {
    return this.#state?.accountId ?? null;
  }

  /** A copy of what is stored, without the secret key. */
  get state(): Omit<GuestState, "secretKey"> | null {
    if (!this.#state) return null;
    const { secretKey: _, ...rest } = this.#state;
    return JSON.parse(JSON.stringify(rest)) as Omit<GuestState, "secretKey">;
  }

  /** What the chain says now and the order the guest would place. Views only. */
  plan(): Promise<GuestPlan & { params: WireParams }> {
    return readPlan(this.#views, this.#c, this.#params ?? undefined);
  }

  /** The whole path to a cleared round: `setup()` then `trade()`. Resumes where storage and
   * the chain say it stopped. */
  async run(): Promise<GuestResult> {
    if (!this.#state?.result && !this.#state?.external) await this.setup();
    return await this.trade();
  }

  /** The setup phase, for a throwaway account: a key, the account from the faucet, Weir
   * registration, and test dollars in Weir (enough for the largest order the plan allows).
   * Each part is read from the chain first and skipped when done. An account set up
   * elsewhere (`forAccount`) skips this phase. */
  async setup(): Promise<void> {
    if (this.#state?.external) throw new Error("this account was set up elsewhere; the guest does not set it up");
    const deadline = this.#deadline();
    await this.#loadParams();
    let plan: GuestPlan | null = null;
    if (!this.#state) {
      // Read the market before creating anything: a closed market or a stale index stops here.
      this.#step = "plan";
      plan = await this.plan();
      this.#stopIfNotTradable(plan);
      this.#emit({ type: "done", step: "plan", message: plan.reason });
    }
    await this.#makeKey();
    await this.#createAccount(deadline);
    await this.#ports();
    if (this.#state!.order) return;
    plan ??= await this.plan();
    // While no commit phase is open the order is not known: register now, fund before the commit.
    await this.#setupWeir(plan.order ? big(plan.order.maxNeed) : 0n);
  }

  /** The trading phase: commit, reveal, clear if nobody has, read the fill. Needs only the
   * account id and a key that may call commit, reveal and clear: no deposit is attached and
   * the token is never called (except to top up a throwaway account, which `setup` owns). */
  async trade(): Promise<GuestResult> {
    if (!this.#state) throw new Error("no account yet: call setup() or forAccount() first");
    if (this.#state.result) {
      this.#emit({ type: "done", step: "result", message: "this guest's round was already cleared; nothing to do" });
      return this.#state.result;
    }
    const deadline = this.#deadline();
    await this.#loadParams();
    await this.#ports();
    if (this.#state.order && this.#state.order.seqs === null) await this.#resumeCommit();
    if (!this.#state.order) await this.#commitLoop(deadline);
    await this.#reveal();
    const result = await this.#clear();
    return await this.#result(result);
  }

  /** After the delivery hour: settles the series if nobody has, then redeems this account's
   * position. A refusal to settle (too early, prints missing) is returned, not thrown. */
  async settle(): Promise<GuestSettlement> {
    const st = this.#state;
    const order = st?.result?.order ?? st?.order;
    if (!st || !order) throw new Error("this guest has no order to settle");
    await this.#ports();
    const txs: GuestTx[] = [];
    const before = st.txs.length;
    const series = order.series;
    let reason: string | null = null;
    this.#step = "settle";
    const s = await this.#views.get_series({ series });
    if (s?.settlement) {
      this.#emit({ type: "step", step: "settle", message: `series ${series} is already settled` });
    } else {
      this.#emit({ type: "step", step: "settle", message: `settling series ${series}` });
      try {
        await this.#port!.settle({ series });
      } catch (e) {
        if (!(e instanceof CallFailed)) throw this.#plain(e);
        this.#refused("settle", e);
        if (e.message !== ERR.SETTLED) reason = e.message;
      }
    }
    let redeemed = false;
    if (reason === null) {
      this.#step = "redeem";
      const pos = await this.#views.get_position({ series, account_id: st.accountId });
      if (pos.long + pos.short > 0) {
        try {
          await this.#port!.redeem({ series, account_id: st.accountId });
          redeemed = true;
        } catch (e) {
          if (!(e instanceof CallFailed)) throw this.#plain(e);
          this.#refused("redeem", e);
          if (e.message !== ERR.NO_POSITION) reason = e.message;
        }
      } else {
        this.#emit({ type: "step", step: "redeem", message: "no position to redeem" });
      }
    }
    const account = await this.#views.get_account({ account_id: st.accountId });
    txs.push(...st.txs.slice(before));
    return { settled: reason === null, reason, redeemed, balance: account?.balance ?? "0", txs };
  }

  // Steps

  /** No commit is started after this: `timeLimitMs` from this instance's first step. */
  #deadline(): number {
    return (this.#deadlineAt ??= this.#deps.now() + this.#c.timeLimitMs);
  }

  async #loadParams(): Promise<void> {
    this.#params ??= await this.#views.get_params({});
    this.#engineParams ??= paramsFromWire(this.#params);
  }

  async #makeKey(): Promise<void> {
    this.#step = "key";
    if (this.#state) {
      this.#emit({ type: "step", step: "key", message: `resuming ${this.#state.accountId}` });
      return;
    }
    const secretKey = secretKeyFromSeed(this.#deps.randomBytes(32));
    const accountId = `${this.#c.accountPrefix}${hex(this.#deps.randomBytes(6))}${this.#c.accountSuffix}`;
    this.#state = { version: 1, contractId: this.config.contractId, accountId, secretKey, external: false, startedAt: this.#deps.now(), order: null, result: null, txs: [] };
    await this.#save();
    this.#emit({ type: "done", step: "key", message: `new key for ${accountId}` });
  }

  async #createAccount(deadline: number): Promise<void> {
    this.#step = "account";
    const st = this.#state!;
    const key = await KeyPair.fromString(st.secretKey);
    if (await accountExists(this.#viewRpc, st.accountId)) {
      this.#emit({ type: "step", step: "account", message: `${st.accountId} exists` });
      return;
    }
    this.#emit({ type: "step", step: "account", message: `asking the testnet faucet to create ${st.accountId}` });
    try {
      const r = await createWithFaucet(this.#viewRpc, st.accountId, key.publicKeyString, {
        fetch: this.#deps.faucetFetch ?? this.#deps.fetch,
        now: this.#deps.now,
        sleep: this.#deps.sleep,
        url: this.config.faucetUrl ?? FAUCET_URL,
        maxWaitMs: Math.max(0, Math.min(10 * 60_000, deadline - this.#deps.now())),
        pollMs: this.#c.pollMs,
        onRetry: (reason, ms, attempt) =>
          this.#emit({ type: "wait", step: "account", seconds: Math.round(ms / 1000), message: `faucet: ${reason}; attempt ${attempt} in ${Math.round(ms / 1000)} s` }),
      });
      if (r.hash) await this.#recordTx("account", "create_account", "testnet", r.hash, true);
      this.#emit({ type: "done", step: "account", message: r.existed ? `${st.accountId} exists` : `${st.accountId} created by the faucet` });
    } catch (e) {
      if (e instanceof FaucetError) throw new GuestError(e.retryable ? "timeout" : "faucet", "account", e.message);
      throw e;
    }
  }

  /** Registers with Weir and makes the free balance at least `need` micro-USDC, with the
   * transactions of `setupTransactions`: `register` to Weir, then one token transaction with
   * storage_deposit, mint and ft_transfer_call. Reads the registration and both balances first,
   * so a restart neither registers nor deposits twice. */
  async #setupWeir(need: bigint): Promise<void> {
    const me = this.#state!.accountId;
    const token = this.#token!;
    this.#step = "register";
    const account = await this.#views.get_account({ account_id: me });
    if (account) this.#emit({ type: "step", step: "register", message: `${me} is registered with ${this.config.contractId}` });
    const free = big(account?.balance ?? "0");
    let deposit = 0n;
    let mint = 0n;
    if (free < need) {
      // Whole dollars, so the amounts read plainly.
      deposit = ((need - free + ONE_USD - 1n) / ONE_USD) * ONE_USD;
      const held = big((await token.balanceOf(me)) ?? "0");
      if (held < deposit) mint = deposit - held;
    } else if (need > 0n) {
      this.#emit({ type: "step", step: "fund", message: `free balance ${usd(free)} covers ${usd(need)}` });
    }
    const txs = setupTransactions({ contractId: this.config.contractId, usdcId: token.tokenId, accountId: me, deposit: deposit.toString(), mint: mint.toString(), register: !account });
    for (const tx of txs) {
      const isToken = tx.receiverId === token.tokenId;
      if (isToken && deposit === 0n) continue;
      const step: GuestStep = isToken ? "fund" : "register";
      this.#step = step;
      this.#emit({
        type: "step",
        step,
        message: isToken
          ? `${mint > 0n ? `minting ${usd(mint)} of the test dollar ${token.tokenId} and ` : ""}depositing ${usd(deposit)} into ${this.config.contractId}`
          : `registering with ${this.config.contractId} (0.02 NEAR)`,
      });
      const o = await this.#signer!.functionCalls(tx.receiverId, tx.calls);
      await this.#outcome(step, tx.calls.map((c) => c.methodName).join("+"), tx.receiverId, o);
      if (isToken && depositRefunded(o.result, deposit.toString())) {
        throw new GuestError(
          "refused",
          "fund",
          `${this.config.contractId} sent the deposit of ${usd(deposit)} back: ${me} was not registered with it when the deposit arrived. The dollars are in the token account; run again to deposit again.`,
        );
      }
      this.#emit({ type: "done", step, message: isToken ? `deposited ${usd(deposit)}` : "registered" });
    }
  }

  /** Before a commit: the free balance must cover `need`. A throwaway account is topped up;
   * an account set up elsewhere stops with a plain reason, since the guest holds no key that
   * may call the token. */
  async #ensureFunds(need: bigint): Promise<void> {
    const me = this.#state!.accountId;
    const account = await this.#views.get_account({ account_id: me });
    const free = big(account?.balance ?? "0");
    if (account && free >= need) return;
    if (this.#state!.external) {
      throw new GuestError(
        "unfunded",
        "fund",
        account
          ? `the free balance of ${me} in ${this.config.contractId} is ${usd(free)}, below the ${usd(need)} this order may need; deposit more and run again`
          : `${me} is not registered with ${this.config.contractId}; finish the setup transactions first`,
      );
    }
    await this.#setupWeir(need);
  }

  #stopIfNotTradable(plan: GuestPlan): void {
    if (plan.status === "closed") throw new GuestError("closed", "plan", `nothing to bid on: ${plan.reason}`);
    if (plan.status === "stale") throw new GuestError("stale", "plan", `nothing to bid on: ${plan.reason}`);
  }

  async #commitLoop(deadline: number): Promise<void> {
    for (;;) {
      this.#step = "plan";
      const plan = await this.plan();
      this.#stopIfNotTradable(plan);
      if (plan.status === "wait") {
        const secs = plan.waitUntil! - plan.now;
        if (this.#deps.now() + secs * 1000 > deadline) {
          throw new GuestError("timeout", "plan", `gave up after the time limit of ${Math.round(this.#c.timeLimitMs / 60_000)} min: ${plan.reason}; no commit was made`);
        }
        this.#emit({ type: "wait", step: "plan", seconds: secs + 2, message: plan.reason });
        await this.#deps.sleep((secs + 2) * 1000);
        continue;
      }
      if (this.#deps.now() > deadline) {
        throw new GuestError("timeout", "plan", `gave up after the time limit of ${Math.round(this.#c.timeLimitMs / 60_000)} min; no commit was made`);
      }
      const o = plan.order!;
      await this.#ensureFunds(big(o.maxNeed));
      // Funding takes a few transactions: check the phase again before committing.
      const status = await this.#views.get_status({});
      const live = status.live.find((l) => l.series === plan.series);
      if (!live || live.phase !== "Commit" || live.round !== plan.round || (live.phase_ends_at ?? 0) - status.now < this.#c.minCommitLeftSecs) continue;
      if (await this.#commit(plan)) return;
    }
  }

  /** Commits the plan's order. True when committed; false when the phase had ended and the
   * caller should plan again. The order and its salt are stored before the call is sent. */
  async #commit(plan: GuestPlan): Promise<boolean> {
    this.#step = "commit";
    const st = this.#state!;
    const o = plan.order!;
    const series = plan.series!;
    const round = plan.round!;
    const salt = hex(this.#deps.randomBytes(16));
    const fields = { series, round, accountId: st.accountId, side: o.side, size: o.size, price: o.price, salt };
    const hash = commitHash(fields);
    const theirs = await this.#views.commit_hash({ series, round, account_id: st.accountId, side: o.side, size: o.size, price: o.price, salt });
    if (theirs !== hash) {
      throw new GuestError("unknown", "commit", `the contract's commit_hash (${theirs}) differs from the local hash (${hash}); nothing was committed`);
    }
    st.order = { series, round, side: o.side, size: o.size, price: o.price, lock: o.lock, salt, hash, floor: plan.floor!, band: plan.band!, seqs: null };
    await this.#save();
    this.#emit({
      type: "step",
      step: "commit",
      message: `committing series ${series} round ${round}: LONG ${o.size} GPU-hours at most ${price(plan.floor! + o.price)} per GPU-hour, lock ${usd(big(o.lock))}, fee ${usd(big(o.fee))}`,
    });
    let seq: number;
    try {
      seq = await this.#port!.commit({ series, hash, lock: o.lock });
    } catch (e) {
      if (isAllowanceError(e)) {
        // Refused before it was sent on: nothing landed.
        st.order = null;
        await this.#save();
        throw this.#plain(e);
      }
      if (e instanceof CallFailed) {
        // A refused transaction changed nothing: the order is dropped.
        this.#refused("commit", e);
        st.order = null;
        await this.#save();
        if (e.message === ERR.NOT_COMMIT_PHASE) return false;
        throw new GuestError("refused", "commit", `the contract refused the commit: ${e.message}`, e.message);
      }
      // The outcome is not known: it may have landed. Look for it by hash.
      this.#emit({ type: "step", step: "commit", message: `the commit's outcome is not known (${errText(e)}); looking for it in the round` });
      await this.#resumeCommit();
      return this.#state!.order !== null;
    }
    st.order.seqs = [seq];
    await this.#save();
    this.#emit({ type: "done", step: "commit", message: `committed as seq ${seq}; the order stays sealed until the reveal phase` });
    return true;
  }

  /** A stored order whose commit outcome is not known: find this account's commits with its
   * hash in the round. Found, they are the order's; not found after three reads `pollMs`
   * apart, the commit did not land and the order is dropped, to be planned again. */
  async #resumeCommit(): Promise<void> {
    this.#step = "commit";
    const st = this.#state!;
    const o = st.order!;
    for (let i = 0; i < 3; i++) {
      if (i > 0) await this.#deps.sleep(this.#c.pollMs);
      const r = await this.#views.get_round({ series: o.series, round: o.round });
      const mine = (r?.commits ?? []).filter((c) => c.owner === st.accountId && c.hash === o.hash).map((c) => c.seq);
      if (mine.length > 0) {
        o.seqs = mine;
        await this.#save();
        this.#emit({ type: "done", step: "commit", message: `found the commit in round ${o.round} as seq ${mine.join(", ")}; not committing again` });
        return;
      }
      if (r === null && (await this.#views.get_result({ series: o.series, round: o.round }))) break;
    }
    this.#emit({ type: "step", step: "commit", message: `no commit with this order's hash is in series ${o.series} round ${o.round}: it did not land; planning again` });
    st.order = null;
    await this.#save();
  }

  async #reveal(): Promise<void> {
    this.#step = "reveal";
    const st = this.#state!;
    const o = st.order!;
    const p = this.#engineParams!;
    const opens = roundStart(p, o.series, o.round) + p.commitSecs;
    const closes = roundEnd(p, o.series, o.round);
    let now = await this.#waitChain("reveal", opens, `the reveal phase of round ${o.round} opens`);
    for (const seq of o.seqs ?? []) {
      for (let attempt = 0; ; attempt++) {
        const r = await this.#views.get_round({ series: o.series, round: o.round });
        if (r === null) {
          this.#emit({ type: "step", step: "reveal", message: `round ${o.round} is no longer open for reveals (already cleared)` });
          return;
        }
        const c = r.commits.find((x) => x.seq === seq);
        if (!c) {
          this.#emit({ type: "step", step: "reveal", message: `seq ${seq} is not in the round: a larger lock evicted it and its lock and fee were returned` });
          break;
        }
        if (c.order !== null) {
          this.#emit({ type: "step", step: "reveal", message: `seq ${seq} is already revealed` });
          break;
        }
        if (now >= closes) {
          throw new GuestError("refused", "reveal", `the reveal phase of round ${o.round} ended before seq ${seq} was revealed: 1% of its lock is forfeited at clearing`);
        }
        this.#emit({ type: "step", step: "reveal", message: `revealing seq ${seq}: LONG ${o.size} at ${price(o.floor + o.price)}` });
        try {
          await this.#port!.reveal({ series: o.series, round: o.round, seq, side: o.side, size: o.size, price: o.price, salt: o.salt });
          this.#emit({ type: "done", step: "reveal", message: `revealed seq ${seq}` });
          break;
        } catch (e) {
          if (!(e instanceof CallFailed)) throw this.#plain(e);
          this.#refused("reveal", e);
          if (e.message === ERR.ALREADY_REVEALED) break;
          if (e.message === ERR.NOT_REVEAL_PHASE && attempt === 0) {
            now = await this.#waitChain("reveal", opens + 1, "the reveal phase opens (the chain's clock is behind)");
            continue;
          }
          throw new GuestError("refused", "reveal", `the contract refused the reveal: ${e.message}`, e.message);
        }
      }
    }
  }

  /** Waits for the round to end and for the keeper to clear it; clears it if nobody has. */
  async #clear(): Promise<WireResult> {
    this.#step = "clear";
    const o = this.#state!.order!;
    const p = this.#engineParams!;
    await this.#waitChain("clear", roundEnd(p, o.series, o.round), `round ${o.round} ends`);
    const args = { series: o.series, round: o.round };
    let res = await this.#views.get_result(args);
    for (let waited = 0; !res && waited < this.#c.keeperGraceSecs * 1000; waited += this.#c.pollMs) {
      this.#emit({ type: "wait", step: "clear", seconds: Math.round(this.#c.pollMs / 1000), message: "waiting for the keeper to clear the round" });
      await this.#deps.sleep(this.#c.pollMs);
      res = await this.#views.get_result(args);
    }
    if (!res && !(await this.#allowanceCovers(CLEAR_ALLOWANCE))) {
      // This key cannot pay for a clear: give the keeper (or anyone) two more minutes.
      for (let waited = 0; !res && waited < 120_000; waited += this.#c.pollMs) {
        this.#emit({ type: "wait", step: "clear", seconds: Math.round(this.#c.pollMs / 1000), message: "this key's gas allowance is too low to clear; waiting for the keeper" });
        await this.#deps.sleep(this.#c.pollMs);
        res = await this.#views.get_result(args);
      }
      if (!res) {
        throw new GuestError(
          "allowance",
          "clear",
          `round ${o.round} is over but nobody has cleared it, and this key's gas allowance is below the 0.155 NEAR a clear needs (150 Tgas). Anyone may clear it; the order is revealed and loses nothing by waiting. Run again later to read the fill.`,
        );
      }
    }
    if (res) {
      this.#emit({ type: "step", step: "clear", message: `round ${o.round} was cleared by someone else` });
      return res;
    }
    for (let attempt = 0; ; attempt++) {
      this.#emit({ type: "step", step: "clear", message: `nobody cleared round ${o.round}; clearing it` });
      try {
        await this.#port!.clear(args);
        this.#emit({ type: "done", step: "clear", message: `cleared round ${o.round}` });
        break;
      } catch (e) {
        if (!(e instanceof CallFailed)) throw this.#plain(e);
        this.#refused("clear", e);
        if (e.message === ERR.CLEARED) break;
        if (e.message === ERR.ROUND_NOT_OVER && attempt === 0) {
          await this.#deps.sleep(this.#c.pollMs);
          continue;
        }
        throw new GuestError("refused", "clear", `the contract refused to clear: ${e.message}`, e.message);
      }
    }
    const after = await this.#views.get_result(args);
    if (!after) throw new GuestError("unknown", "clear", `round ${o.round} has no result after clearing`);
    return after;
  }

  async #result(res: WireResult): Promise<GuestResult> {
    this.#step = "result";
    const st = this.#state!;
    const o = st.order!;
    const fills = res.fills.filter((f) => f.owner === st.accountId);
    const filled = fills.reduce((n, f) => n + f.filled, 0);
    const position = await this.#views.get_position({ series: o.series, account_id: st.accountId });
    const account = await this.#views.get_account({ account_id: st.accountId });
    const outcome =
      (o.seqs ?? []).length === 0
        ? "no commit"
        : filled === 0
          ? res.price === null
            ? "the round did not trade; the lock is back in the free balance"
            : "not filled: the clearing price was above this order's limit; the lock is back in the free balance"
          : filled === o.size * (o.seqs ?? []).length
            ? "filled in full"
            : "filled in part";
    const result: GuestResult = {
      accountId: st.accountId,
      series: o.series,
      round: o.round,
      order: o,
      clearingPrice: res.price,
      clearingPriceAbs: res.price === null ? null : o.floor + res.price,
      filled,
      outcome,
      position: { long: position.long, short: position.short },
      balance: account?.balance ?? "0",
      seconds: Math.round((this.#deps.now() - st.startedAt) / 1000),
      txs: [...st.txs],
    };
    st.result = result;
    await this.#save();
    this.#emit({
      type: "done",
      step: "result",
      message: `clearing price ${res.price === null ? "none (no trade)" : price(o.floor + res.price)}; filled ${filled} of ${o.size}: ${outcome}`,
    });
    return result;
  }

  // Plumbing

  async #ports(): Promise<void> {
    if (this.#port) return;
    const st = this.#state!;
    this.#params ??= await this.#views.get_params({});
    const usdc = this.config.usdcId ?? this.#params.usdc;
    this.#signer = new NearAccount(this.#sendRpc, st.accountId, await KeyPair.fromString(st.secretKey));
    this.#token = new Token(this.#viewRpc, usdc);
    this.#port = new ChainWeir({
      rpc: this.#viewRpc,
      account: this.#signer,
      contractId: this.config.contractId,
      usdcId: usdc,
      onOutcome: (method, outcome) => {
        const receiver = method === "deposit" ? usdc : this.config.contractId;
        void this.#recordTx(this.#step, method === "deposit" ? "ft_transfer_call" : method, receiver, outcome.tx_hash, outcome.ok);
      },
    });
  }

  /** A token call's outcome: recorded, and a failure reported with its text. */
  async #outcome(step: GuestStep, method: string, receiver: string, o: TxOutcome): Promise<void> {
    await this.#recordTx(step, method, receiver, o.tx_hash, o.ok);
    if (!o.ok) {
      const text = panicMessage(o.error ?? "call failed");
      this.#emit({ type: "refused", step, method, text, hash: o.tx_hash, url: txUrl(o.tx_hash) });
      throw new GuestError("refused", step, `${receiver} refused ${method}: ${text}`, text);
    }
  }

  /** Whether the signing key may spend `need` yoctoNEAR on gas: always for a full-access key
   * or an unlimited allowance. */
  async #allowanceCovers(need: bigint): Promise<boolean> {
    const ak = await this.#sendRpc.viewAccessKey(this.#state!.accountId, this.#signer!.key.publicKeyString);
    if (ak.permission === "FullAccess") return true;
    const left = ak.permission.FunctionCall.allowance;
    return left === null || BigInt(left) >= need;
  }

  /** An allowance refusal in plain words; any other error unchanged. */
  #plain(e: unknown): unknown {
    if (!isAllowanceError(e)) return e;
    return new GuestError(
      "allowance",
      this.#step,
      `the network refused the ${this.#step} transaction: this function-call key has too little gas allowance left (NotEnoughAllowance). Nothing was sent on. Add a key with more allowance, or let the keeper clear.`,
    );
  }

  #refused(method: string, e: CallFailed): void {
    const hash = e.outcome.tx_hash || null;
    this.#emit({ type: "refused", step: this.#step, method, text: e.message, hash, url: hash ? txUrl(hash) : null });
  }

  async #recordTx(step: GuestStep, method: string, receiver: string, hash: string, ok: boolean): Promise<void> {
    this.#state!.txs.push({ step, method, hash, ok });
    this.#emit({ type: "tx", step, method, receiver, hash, url: txUrl(hash), ok });
    await this.#save();
  }

  /** Waits until the chain's clock (the final block's time, `get_status().now`) reaches
   * `target`, reading it again at most every `pollMs`. Returns the chain time reached. */
  async #waitChain(step: GuestStep, target: number, what: string): Promise<number> {
    for (;;) {
      const now = (await this.#views.get_status({})).now;
      if (now >= target) return now;
      const secs = target - now;
      this.#emit({ type: "wait", step, seconds: secs, message: `${what} in ${secs} s` });
      // The final block's time trails the wall clock by a few seconds: wait one second more.
      await this.#deps.sleep(Math.max(this.#c.pollMs, (secs + 1) * 1000));
    }
  }

  async #save(): Promise<void> {
    await this.#deps.storage.set(this.#key, JSON.stringify(this.#state));
  }

  #emit(e: GuestEvent): void {
    this.#deps.onEvent?.(e);
  }
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** micro-USDC as dollars. */
export const usd = (micro: bigint): string => {
  const sign = micro < 0n ? "-" : "";
  const m = micro < 0n ? -micro : micro;
  return `${sign}${m / ONE_USD}.${(m % ONE_USD).toString().padStart(6, "0").replace(/0{1,4}$/, "")} USD`;
};

/** micro-USD per GPU-hour as dollars. */
export const price = (micro: number): string => `${usd(big(micro)).replace(" USD", "")} USD`;
