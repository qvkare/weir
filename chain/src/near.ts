// A minimal NEAR JSON-RPC client: views, account and access-key queries, the latest block
// hash, and signed function calls sent with `send_tx` and waited on until final. It fails
// over between RPC URLs with a per-call timeout and uses only `fetch`, so it runs in Node,
// browsers and Cloudflare Workers.
import {
  base58Decode,
  base58Encode,
  base64Decode,
  base64Encode,
  signTransaction,
  utf8Decode,
  utf8Encode,
  type KeyPair,
} from "./tx.ts";

/** The subset of `fetch` the client uses, so tests can pass a fake transport. */
export type FetchLike = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

export interface RpcOptions {
  urls: readonly string[];
  /** Per request, per URL. Default 10 s. */
  timeoutMs?: number;
  fetch?: FetchLike;
}

/** A JSON-RPC error the node returned. These are answers, not outages, so they are not retried elsewhere. */
export class RpcError extends Error {
  override readonly name = "RpcError";
  readonly code: string;
  readonly data: unknown;

  constructor(message: string, code: string, data: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export interface AccountInfo {
  amount: string;
  locked: string;
  code_hash: string;
  storage_usage: number;
}

export type AccessKeyPermission =
  | "FullAccess"
  | { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } };

export interface AccessKeyInfo {
  nonce: number;
  permission: AccessKeyPermission;
  block_hash: string;
  block_height: number;
}

/** A transaction's final outcome, decoded. */
export interface TxOutcome {
  ok: boolean;
  /** The return value of the called method: parsed JSON, a string if it is not JSON, or null. */
  result: unknown;
  /** Logs of the transaction and every receipt, in order. */
  logs: string[];
  /** The failure, or null. A contract panic reads `Smart contract panicked: <message>`. */
  error: string | null;
  tx_hash: string;
  gas_burnt: number;
}

const RETRY_CODES = new Set(["INTERNAL_ERROR", "TIMEOUT_ERROR"]);

export class NearRpc {
  readonly urls: readonly string[];
  readonly timeoutMs: number;
  readonly #fetch: FetchLike;
  #preferred = 0;
  #id = 0;

  constructor(opts: RpcOptions) {
    if (opts.urls.length === 0) throw new Error("at least one RPC URL is needed");
    this.urls = [...opts.urls];
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.#fetch = opts.fetch ?? ((url, init) => fetch(url, init));
  }

  /** One JSON-RPC call. Tries each URL in turn, starting with the last one that answered,
   * on network errors, timeouts, HTTP 429 and 5xx, and node-side INTERNAL or TIMEOUT errors. */
  async call<T>(method: string, params: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: ++this.#id, method, params });
    let last: unknown = null;
    for (let i = 0; i < this.urls.length; i++) {
      const index = (this.#preferred + i) % this.urls.length;
      try {
        const reply = await this.#post(this.urls[index]!, body, timeoutMs);
        if (reply.error) {
          const cause = reply.error.cause?.name ?? reply.error.name ?? "UNKNOWN";
          const err = new RpcError(rpcMessage(reply.error), cause, reply.error.data);
          if (!RETRY_CODES.has(cause) && !RETRY_CODES.has(reply.error.name ?? "")) throw err;
          last = err;
          continue;
        }
        this.#preferred = index;
        return reply.result as T;
      } catch (e) {
        if (e instanceof RpcError && !RETRY_CODES.has(e.code)) throw e;
        last = e;
      }
    }
    throw last instanceof Error ? last : new Error(`every RPC URL failed for ${method}`);
  }

  async #post(url: string, body: string, timeoutMs: number): Promise<{ result?: unknown; error?: JsonRpcError }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.#fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: controller.signal,
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`${url} answered HTTP ${res.status}`);
      return JSON.parse(await res.text()) as { result?: unknown; error?: JsonRpcError };
    } catch (e) {
      if (controller.signal.aborted) throw new Error(`${url} timed out after ${timeoutMs} ms`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Calls a view method with JSON arguments and parses its JSON result. */
  async view<T>(contractId: string, method: string, args: object = {}): Promise<T> {
    const res = await this.call<{ result?: number[]; error?: string }>("query", {
      request_type: "call_function",
      finality: "final",
      account_id: contractId,
      method_name: method,
      args_base64: base64Encode(utf8Encode(JSON.stringify(args))),
    });
    // Older nodes put a contract panic in the result instead of a JSON-RPC error.
    if (res.error) throw new RpcError(res.error, "CONTRACT_EXECUTION_ERROR", res.error);
    const text = utf8Decode(Uint8Array.from(res.result ?? []));
    return (text === "" ? null : JSON.parse(text)) as T;
  }

  viewAccount(accountId: string): Promise<AccountInfo> {
    return this.call("query", { request_type: "view_account", finality: "final", account_id: accountId });
  }

  viewAccessKey(accountId: string, publicKey: string): Promise<AccessKeyInfo> {
    return this.call("query", {
      request_type: "view_access_key",
      finality: "final",
      account_id: accountId,
      public_key: publicKey,
    });
  }

  async latestBlockHash(): Promise<string> {
    const block = await this.call<{ header: { hash: string } }>("block", { finality: "final" });
    return block.header.hash;
  }

  /** Sends a signed transaction and waits until its outcome is final. If the node gives up
   * waiting, polls `tx` for the same hash, which is safe: a transaction lands at most once.
   * Waiting calls get at least 30 s, since a node itself waits about 10 s before giving up. */
  async sendTx(signed: Uint8Array, txHash: string, senderId: string, polls = 6): Promise<TxOutcome> {
    const wait = Math.max(this.timeoutMs, 30_000);
    try {
      const raw = await this.call<RawOutcome>("send_tx", { signed_tx_base64: base64Encode(signed), wait_until: "FINAL" }, wait);
      return decodeOutcome(raw, txHash);
    } catch (e) {
      if (!timedOut(e)) throw e;
      let last: unknown = e;
      for (let i = 0; i < polls; i++) {
        try {
          const raw = await this.call<RawOutcome>("tx", { tx_hash: txHash, sender_account_id: senderId, wait_until: "FINAL" }, wait);
          return decodeOutcome(raw, txHash);
        } catch (err) {
          last = err;
        }
      }
      throw last;
    }
  }
}

const timedOut = (e: unknown): boolean =>
  (e instanceof RpcError && e.code === "TIMEOUT_ERROR") || (e instanceof Error && / timed out after /.test(e.message));

interface JsonRpcError {
  name?: string;
  message?: string;
  code?: number;
  cause?: { name?: string; info?: unknown };
  data?: unknown;
}

function rpcMessage(err: JsonRpcError): string {
  const data = typeof err.data === "string" ? err.data : JSON.stringify(err.data ?? err.cause?.info ?? null);
  return `${err.cause?.name ?? err.name ?? "RPC error"}: ${data}`;
}

type ExecStatus = { SuccessValue: string } | { SuccessReceiptId: string } | { Failure: unknown } | "Unknown" | "Pending";

interface RawOutcome {
  status: ExecStatus;
  transaction?: { hash: string };
  transaction_outcome: { outcome: { logs: string[]; gas_burnt: number } };
  receipts_outcome: { outcome: { logs: string[]; gas_burnt: number } }[];
}

/** Decodes a final execution outcome as `send_tx` and `tx` return it. */
export function decodeOutcome(raw: RawOutcome, txHash = raw.transaction?.hash ?? ""): TxOutcome {
  const parts = [raw.transaction_outcome.outcome, ...raw.receipts_outcome.map((r) => r.outcome)];
  const logs = parts.flatMap((o) => o.logs);
  const gas_burnt = parts.reduce((sum, o) => sum + o.gas_burnt, 0);
  const status = raw.status;
  if (typeof status === "object" && "SuccessValue" in status) {
    const text = utf8Decode(base64Decode(status.SuccessValue));
    let result: unknown = null;
    if (text !== "") {
      try {
        result = JSON.parse(text);
      } catch {
        result = text;
      }
    }
    return { ok: true, result, logs, error: null, tx_hash: txHash, gas_burnt };
  }
  const error =
    typeof status === "object" && "Failure" in status ? failureMessage(status.Failure) : `transaction status is ${JSON.stringify(status)}`;
  return { ok: false, result: null, logs, error, tx_hash: txHash, gas_burnt };
}

/** The contract's own message when there is one (`ExecutionError`), else the failure as JSON. */
function failureMessage(failure: unknown): string {
  const kind = (failure as { ActionError?: { kind?: { FunctionCallError?: { ExecutionError?: string } } } })
    ?.ActionError?.kind?.FunctionCallError?.ExecutionError;
  return kind ?? JSON.stringify(failure);
}

/** The text after `Smart contract panicked: `, or the whole error when it is not a panic. */
export const panicMessage = (error: string): string => error.replace(/^.*?Smart contract panicked: /s, "");

/** An account that signs and sends function calls with one ed25519 key. Calls from one
 * instance are sent one at a time, so nonces never collide. */
export class NearAccount {
  readonly rpc: NearRpc;
  readonly accountId: string;
  readonly key: KeyPair;
  #queue: Promise<unknown> = Promise.resolve();
  #nonce = 0n;

  constructor(rpc: NearRpc, accountId: string, key: KeyPair) {
    this.rpc = rpc;
    this.accountId = accountId;
    this.key = key;
  }

  /** Signs, sends and waits for one function call. Resolves with the outcome, even when the
   * call failed on chain; rejects only when the transaction could not be sent. */
  functionCall(receiverId: string, methodName: string, args: object, gas: bigint, deposit: bigint): Promise<TxOutcome> {
    const run = () => this.#send(receiverId, methodName, args, gas, deposit);
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #send(receiverId: string, methodName: string, args: object, gas: bigint, deposit: bigint): Promise<TxOutcome> {
    for (let attempt = 0; ; attempt++) {
      const ak = await this.rpc.viewAccessKey(this.accountId, this.key.publicKeyString);
      const nonce = (BigInt(ak.nonce) > this.#nonce ? BigInt(ak.nonce) : this.#nonce) + 1n;
      const tx = {
        signerId: this.accountId,
        publicKey: this.key.publicKey,
        nonce,
        receiverId,
        blockHash: base58Decode(ak.block_hash),
        actions: [{ methodName, args: utf8Encode(JSON.stringify(args)), gas, deposit }],
      };
      const { hash, signed } = await signTransaction(tx, this.key);
      this.#nonce = nonce;
      try {
        return await this.rpc.sendTx(signed, base58Encode(hash), this.accountId);
      } catch (e) {
        // Another signer used the key in between: read the nonce again, once.
        if (attempt === 0 && /InvalidNonce/.test(e instanceof Error ? e.message : String(e))) continue;
        throw e;
      }
    }
  }
}
