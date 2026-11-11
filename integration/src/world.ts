// What every scenario shares: the sandbox, the root account, the test dollar, the built wasm,
// the parity log, the checks, and helpers to deploy a Weir and fund traders.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { ChainWeir, ModelWeir, paramsFromWire, Token, type NearAccount, type TxOutcome } from "../../chain/src/mod.ts";
import { Market, type TimeParams, type WireParams } from "../../engine/src/mod.ts";
import { PRESETS } from "../../agents/src/presets.ts";
import { NEAR, signerFromSecret, type Signer } from "./accounts.ts";
import type { Sandbox } from "./sandbox.ts";
import { Twin, type CallRecord, type TwinLog } from "./twin.ts";

const TARGET = new URL("../../contracts/target/near/", import.meta.url).pathname;
const SOURCES = new URL("../../contracts/", import.meta.url).pathname;

export interface Check {
  scenario: string;
  name: string;
  ok: boolean;
  detail?: unknown;
}

/** The wasm built by contracts/build.sh, refused if older than its sources (as the Rust tests do). */
export function loadWasm(file: string, crate: string): { bytes: Uint8Array; sha256: string; built: string } {
  const path = `${TARGET}${file}`;
  let built: number;
  try {
    built = statSync(path).mtimeMs;
  } catch {
    throw new Error(`${path} is missing: run contracts/build.sh`);
  }
  const src = `${SOURCES}${crate}/src/`;
  const newest = Math.max(...readdirSync(src).map((f) => statSync(`${src}${f}`).mtimeMs));
  if (built < newest) throw new Error(`${path} is older than its source: run contracts/build.sh`);
  const bytes = readFileSync(path);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), built: new Date(built).toISOString() };
}

export class World {
  readonly sandbox: Sandbox;
  readonly root: Signer;
  readonly usdc: Signer;
  readonly token: Token;
  readonly wasm: { weir: ReturnType<typeof loadWasm>; usdc: ReturnType<typeof loadWasm> };
  readonly log: TwinLog = { calls: [], diffs: [], views: [] };
  readonly checks: Check[] = [];
  /** Every token transaction, for the gas table. */
  readonly tokenCalls: { method: string; gas_burnt: number; attached: number }[] = [];
  scenario = "setup";

  private constructor(sandbox: Sandbox, root: Signer, usdc: Signer, wasm: World["wasm"]) {
    this.sandbox = sandbox;
    this.root = root;
    this.usdc = usdc;
    this.wasm = wasm;
    this.token = new Token(sandbox.rpc, usdc.accountId);
  }

  static async create(sandbox: Sandbox): Promise<World> {
    const wasm = { weir: loadWasm("weir/weir.wasm", "weir"), usdc: loadWasm("mock_usdc/mock_usdc.wasm", "mock-usdc") };
    const root = await signerFromSecret(sandbox.rpc, sandbox.root.accountId, sandbox.root.secretKey);
    const usdc = await root.createAccount("usdc", { code: wasm.usdc.bytes });
    return new World(sandbox, root, usdc, wasm);
  }

  check(name: string, ok: boolean, detail?: unknown): boolean {
    this.checks.push({ scenario: this.scenario, name, ok, ...(detail === undefined ? {} : { detail }) });
    if (!ok) console.log(`  FAIL ${this.scenario}: ${name} ${detail === undefined ? "" : JSON.stringify(detail)}`);
    return ok;
  }

  eq(name: string, actual: unknown, expected: unknown): boolean {
    const norm = (v: unknown) => JSON.parse(JSON.stringify(v ?? null, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
    const ok = isDeepStrictEqual(norm(actual), norm(expected));
    return this.check(name, ok, ok ? undefined : { actual: norm(actual), expected: norm(expected) });
  }

  /** A check that `fn` rejects with a message matching `pattern`; returns the message. */
  async rejects(name: string, fn: () => Promise<unknown>, pattern: RegExp): Promise<string> {
    try {
      const v = await fn();
      this.check(name, false, { resolved: v ?? null, expected: String(pattern) });
      return "";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.check(name, pattern.test(msg), pattern.test(msg) ? undefined : { message: msg, expected: String(pattern) });
      return msg;
    }
  }

  tokenOk(method: string, o: TxOutcome, attached: bigint): TxOutcome {
    this.tokenCalls.push({ method, gas_burnt: o.gas_burnt, attached: Number(attached) });
    if (!o.ok) throw new Error(`token ${method} failed: ${o.error}`);
    return o;
  }

  /** The fast preset with `usdc`, `reporters` and `t0` replaced, and nothing else. */
  fastParams(reporters: string[], t0: number, overrides: Partial<WireParams> = {}): WireParams {
    return { ...PRESETS.fast, usdc: this.usdc.accountId, reporters, t0, ...overrides };
  }

  /** Deploys Weir under `name` and calls `new(params)` in the same transaction, and gives it
   * a storage record at the token so it can receive dollars. */
  async deployWeir(name: string, params: WireParams): Promise<{ id: string; signer: Signer }> {
    const signer = await this.root.createAccount(name, { balance: 30n * NEAR, code: this.wasm.weir.bytes, init: { method: "new", args: { params } } });
    this.tokenOk("storage_deposit", await this.token.storageDeposit(this.root.near(), signer.accountId), 10n * 10n ** 12n);
    return { id: signer.accountId, signer };
  }

  /** A twin of a deployed Weir: a `ModelWeir` built from the contract's own `get_params`, its
   * clock at the chain's. */
  async twin(contractId: string, onCall?: (r: CallRecord) => void): Promise<{ twin: Twin; params: WireParams; tp: TimeParams }> {
    const params = await new ChainWeir({ rpc: this.sandbox.rpc, contractId }).get_params({});
    const model = new ModelWeir(new Market(paramsFromWire(params), await this.sandbox.now()), "viewer.test.near");
    const twin = new Twin({ rpc: this.sandbox.rpc, contractId, usdcId: this.usdc.accountId, model, log: this.log, scenario: this.scenario, ...(onCall ? { onCall } : {}) });
    return { twin, params, tp: timeParams(params) };
  }

  /** Mints test dollars to `who` with the token's faucet. */
  async mint(signer: NearAccount, accountId: string, amount: bigint): Promise<void> {
    this.tokenOk("mint", await this.token.mint(signer, accountId, amount.toString()), 10n * 10n ** 12n);
  }

  async usdcBalance(accountId: string): Promise<bigint> {
    return BigInt(await this.token.balanceOf(accountId));
  }

  /** Invariant 1 against the token's own ledger: the contract holds exactly what it owes. */
  async booksBalance(name: string, contractId: string): Promise<void> {
    const t = await new ChainWeir({ rpc: this.sandbox.rpc, contractId }).get_totals({});
    const owed = [t.free, t.locked, t.sets_backing, t.unredeemed, t.burned].reduce((s, x) => s + BigInt(x), 0n);
    this.eq(`${name}: get_totals adds up to the contract's token balance`, owed, await this.usdcBalance(contractId));
  }
}

export const timeParams = (p: WireParams): TimeParams => ({
  t0: p.t0,
  periodSecs: p.period_secs,
  leadSecs: p.lead_secs,
  cutoffSecs: p.cutoff_secs,
  commitSecs: p.commit_secs,
  revealSecs: p.reveal_secs,
});

/** The first multiple of `step` at or after `t`. */
export const onGrid = (t: number, step: number) => Math.ceil(t / step) * step;
