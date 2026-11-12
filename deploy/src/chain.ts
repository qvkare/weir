// What the deployment reads from and sends to a NEAR network, behind one interface so the
// executor runs unchanged on the sandbox, on testnet and on a fake chain in the unit tests.
// Only top-level account creation differs between networks (`TopLevelCreator`).
import {
  base58Decode,
  base58Encode,
  encodeTransaction,
  NearRpc,
  RpcError,
  type AccessKeyPermission,
  type AccountInfo,
  type Action,
  type AnyTransaction,
  type FetchLike,
  type KeyPair,
} from "../../chain/src/mod.ts";
import { decodeOutcome } from "../../chain/src/near.ts";
import { sha256 } from "../../engine/src/mod.ts";
import { pacedFetch, type PaceOptions } from "./pace.ts";

/** NEAR's `DeleteKey` action (borsh enum index 6 of `Action`), which `chain/src/tx.ts` does not encode. */
export interface DeleteKey {
  type: "DeleteKey";
  publicKey: Uint8Array;
}
export type DeployAction = Action | DeleteKey;

export interface KeyView {
  public_key: string;
  nonce: number;
  permission: AccessKeyPermission;
}

export interface Sent {
  hash: string;
  ok: boolean;
  error: string | null;
  result: unknown;
  gas_burnt: number;
}

export interface SignerKey {
  accountId: string;
  key: KeyPair;
}

/** The protocol's prices that the budget depends on (EXPERIMENTAL_protocol_config). */
export interface ProtocolCosts {
  version: number;
  gasPrice: bigint;
  gasPurchasePrice: bigint;
  accountCreationCharge: bigint;
  storagePerByte: bigint;
}

export interface DeployChain {
  now(): Promise<number>;
  gasPrice(): Promise<bigint>;
  protocol(): Promise<ProtocolCosts>;
  account(id: string): Promise<AccountInfo | null>;
  keys(id: string): Promise<KeyView[]>;
  view<T>(contract: string, method: string, args: object): Promise<T>;
  send(signer: SignerKey, receiver: string, actions: DeployAction[]): Promise<Sent>;
  /** Creates a top-level account holding `key` as its full-access key, funded by the faucet
   * (testnet) or the root account (sandbox). Resolves once the account is visible. */
  createTopLevel(accountId: string, key: KeyPair): Promise<{ hash: string | null; note: string }>;
}

/** The default code hash of an account without a contract. */
export const NO_CODE = "11111111111111111111111111111111";

/** Borsh of a transaction that may hold `DeleteKey` actions. Every other action, and the
 * header, are encoded by `chain/src/tx.ts`; `DeleteKey` is `6`, then the public key
 * (`0` for ed25519, 32 bytes). Checked byte for byte against `@near-js/transactions`. */
export function encodeDeployTransaction(tx: Omit<AnyTransaction, "actions"> & { actions: DeployAction[] }): Uint8Array {
  const empty = encodeTransaction({ ...tx, actions: [] });
  const n = tx.actions.length;
  // The header, then the action count (u32, little-endian), then each action.
  const parts: Uint8Array[] = [empty.slice(0, empty.length - 4), Uint8Array.of(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff)];
  for (const a of tx.actions) {
    if ("type" in a && a.type === "DeleteKey") {
      if (a.publicKey.length !== 32) throw new Error("public key must be 32 bytes");
      parts.push(Uint8Array.of(6, 0), a.publicKey);
    } else {
      parts.push(encodeTransaction({ ...tx, actions: [a as Action] }).subarray(empty.length));
    }
  }
  return concat(parts);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export async function signDeployTransaction(tx: Omit<AnyTransaction, "actions"> & { actions: DeployAction[] }, key: KeyPair): Promise<{ hash: string; signed: Uint8Array }> {
  const bytes = encodeDeployTransaction(tx);
  const digest = sha256(bytes);
  const signature = await key.sign(digest);
  return { hash: base58Encode(digest), signed: concat([bytes, Uint8Array.of(0), signature]) };
}

export type TopLevelCreator = (rpc: NearRpc, accountId: string, key: KeyPair) => Promise<{ hash: string | null; note: string }>;

const isUnknown = (e: unknown) => e instanceof RpcError && /UNKNOWN_ACCOUNT|does not exist/i.test(`${e.code} ${e.message}`);

/** `DeployChain` over NEAR JSON-RPC. One nonce queue per key, so a key's transactions never collide. */
export class RpcChain implements DeployChain {
  readonly rpc: NearRpc;
  readonly #create: TopLevelCreator;
  readonly #queues = new Map<string, { queue: Promise<unknown>; nonce: bigint }>();

  constructor(rpc: NearRpc, create: TopLevelCreator) {
    this.rpc = rpc;
    this.#create = create;
  }

  async now(): Promise<number> {
    const b = await this.rpc.call<{ header: { timestamp_nanosec: string } }>("block", { finality: "final" });
    return Number(BigInt(b.header.timestamp_nanosec) / 1_000_000_000n);
  }

  async gasPrice(): Promise<bigint> {
    const r = await this.rpc.call<{ gas_price: string }>("gas_price", [null]);
    return BigInt(r.gas_price);
  }

  async protocol(): Promise<ProtocolCosts> {
    const c = await this.rpc.call<{ protocol_version: number; runtime_config: { min_gas_purchase_price?: string; account_creation_charge?: string; storage_amount_per_byte: string } }>(
      "EXPERIMENTAL_protocol_config",
      { finality: "final" },
    );
    const rc = c.runtime_config;
    return {
      version: c.protocol_version,
      gasPrice: await this.gasPrice(),
      gasPurchasePrice: BigInt(rc.min_gas_purchase_price ?? "0"),
      accountCreationCharge: BigInt(rc.account_creation_charge ?? "0"),
      storagePerByte: BigInt(rc.storage_amount_per_byte),
    };
  }

  async account(id: string): Promise<AccountInfo | null> {
    try {
      return await this.rpc.viewAccount(id);
    } catch (e) {
      if (isUnknown(e)) return null;
      throw e;
    }
  }

  async keys(id: string): Promise<KeyView[]> {
    try {
      const r = await this.rpc.call<{ keys: { public_key: string; access_key: { nonce: number; permission: AccessKeyPermission } }[] }>("query", {
        request_type: "view_access_key_list",
        finality: "final",
        account_id: id,
      });
      return r.keys.map((k) => ({ public_key: k.public_key, nonce: k.access_key.nonce, permission: k.access_key.permission }));
    } catch (e) {
      if (isUnknown(e)) return [];
      throw e;
    }
  }

  view<T>(contract: string, method: string, args: object): Promise<T> {
    return this.rpc.view<T>(contract, method, args);
  }

  send(signer: SignerKey, receiver: string, actions: DeployAction[]): Promise<Sent> {
    const id = `${signer.accountId}|${signer.key.publicKeyString}`;
    const q = this.#queues.get(id) ?? { queue: Promise.resolve(), nonce: 0n };
    this.#queues.set(id, q);
    const run = async (): Promise<Sent> => {
      const ak = await this.rpc.viewAccessKey(signer.accountId, signer.key.publicKeyString);
      const nonce = (BigInt(ak.nonce) > q.nonce ? BigInt(ak.nonce) : q.nonce) + 1n;
      q.nonce = nonce;
      const tx = { signerId: signer.accountId, publicKey: signer.key.publicKey, nonce, receiverId: receiver, blockHash: base58Decode(ak.block_hash), actions };
      const { hash, signed } = await signDeployTransaction(tx, signer.key);
      const o = await this.rpc.sendTx(signed, hash, signer.accountId);
      return { hash: o.tx_hash, ok: o.ok, error: o.error, result: o.result, gas_burnt: o.gas_burnt };
    };
    const next = q.queue.then(run, run);
    q.queue = next.catch(() => undefined);
    return next;
  }

  createTopLevel(accountId: string, key: KeyPair): Promise<{ hash: string | null; note: string }> {
    return this.#create(this.rpc, accountId, key);
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Waits until `accountId` is visible at final finality. */
export async function waitForAccount(rpc: NearRpc, accountId: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await rpc.viewAccount(accountId);
      return;
    } catch (e) {
      if (!isUnknown(e)) throw e;
    }
    if (Date.now() > deadline) throw new Error(`${accountId} was not visible after ${timeoutMs / 1000} s`);
    await sleep(1000);
  }
}

/** Sandbox: the root account (`test.near`, whose key the sandbox writes to validator_key.json)
 * creates the account as a sub-account of itself, with the faucet's usual grant, as
 * integration/src/accounts.ts does. */
export function rootCreator(root: SignerKey, grant: bigint): TopLevelCreator {
  let chain: RpcChain | null = null;
  return async (rpc, accountId, key) => {
    chain ??= new RpcChain(rpc, () => Promise.reject(new Error("unused")));
    const o = await chain.send(root, accountId, [
      { type: "CreateAccount" },
      { type: "Transfer", deposit: grant },
      { type: "AddKey", publicKey: key.publicKey, permission: "FullAccess" },
    ]);
    if (!o.ok) throw new Error(`${root.accountId} could not create ${accountId}: ${o.error}`);
    return { hash: o.hash, note: `created by ${root.accountId}` };
  };
}

/** The faucet near-cli-rs uses for `account create-account sponsor-by-faucet-service` on testnet:
 * near-cli-rs (github.com/near/near-cli-rs, commit 5cdedc38, 2026-11), `src/config/mod.rs`,
 * testnet `faucet_url: Some("https://helper.nearprotocol.com/account")`, and
 * `src/commands/account/create_account/sponsor_by_faucet_service/mod.rs`,
 * `before_creating_account`: a POST with the JSON body
 * `{ "newAccountId": <id>, "newAccountPublicKey": "ed25519:<base58>" }`; a status of 400 or more
 * is a failure; the body is an `RpcTransactionResponse` (the final execution outcome of the
 * creating transaction), whose `SuccessValue` "false" means the account was not created. */
export const FAUCET_URL = "https://helper.nearprotocol.com/account";

export interface FaucetOptions {
  url?: string;
  /** Total time to keep retrying through rate limits and outages. Default 15 minutes. */
  maxWaitMs?: number;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  log?: (line: string) => void;
  /** For tests. */
  sleep?: (ms: number) => Promise<void>;
}

export function faucetCreator(opts: FaucetOptions = {}): TopLevelCreator {
  const url = opts.url ?? FAUCET_URL;
  const doFetch = opts.fetch ?? ((u, i) => fetch(u, i));
  const wait = opts.sleep ?? sleep;
  const maxWaitMs = opts.maxWaitMs ?? 15 * 60_000;
  const log = opts.log ?? (() => {});
  return async (rpc, accountId, key) => {
    const started = Date.now();
    let delay = 15_000;
    for (let attempt = 1; ; attempt++) {
      // A previous attempt may have landed even though its answer was lost.
      try {
        await rpc.viewAccount(accountId);
        return { hash: null, note: "already created by an earlier faucet request" };
      } catch (e) {
        if (!isUnknown(e)) throw e;
      }
      let retry: string;
      try {
        const res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: key.publicKeyString }),
          signal: AbortSignal.timeout(60_000),
        });
        const text = await res.text();
        if (res.status === 429 || res.status >= 500) {
          retry = `HTTP ${res.status}${res.headers.get("retry-after") ? `, retry-after ${res.headers.get("retry-after")}` : ""}`;
          const ra = Number(res.headers.get("retry-after"));
          if (Number.isFinite(ra) && ra > 0) delay = Math.max(delay, ra * 1000);
        } else if (res.status >= 400) {
          throw new Error(`the faucet refused ${accountId}: HTTP ${res.status}: ${text.slice(0, 300)}`);
        } else {
          let o: ReturnType<typeof decodeOutcome> | null = null;
          try {
            o = decodeOutcome(JSON.parse(text));
          } catch {
            // Not the shape near-cli-rs expects; the account's existence decides below.
          }
          if (o && !o.ok) throw new Error(`the faucet's transaction for ${accountId} failed: ${o.error}`);
          if (o && o.result === false) throw new Error(`the faucet answered false for ${accountId}: the account was not created (is the name taken?)`);
          await waitForAccount(rpc, accountId);
          return { hash: o?.tx_hash || null, note: `created by the faucet ${url}` };
        }
      } catch (e) {
        if (e instanceof Error && /^the faucet/.test(e.message)) throw e;
        retry = `request failed: ${e instanceof Error ? e.message : String(e)}`;
      }
      const waited = Date.now() - started;
      if (waited + delay > maxWaitMs) {
        throw new Error(`the faucet did not create ${accountId} after ${attempt} attempts (${retry}); nothing is lost: run apply again later and it resumes here`);
      }
      log(`  faucet: ${retry}; waiting ${Math.round(delay / 1000)} s before attempt ${attempt + 1}`);
      await wait(delay);
      delay = Math.min(delay * 2, 120_000);
    }
  };
}

/** `NearRpc` over a paced fetch (`src/pace.ts`): a rate limit is waited out on the same endpoint
 * before failing over. Each try times out on its own (20 s, 60 s for calls that wait on the chain);
 * `NearRpc`'s own timer is set beyond a try plus the longest wait so that it never counts the waits. */
export function rpcFor(urls: readonly string[], fetchImpl?: FetchLike, pace: Omit<PaceOptions, "fetch"> = {}): NearRpc {
  const maxWaitMs = pace.maxWaitMs ?? 90_000;
  const fetch = pacedFetch({ ...pace, maxWaitMs, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  return new NearRpc({ urls, timeoutMs: 60_000 + maxWaitMs + 10_000, fetch });
}
