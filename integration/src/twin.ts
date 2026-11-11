// The parity harness. Every state change is sent to the contract through `ChainWeir`, then
// made on a `ModelWeir` at the block time the contract executed it, and the two are compared:
// return value or panic message, and the NEP-297 events the contract logged against the
// model's `eventLog` for the same call. `checkpoint` compares every view of SPEC section 12.
import { isDeepStrictEqual } from "node:util";
import {
  CALLS,
  CallFailed,
  ChainWeir,
  ModelWeir,
  RpcError,
  type NearAccount,
  type NearRpc,
  type PortChange,
  type PortChanges,
  type TxOutcome,
} from "../../chain/src/mod.ts";
import { eventLog, roundCount, type TimeParams, type ViewMethod, type ViewMethods } from "../../engine/src/mod.ts";

export type Area = "contract" | "engine" | "chain" | "agents" | "keeper" | "spec" | "sandbox" | "unclassified";

/** One difference between the contract and the model. */
export interface Diff {
  scenario: string;
  kind: "result" | "error_text" | "outcome" | "events" | "events_key_order" | "view" | "clock";
  method: string;
  args: unknown;
  account?: string;
  at: number;
  chain: unknown;
  model: unknown;
}

export interface ReceiptGas {
  executor: string;
  gas_burnt: number;
}

/** What the chain did with one call, as measured. */
export interface ChainSide {
  ok: boolean;
  result?: unknown;
  error?: string;
  /** `panic`: the contract refused; `rpc`: the node refused the transaction before execution. */
  kind?: "panic" | "rpc" | "other";
  tx_hash?: string;
  gas_burnt?: number;
  gas_attached?: number;
  receipts?: ReceiptGas[];
  exec_time?: number;
  exec_height?: number;
  events: string[];
  wall_ms: number;
}

export interface CallRecord {
  n: number;
  scenario: string;
  account: string;
  method: string;
  args: unknown;
  chain: ChainSide;
  model: { ok: boolean; result?: unknown; error?: string; events: string[] } | null;
  same: boolean;
}

export interface TwinLog {
  calls: CallRecord[];
  diffs: Diff[];
  views: { scenario: string; label: string; compared: number; differing: number }[];
}

const isWeirEvent = (l: string) => l.startsWith("EVENT_JSON:") && l.includes('"standard":"weir"');

interface RawTx {
  receipts_outcome: { block_hash: string; outcome: { executor_id: string; gas_burnt: number } }[];
}

/** Shared by every twin port of one contract. */
export class Twin {
  readonly rpc: NearRpc;
  readonly contractId: string;
  readonly usdcId: string;
  readonly model: ModelWeir;
  readonly log: TwinLog;
  scenario: string;
  /** Called with every chain outcome (for gas). */
  readonly onCall: (r: CallRecord) => void;
  readonly #blockTime = new Map<string, { time: number; height: number }>();
  #n = 0;
  /** Set when the model and the chain disagree on whether a call succeeded: the model's state
   * no longer follows the chain, so later differences are consequences, not findings. */
  diverged: string | null = null;

  constructor(opts: { rpc: NearRpc; contractId: string; usdcId: string; model: ModelWeir; log: TwinLog; scenario: string; onCall?: (r: CallRecord) => void }) {
    this.rpc = opts.rpc;
    this.contractId = opts.contractId;
    this.usdcId = opts.usdcId;
    this.model = opts.model;
    this.log = opts.log;
    this.scenario = opts.scenario;
    this.onCall = opts.onCall ?? (() => {});
  }

  diff(d: Omit<Diff, "scenario" | "at">): void {
    this.log.diffs.push({ scenario: this.scenario, at: this.model.now(), ...d });
  }

  /** A port that signs as `account` on chain and acts as the same account on the model. */
  port(account: NearAccount): TwinPort {
    return new TwinPort(this, account);
  }

  /** The block time and height at which the contract ran this transaction's first receipt. */
  async execTime(txHash: string, sender: string): Promise<{ time: number; height: number; receipts: ReceiptGas[] }> {
    const raw = await this.rpc.call<RawTx>("tx", { tx_hash: txHash, sender_account_id: sender, wait_until: "FINAL" });
    const receipts = raw.receipts_outcome.map((r) => ({ executor: r.outcome.executor_id, gas_burnt: r.outcome.gas_burnt }));
    const mine = raw.receipts_outcome.find((r) => r.outcome.executor_id === this.contractId) ?? raw.receipts_outcome[0]!;
    let b = this.#blockTime.get(mine.block_hash);
    if (!b) {
      const block = await this.rpc.call<{ header: { timestamp_nanosec: string; height: number } }>("block", { block_id: mine.block_hash });
      b = { time: Number(BigInt(block.header.timestamp_nanosec) / 1_000_000_000n), height: block.header.height };
      this.#blockTime.set(mine.block_hash, b);
    }
    return { ...b, receipts };
  }

  /** Sends a batch at once on chain, then replays it on the model in the order the chain ran
   * it (block height, then the seq the contract gave a commit). */
  async batch(calls: (() => Promise<Pending | Pending[]>)[]): Promise<CallRecord[]> {
    const pending = (await Promise.all(calls.map((c) => c()))).flat();
    pending.sort((a, b) => (a.chain.exec_height ?? 0) - (b.chain.exec_height ?? 0) || seqOf(a) - seqOf(b));
    return pending.map((p) => this.replay(p));
  }

  /** Makes a call already done on chain on the model, compares, and records it. */
  replay(p: Pending): CallRecord {
    const { account, method, args, chain } = p;
    let model: CallRecord["model"] = null;
    if (chain.kind !== "rpc" && chain.exec_time !== undefined) {
      if (chain.exec_time < this.model.now()) {
        this.diff({ kind: "clock", method, args, account, chain: chain.exec_time, model: this.model.now() });
      } else {
        this.model.setTime(chain.exec_time);
      }
      const before = this.model.market.events.length;
      try {
        const result = (this.model.as(account).sync.change as (m: string, a: unknown) => unknown)(method, args);
        model = { ok: true, result: result ?? null, events: [] };
      } catch (e) {
        model = { ok: false, error: e instanceof Error ? e.message : String(e), events: [] };
      }
      model.events = this.model.market.events.slice(before).map(eventLog);
    }
    let same = true;
    if (model) {
      if (chain.ok !== model.ok) {
        same = false;
        this.diff({ kind: "outcome", method, args, account, chain: chain.ok ? { ok: true, result: chain.result } : { error: chain.error }, model: model.ok ? { ok: true, result: model.result } : { error: model.error } });
        this.diverged ??= `${method} ${JSON.stringify(args)} by ${account}: chain ${chain.ok ? "succeeded" : "failed"}, model ${model.ok ? "succeeded" : "failed"}`;
      } else if (chain.ok && !isDeepStrictEqual(chain.result ?? null, model.result ?? null)) {
        same = false;
        this.diff({ kind: "result", method, args, account, chain: chain.result, model: model.result });
      } else if (!chain.ok && chain.error !== model.error) {
        same = false;
        this.diff({ kind: "error_text", method, args, account, chain: chain.error, model: model.error });
      }
      if (!arraysEqual(chain.events, model.events)) {
        const parsed = (l: string[]) => l.map((x) => JSON.parse(x.slice("EVENT_JSON:".length)));
        const keyOrderOnly = chain.events.length === model.events.length && isDeepStrictEqual(parsed(chain.events), parsed(model.events));
        same = false;
        this.diff({ kind: keyOrderOnly ? "events_key_order" : "events", method, args, account, chain: chain.events, model: model.events });
      }
    }
    const record: CallRecord = { n: ++this.#n, scenario: this.scenario, account, method, args, chain, model, same };
    this.log.calls.push(record);
    this.onCall(record);
    return record;
  }

  /** Compares every view of section 12 on the contract and the model. */
  async checkpoint(label: string, spec: { tp: TimeParams; series: number[]; accounts: string[]; buckets?: number[]; hashes?: ViewMethods["commit_hash"]["args"][] }): Promise<{ compared: number; differing: number }> {
    const chain = new ChainWeir({ rpc: this.rpc, contractId: this.contractId });
    const m = this.model.sync;
    let compared = 0;
    let differing = 0;
    const cmp = async <M extends ViewMethod>(method: M, args: ViewMethods[M]["args"]) => {
      compared++;
      let c: unknown;
      let mv: unknown;
      try {
        c = await chain.view(method, args);
      } catch (e) {
        c = { error: e instanceof Error ? e.message : String(e) };
      }
      if (method === "get_status") {
        const now = (c as { now?: number }).now;
        if (typeof now === "number" && now >= this.model.now()) this.model.setTime(now);
      }
      try {
        mv = m.view(method, args);
      } catch (e) {
        mv = { error: e instanceof Error ? e.message : String(e) };
      }
      if (!isDeepStrictEqual(c ?? null, mv ?? null)) {
        differing++;
        this.diff({ kind: "view", method, args: { ...args, checkpoint: label }, chain: c, model: mv });
      }
      return c;
    };
    await cmp("get_params", {});
    await cmp("get_status", {});
    await cmp("get_last_print", {});
    await cmp("get_totals", {});
    const prints = (await cmp("get_prints", { from_bucket: 0, limit: 200 })) as { bucket: number }[] | { error: string };
    await cmp("get_prints", { from_bucket: 0, limit: 1000 });
    const buckets = new Set([...(Array.isArray(prints) ? prints.map((p) => p.bucket) : []), ...(spec.buckets ?? [])]);
    for (const b of buckets) await cmp("get_print", { bucket: b });
    if (Array.isArray(prints) && prints.length > 1) await cmp("get_prints", { from_bucket: prints[1]!.bucket, limit: 2 });
    for (const s of [...spec.series, Math.max(...spec.series, 0) + 5]) {
      await cmp("get_series", { series: s });
      await cmp("get_accumulator", { series: s });
      await cmp("get_results", { series: s, from_round: 0, limit: 100 });
      await cmp("get_results", { series: s, from_round: 1, limit: 500 });
      const rounds = roundCount(spec.tp, s);
      for (let r = 0; r < rounds + 1; r++) {
        await cmp("get_round", { series: s, round: r });
        await cmp("get_result", { series: s, round: r });
      }
      for (const a of spec.accounts) await cmp("get_position", { series: s, account_id: a });
    }
    for (const a of [...spec.accounts, "nobody.test.near"]) await cmp("get_account", { account_id: a });
    for (const h of spec.hashes ?? []) await cmp("commit_hash", h);
    this.log.views.push({ scenario: this.scenario, label, compared, differing });
    return { compared, differing };
  }
}

/** A call made on chain, waiting to be replayed on the model. */
export interface Pending {
  account: string;
  method: string;
  args: unknown;
  chain: ChainSide;
}

const seqOf = (p: Pending): number => {
  const commit = p.chain.events.find((e) => e.includes('"event":"commit"'));
  return commit ? (JSON.parse(commit.slice(11)) as { data: { seq: number } }).data.seq : 0;
};

const arraysEqual = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** `WeirPort`-shaped: `call` runs on both and returns the chain's result, throwing the
 * chain's error (a `CallFailed` or an `RpcError`) just as `ChainWeir` does. */
export class TwinPort {
  readonly twin: Twin;
  readonly account: NearAccount;

  constructor(twin: Twin, account: NearAccount) {
    this.twin = twin;
    this.account = account;
  }

  get accountId(): string {
    return this.account.accountId;
  }

  /** The chain half only. */
  async send<M extends PortChange>(method: M, args: PortChanges[M]["args"]): Promise<Pending> {
    // A client per call, so concurrent calls on one account (one nonce queue) keep their
    // outcomes apart.
    let last: TxOutcome | null = null;
    const client = new ChainWeir({ rpc: this.twin.rpc, account: this.account, contractId: this.twin.contractId, usdcId: this.twin.usdcId, onOutcome: (_m, o) => (last = o) });
    const t = Date.now();
    const chain: ChainSide = { ok: false, events: [], wall_ms: 0, gas_attached: Number(CALLS[method].gas) };
    try {
      chain.result = (await client.change(method, args)) ?? null;
      chain.ok = true;
    } catch (e) {
      chain.error = e instanceof Error ? e.message : String(e);
      chain.kind = e instanceof CallFailed ? "panic" : e instanceof RpcError ? "rpc" : "other";
    }
    chain.wall_ms = Date.now() - t;
    const o = last as TxOutcome | null;
    if (o) {
      chain.tx_hash = o.tx_hash;
      chain.gas_burnt = o.gas_burnt;
      chain.events = o.logs.filter(isWeirEvent);
      const x = await this.twin.execTime(o.tx_hash, this.accountId);
      chain.exec_time = x.time;
      chain.exec_height = x.height;
      chain.receipts = x.receipts;
    }
    return { account: this.accountId, method, args, chain };
  }

  /** Both halves; resolves with the chain's result or throws the chain's error. */
  async call<M extends PortChange>(method: M, args: PortChanges[M]["args"]): Promise<PortChanges[M]["result"]> {
    const record = this.twin.replay(await this.send(method, args));
    if (!record.chain.ok) throw new ChainError(record);
    return record.chain.result as PortChanges[M]["result"];
  }

  /** Both halves; the call must fail on chain, and the error is returned. */
  async refused<M extends PortChange>(method: M, args: PortChanges[M]["args"]): Promise<CallRecord> {
    const record = this.twin.replay(await this.send(method, args));
    if (record.chain.ok) throw new Error(`${method} ${JSON.stringify(args)} by ${this.accountId} succeeded on chain but should have been refused`);
    return record;
  }
}

/** A chain call that failed; the message is the chain's. */
export class ChainError extends Error {
  override readonly name = "ChainError";
  readonly record: CallRecord;
  constructor(record: CallRecord) {
    super(`${record.method} by ${record.account} failed on chain: ${record.chain.error}`);
    this.record = record;
  }
}
