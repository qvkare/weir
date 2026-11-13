// The NEAR testnet faucet that creates a named top-level account for a public key, as
// near-cli-rs's `account create-account sponsor-by-faucet-service` does. Portable: the
// transport, clock and sleep are passed in, so it runs in Node and in browsers.
//
// The request and the answer are as `deploy/src/chain.ts` (`faucetCreator`) documents them,
// read from near-cli-rs (github.com/near/near-cli-rs, commit 5cdedc38): a POST to
// https://helper.nearprotocol.com/account with `{ newAccountId, newAccountPublicKey }`; a
// status of 400 or more is a failure; the body is the final execution outcome of the
// creating transaction, whose `SuccessValue` "false" means the account was not created.
// The retry rule is the same as the deploy tool's: HTTP 429 and 5xx and network errors are
// retried after 15 s, then 30 s, 60 s, 120 s (or the `retry-after` the faucet sends, if
// longer); any other 4xx is a refusal and stops at once.
import { decodeOutcome, RpcError, type FetchLike, type NearRpc } from "./near.ts";

export const FAUCET_URL = "https://helper.nearprotocol.com/account";

export interface FaucetOptions {
  fetch: FetchLike;
  /** Milliseconds, any origin. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  url?: string;
  /** How long to keep retrying through rate limits and outages. Default 10 minutes. */
  maxWaitMs?: number;
  /** How long to wait for the new account to be visible on chain. Default 60 s. */
  visibleWaitMs?: number;
  /** Between two reads of the new account. Default 5 s. */
  pollMs?: number;
  /** Told about each retry: what went wrong and how long the wait is. */
  onRetry?: (reason: string, waitMs: number, attempt: number) => void;
}

/** The faucet said no (a 4xx other than 429, a failed transaction, or "false"), or kept
 * failing until the time ran out. `retryable` is true only for the second. */
export class FaucetError extends Error {
  override readonly name = "FaucetError";
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

export const isUnknownAccount = (e: unknown): boolean =>
  e instanceof RpcError && /UNKNOWN_ACCOUNT|does not exist/i.test(`${e.code} ${e.message}`);

/** True when `accountId` exists at final finality. Other errors go up. */
export async function accountExists(rpc: NearRpc, accountId: string): Promise<boolean> {
  try {
    await rpc.viewAccount(accountId);
    return true;
  } catch (e) {
    if (isUnknownAccount(e)) return false;
    throw e;
  }
}

/** Creates `accountId` with full access for `publicKey` (`ed25519:<base58>`) through the
 * faucet, or finds it already created by an earlier request whose answer was lost. Returns
 * the creating transaction's hash when the faucet gave one. */
export async function createWithFaucet(
  rpc: NearRpc,
  accountId: string,
  publicKey: string,
  opts: FaucetOptions,
): Promise<{ hash: string | null; existed: boolean }> {
  const url = opts.url ?? FAUCET_URL;
  const maxWaitMs = opts.maxWaitMs ?? 10 * 60_000;
  const started = opts.now();
  let delay = 15_000;
  for (let attempt = 1; ; attempt++) {
    // A previous attempt may have landed even though its answer was lost.
    if (await accountExists(rpc, accountId)) return { hash: null, existed: true };
    let retry: string;
    try {
      const res = await opts.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: publicKey }),
        signal: new AbortController().signal,
      });
      const text = await res.text();
      const retryAfter = res.headers?.get("retry-after") ?? null;
      if (res.status === 429 || res.status >= 500) {
        retry = `HTTP ${res.status}${retryAfter ? `, retry-after ${retryAfter}` : ""}`;
        const ra = Number(retryAfter);
        if (retryAfter !== null && Number.isFinite(ra) && ra > 0) delay = Math.max(delay, ra * 1000);
      } else if (res.status >= 400) {
        throw new FaucetError(`the faucet refused ${accountId}: HTTP ${res.status}: ${text.slice(0, 300)}`, false);
      } else {
        let outcome: ReturnType<typeof decodeOutcome> | null = null;
        try {
          outcome = decodeOutcome(JSON.parse(text));
        } catch {
          // Not the shape near-cli-rs expects; whether the account exists decides below.
        }
        if (outcome && !outcome.ok) throw new FaucetError(`the faucet's transaction for ${accountId} failed: ${outcome.error}`, false);
        if (outcome && outcome.result === false) {
          throw new FaucetError(`the faucet answered false for ${accountId}: the account was not created (is the name taken?)`, false);
        }
        await waitVisible(rpc, accountId, opts);
        return { hash: outcome?.tx_hash || null, existed: false };
      }
    } catch (e) {
      if (e instanceof FaucetError) throw e;
      retry = `request failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (opts.now() - started + delay > maxWaitMs) {
      throw new FaucetError(`the faucet did not create ${accountId} after ${attempt} attempts (${retry})`, true);
    }
    opts.onRetry?.(retry, delay, attempt + 1);
    await opts.sleep(delay);
    delay = Math.min(delay * 2, 120_000);
  }
}

async function waitVisible(rpc: NearRpc, accountId: string, opts: FaucetOptions): Promise<void> {
  const limit = opts.visibleWaitMs ?? 60_000;
  const pollMs = opts.pollMs ?? 5_000;
  const started = opts.now();
  for (;;) {
    if (await accountExists(rpc, accountId)) return;
    if (opts.now() - started > limit) {
      throw new FaucetError(`the faucet answered, but ${accountId} was not visible on chain after ${Math.round(limit / 1000)} s`, true);
    }
    await opts.sleep(pollMs);
  }
}
