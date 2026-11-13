// A minimal NEAR JSON-RPC client: views, account and access-key queries, the latest block
// hash, and signed function calls sent with `send_tx` and waited on until final. It fails
// over between RPC URLs with a per-call timeout, passes over endpoints that refused recently,
// and uses only `fetch`, so it runs in Node, browsers and Cloudflare Workers.
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

/** The subset of `fetch` the client uses, so tests can pass a fake transport. Every attempt
 * goes through it, so a caller that meters requests sees each one. */
export type FetchLike = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number; text(): Promise<string>; headers?: { get(name: string): string | null } }>;

export interface RpcOptions {
  urls: readonly string[];
  /** Per request, per URL. Default 10 s. */
  timeoutMs?: number;
  fetch?: FetchLike;
  /** How long an endpoint that failed is passed over, unless it said how long (retry-after). Default 10 s. */
  cooldownMs?: number;
  /** The longest the client waits, once per call, when every endpoint refused it for rate. Default 2 s. */
  maxRateWaitMs?: number;
  /** Per request for `send_tx` and `tx`, which wait for finality. Default the larger of 30 s and `timeoutMs`. */
  sendTimeoutMs?: number;
  /** Which endpoints are cooling down. Pass one `EndpointHealth` to several `NearRpc`s (one
   * per account, say) so a refusal seen by one steers them all. Default: this client's own. */
  health?: EndpointHealth;
  /** Recognises the caller's own errors thrown through its `fetch` (a request budget, say).
   * Those go up unchanged: no failover, no cooldown; during the lookups of a transaction that
   * may have landed they become `TxStatusUnknown`. Default: none, every thrown error is the
   * endpoint failing. */
  isCallerError?: (e: unknown) => boolean;
  /** Clock and sleep, for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** A JSON-RPC error in NEAR's shape (`name` and `cause.name`): the node's answer, such as an
 * unknown account, a contract panic or an invalid nonce. Not retried on another endpoint. */
export class RpcError extends Error {
  override readonly name = "RpcError";
  readonly code: string;
  readonly data: unknown;
  /** Endpoints that failed before this answer came, for `sendTx` to judge whether its
   * transaction may already have been delivered. */
  after: EndpointError[] = [];

  constructor(message: string, code: string, data: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/** One endpoint failing one request: unreachable, too slow, rate-limiting, or answering with
 * something that is not a NEAR JSON-RPC reply. The next endpoint is tried. */
export class EndpointError extends Error {
  override readonly name = "EndpointError";
  readonly url: string;
  /** HTTP status, or null when no response came. */
  readonly status: number | null;
  readonly rateLimited: boolean;
  /** From `retry-after`, when the endpoint gave a positive one. */
  readonly retryAfterMs: number | null;
  /** True when the request may have reached a node before failing (a timeout, a dropped
   * connection, a 5xx, a node TIMEOUT or INTERNAL error): a sent transaction may have landed. */
  readonly maybeDelivered: boolean;
  /** A timeout (ours, or the node's TIMEOUT_ERROR): slow, not refusing, so no cooldown. */
  readonly timeout: boolean;

  constructor(message: string, o: { url: string; status: number | null; rateLimited?: boolean; retryAfterMs?: number | null; maybeDelivered: boolean; timeout?: boolean }) {
    super(message);
    this.url = o.url;
    this.status = o.status;
    this.rateLimited = o.rateLimited ?? false;
    this.retryAfterMs = o.retryAfterMs ?? null;
    this.maybeDelivered = o.maybeDelivered;
    this.timeout = o.timeout ?? false;
  }
}

/** Endpoints passed over after a refusal or a fault: until when, and whether for rate. */
export class EndpointHealth {
  readonly cooling = new Map<string, { until: number; rate: boolean }>();
}

/** Every endpoint failed a call. The message lists what each one said. */
export class RpcUnavailable extends Error {
  override readonly name = "RpcUnavailable";
  readonly attempts: EndpointError[];

  constructor(method: string, attempts: EndpointError[], note = "") {
    super(`every RPC endpoint failed for ${method}${note}: ${attempts.map((a) => a.message).join("; ") || "no attempt made"}`);
    this.attempts = attempts;
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
/** Cap on a cooldown taken from `retry-after`. */
const MAX_COOLDOWN_MS = 60_000;

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export class NearRpc {
  readonly urls: readonly string[];
  readonly timeoutMs: number;
  readonly sendTimeoutMs: number;
  readonly #fetch: FetchLike;
  readonly #cooldownMs: number;
  readonly #maxRateWaitMs: number;
  readonly #now: () => number;
  readonly #isCallerError: (e: unknown) => boolean;
  readonly #sleep: (ms: number) => Promise<void>;
  /** Endpoint -> until when it goes to the back of the line, and whether it refused for rate. */
  readonly #cooling: Map<string, { until: number; rate: boolean }>;
  #id = 0;

  constructor(opts: RpcOptions) {
    if (opts.urls.length === 0) throw new Error("at least one RPC URL is needed");
    this.urls = [...opts.urls];
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.sendTimeoutMs = opts.sendTimeoutMs ?? Math.max(this.timeoutMs, 30_000);
    this.#fetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.#cooldownMs = opts.cooldownMs ?? 10_000;
    this.#maxRateWaitMs = opts.maxRateWaitMs ?? 2_000;
    this.#now = opts.now ?? (() => Date.now());
    this.#isCallerError = opts.isCallerError ?? (() => false);
    this.#sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#cooling = (opts.health ?? new EndpointHealth()).cooling;
  }

  /** One JSON-RPC call. Endpoints are tried in the order given, skipping to the end any that
   * failed recently (a cooldown, `retry-after` when given). A NEAR-shaped error is the node's
   * answer and is thrown at once, except INTERNAL and TIMEOUT errors. Anything else, a network
   * error, a timeout, HTTP 429 or 5xx, or an error body not in NEAR's shape, is that endpoint
   * failing, and the next one is tried. An endpoint that refused or faulted (not one that was
   * merely slow) goes to the back of the line for `cooldownMs`, or its `retry-after`. If every
   * endpoint refused for rate, the call waits once (at most `maxRateWaitMs`) and tries them all
   * again, or, when the refusals last longer than that, fails at once without a request. */
  async call<T>(method: string, params: unknown, timeoutMs = this.timeoutMs, fallback?: { params: unknown; timeoutMs: number }): Promise<T> {
    const id = ++this.#id;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    // `fallback`: what every attempt after the first sends instead (sendTx: a send that does not wait).
    const fallbackBody = fallback && JSON.stringify({ jsonrpc: "2.0", id, method, params: fallback.params });
    let attempts = 0;
    const failures: EndpointError[] = [];
    const now = this.#now();
    const until = (url: string) => this.#cooling.get(url)?.until ?? 0;
    const order = [...this.urls].sort((a, b) => Math.max(until(a), now) - Math.max(until(b), now));
    const soonest = until(order[0]!);
    const allRefusing = this.urls.every((u) => until(u) > now && this.#cooling.get(u)!.rate);
    if (allRefusing) {
      // Every endpoint refused for rate a moment ago. Wait if that ends soon, otherwise fail
      // without paying for another refused request.
      if (soonest - now > this.#maxRateWaitMs) {
        throw new RpcUnavailable(method, [], ` (every endpoint is cooling down after refusals for ${Math.ceil((soonest - now) / 1000)} s more)`);
      }
      await this.#sleep(soonest - now);
    }
    let waited = allRefusing;
    for (let pass = 0; pass < 2; pass++) {
      for (const url of order) {
        try {
          const later = attempts++ > 0 && fallbackBody !== undefined;
          const value = await this.#attempt(url, later ? fallbackBody : body, later ? fallback!.timeoutMs : timeoutMs);
          this.#cooling.delete(url);
          return value as T;
        } catch (e) {
          if (e instanceof RpcError) {
            e.after = [...failures];
            throw e;
          }
          if (!(e instanceof EndpointError)) throw e;
          const failure = e;
          failures.push(failure);
          // A refusal or a fault puts the endpoint aside for a while; a slow answer does not.
          if (!failure.timeout) {
            const pause = failure.rateLimited ? Math.min(failure.retryAfterMs ?? this.#cooldownMs, MAX_COOLDOWN_MS) : this.#cooldownMs;
            this.#cooling.set(url, { until: this.#now() + pause, rate: failure.rateLimited });
          }
        }
      }
      const thisPass = failures.slice(-order.length);
      if (pass > 0 || waited || !thisPass.every((f) => f.rateLimited)) break;
      const wait = Math.min(...thisPass.map((f) => f.retryAfterMs ?? 1_000));
      if (wait > this.#maxRateWaitMs) break;
      await this.#sleep(wait);
      waited = true;
    }
    throw new RpcUnavailable(method, failures);
  }

  /** One request to one endpoint: its result, a thrown `RpcError` (the node's answer) or a
   * thrown `EndpointError` (the endpoint failing). */
  async #attempt(url: string, body: string, timeoutMs: number): Promise<unknown> {
    const host = hostOf(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let status: number;
    let text: string;
    let retryAfter: string | null = null;
    try {
      const res = await this.#fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: controller.signal,
      });
      status = res.status;
      retryAfter = res.headers?.get("retry-after") ?? null;
      text = await res.text();
    } catch (e) {
      // Any error the fetch throws is this endpoint failing, whatever its class (runtimes
      // differ), unless the caller says it is its own (`isCallerError`): that goes up unchanged.
      if (this.#isCallerError(e)) throw e;
      const message = controller.signal.aborted ? `${host} timed out after ${timeoutMs} ms` : `${host}: ${e instanceof Error ? e.message : String(e)}`;
      throw new EndpointError(message, { url, status: null, maybeDelivered: true, timeout: controller.signal.aborted });
    } finally {
      clearTimeout(timer);
    }
    let json: { result?: unknown; error?: JsonRpcError } | null = null;
    try {
      json = JSON.parse(text) as { result?: unknown; error?: JsonRpcError };
    } catch {
      json = null;
    }
    const err = json?.error;
    if (err && (err.name || err.cause?.name)) {
      const code = err.cause?.name ?? err.name!;
      const answer = new RpcError(nearMessage(err), code, err.data ?? err.cause?.info ?? null);
      if (!RETRY_CODES.has(code) && !RETRY_CODES.has(err.name ?? "")) throw answer;
      throw new EndpointError(`${host}: ${answer.message}`, { url, status, maybeDelivered: true, timeout: code === "TIMEOUT_ERROR" });
    }
    if (status >= 200 && status < 300 && json && !err && "result" in json) return json.result;
    const seconds = Number(retryAfter);
    const retryAfterMs = retryAfter !== null && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
    const said = err
      ? `: ${err.message ?? JSON.stringify(err)}${err.code !== undefined ? ` (code ${err.code})` : ""}`
      : json
        ? ": no result in the reply"
        : `: ${text.slice(0, 200) || "empty body"}`;
    // 408, 504 and 524 are a gateway giving up on its own request: the node may have the
    // transaction (dRPC's free plan answers a waiting send_tx with 408 after forwarding it).
    // They are slow answers, not refusals: no cooldown, and a sent transaction is looked up.
    const gatewayTimeout = status === 408 || status === 504 || status === 524;
    throw new EndpointError(`${host} answered HTTP ${status}${said}`, {
      url,
      status,
      rateLimited: status === 429 || err?.code === -429,
      retryAfterMs,
      maybeDelivered: status >= 500 || gatewayTimeout,
      timeout: gatewayTimeout,
    });
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

  /** Sends a signed transaction and returns its final outcome. The same signed bytes may
   * reach several endpoints; they are one transaction with one hash and land at most once, so
   * whatever happens it ends in that transaction's one outcome, and a transaction that may
   * have landed is looked up before anything is reported as failed.
   *
   * - Common case, 1 request: the first endpoint answers `send_tx` waiting for `FINAL`.
   * - When that attempt fails, the next endpoints get the same bytes with `wait_until: NONE`,
   *   which returns as soon as the node has them (a free gateway cannot hold a request open
   *   for finality: dRPC answers 408), and the outcome is then looked up.
   * - The lookup is `tx` by hash and signer with `wait_until: NONE`, which any endpoint answers
   *   at once, every `pollMs` (1 s) up to `polls` times, until the outcome is executed in final
   *   blocks (`EXECUTED` or `FINAL`). Typical cost on testnet: 2 to 4 lookups.
   * - It looks up when any endpoint may have delivered the bytes (no response, a timeout, a
   *   408/504/524, a 5xx, a node TIMEOUT or INTERNAL error), when a send without waiting was
   *   accepted, and when an answer says the transaction is already known.
   * - If no endpoint knows the hash after two lookups, the same bytes are sent once more
   *   (without waiting), and the lookups go on.
   * - `InvalidNonce` after another endpoint may have delivered it is checked with `tx`: known,
   *   it is our own transaction; unknown everywhere, the refusal stands.
   * - Refused everywhere for rate, or an answer that rules delivery out: thrown, nothing looked up.
   * - Still not final after every lookup: `TxStatusUnknown`, which is not a failure: the
   *   transaction may yet land, and must not be reported as failed or signed again. */
  async sendTx(signed: Uint8Array, txHash: string, senderId: string, polls = 8, pollMs = 1_000): Promise<TxOutcome> {
    const bytes = base64Encode(signed);
    const quick = { params: { signed_tx_base64: bytes, wait_until: "NONE" }, timeoutMs: this.timeoutMs };
    let refusal: RpcError | null = null;
    let first: unknown;
    try {
      const raw = await this.call<RawOutcome>("send_tx", { signed_tx_base64: bytes, wait_until: "FINAL" }, this.sendTimeoutMs, quick);
      if (isFinal(raw)) return decodeOutcome(raw, txHash);
      first = new Error(`transaction ${txHash} was accepted; its outcome is not final yet`);
    } catch (e) {
      first = e;
      if (e instanceof RpcError) {
        if (DUPLICATE.test(e.message)) {
          // Pending: look it up below.
        } else if (/InvalidNonce/.test(e.message) && e.after.some((f) => f.maybeDelivered)) {
          refusal = e;
        } else {
          throw e;
        }
      } else if (!(e instanceof RpcUnavailable && e.attempts.some((f) => f.maybeDelivered))) {
        throw e;
      }
    }
    let unknown = 0;
    let resent = false;
    let last: unknown = first;
    for (let i = 0; i < polls; i++) {
      await this.#sleep(pollMs);
      try {
        const raw = await this.call<RawOutcome>("tx", { tx_hash: txHash, sender_account_id: senderId, wait_until: "NONE" });
        unknown = 0;
        if (isFinal(raw)) return decodeOutcome(raw, txHash);
        last = new Error(`transaction ${txHash} is ${raw.final_execution_status ?? "pending"}`);
      } catch (err) {
        last = err;
        // The caller's own error (out of budget, say) stops the lookups, but the transaction
        // may have landed: report it as unknown, never as failed.
        if (!(err instanceof RpcError || err instanceof RpcUnavailable)) throw new TxStatusUnknown(txHash, i + 1, err);
        if (!(err instanceof RpcError && err.code === "UNKNOWN_TRANSACTION")) continue;
        if (refusal) throw refusal; // nobody has it: the nonce was taken by another transaction
        if (++unknown < 2 || resent) continue;
        resent = true;
        try {
          await this.call("send_tx", quick.params);
        } catch (again) {
          if (!(again instanceof RpcError || again instanceof RpcUnavailable)) throw new TxStatusUnknown(txHash, i + 1, again);
          if (again instanceof RpcError && !DUPLICATE.test(again.message)) throw again;
          last = again;
        }
      }
    }
    throw new TxStatusUnknown(txHash, polls, last);
  }
}

/** A sent transaction whose outcome could not be learned: it may have landed or may still
 * land. Not a failure: report it as unknown and do not sign it again. */
export class TxStatusUnknown extends Error {
  override readonly name = "TxStatusUnknown";
  readonly txHash: string;

  constructor(txHash: string, lookups: number, last: unknown) {
    super(`transaction ${txHash}: outcome not known after ${lookups} lookups, it may still land (last: ${last instanceof Error ? last.message : String(last)})`);
    this.txHash = txHash;
  }
}

/** Executed in final blocks: the outcome cannot change. Nodes without
 * `final_execution_status` only answer once it is final. */
function isFinal(raw: RawOutcome): boolean {
  const level = raw.final_execution_status;
  if (level !== undefined && level !== "EXECUTED" && level !== "FINAL") return false;
  return typeof raw.status === "object" && raw.status !== null && Array.isArray(raw.receipts_outcome) && raw.transaction_outcome !== undefined;
}

/** An answer meaning the node already has this transaction. */
const DUPLICATE = /already (known|exists|processed|in the pool)|duplicate/i;

interface JsonRpcError {
  name?: string;
  message?: string;
  code?: number;
  cause?: { name?: string; info?: unknown };
  data?: unknown;
}

/** The text of a NEAR-shaped error: its cause, then the most specific detail it carries. */
function nearMessage(err: JsonRpcError): string {
  const detail = err.data ?? err.cause?.info ?? err.message;
  const text = typeof detail === "string" ? detail : detail === undefined ? "no detail" : JSON.stringify(detail);
  return `${err.cause?.name ?? err.name}: ${text}`;
}

type ExecStatus = { SuccessValue: string } | { SuccessReceiptId: string } | { Failure: unknown } | "Unknown" | "Pending";

interface RawOutcome {
  /** NONE, INCLUDED, INCLUDED_FINAL, EXECUTED_OPTIMISTIC, EXECUTED or FINAL. */
  final_execution_status?: string;
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

/** Retries after an `InvalidNonce` refusal. */
export const NONCE_RETRIES = 3;

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
    return this.functionCalls(receiverId, [{ methodName, args, gas, deposit }]);
  }

  /** Several function calls to one receiver in one transaction: they run in order and land
   * together or not at all. The outcome's `result` is the last call's return value. */
  functionCalls(receiverId: string, calls: readonly { methodName: string; args: object; gas: bigint; deposit: bigint }[]): Promise<TxOutcome> {
    if (calls.length === 0) throw new Error("a transaction needs at least one call");
    const run = () => this.#send(receiverId, calls);
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #send(receiverId: string, calls: readonly { methodName: string; args: object; gas: bigint; deposit: bigint }[]): Promise<TxOutcome> {
    for (let attempt = 0; ; attempt++) {
      const ak = await this.rpc.viewAccessKey(this.accountId, this.key.publicKeyString);
      const nonce = (BigInt(ak.nonce) > this.#nonce ? BigInt(ak.nonce) : this.#nonce) + 1n;
      const tx = {
        signerId: this.accountId,
        publicKey: this.key.publicKey,
        nonce,
        receiverId,
        blockHash: base58Decode(ak.block_hash),
        actions: calls.map((c) => ({ methodName: c.methodName, args: utf8Encode(JSON.stringify(c.args)), gas: c.gas, deposit: c.deposit })),
      };
      const { hash, signed } = await signTransaction(tx, this.key);
      this.#nonce = nonce;
      try {
        return await this.rpc.sendTx(signed, base58Encode(hash), this.accountId);
      } catch (e) {
        // Another signer used the key in between: retry with a fresh nonce, up to three times.
        // The error names the key's nonce on chain; start above it even if the node we read
        // the access key from lags behind.
        const text = e instanceof Error ? e.message : String(e);
        if (attempt >= NONCE_RETRIES || !/InvalidNonce/.test(text)) throw e;
        const onChain = /"ak_nonce":\s*(\d+)/.exec(text);
        if (onChain && BigInt(onChain[1]!) > this.#nonce) this.#nonce = BigInt(onChain[1]!);
      }
    }
  }
}
