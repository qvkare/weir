// How the deploy tool waits out RPC rate limits. A command-line tool can wait much longer than a
// keeper tick, so it adds one thing to the chain client (`chain/src/near.ts`, "RPC endpoints" in
// chain/README.md): it keeps retrying a call that failed only because every endpoint refused it
// for rate, up to a bound per call. Everything else is the client's own policy:
//
// - a NEAR-shaped error is the node's answer and is never retried here;
// - any other failure moves the call to the next endpoint and puts the failing one on a cooldown
//   (10 s, or its positive `retry-after`, at most 60 s);
// - when every endpoint refused for rate, the client waits once, up to `maxRateWaitMs`, and tries
//   them all again. The deploy tool raises that bound from the client's 2 s to 30 s.
//
// `PatientRpc.call` then retries an `RpcUnavailable` whose every attempt was a rate refusal (or
// that made no attempt because every endpoint was still cooling down after rate refusals), pausing
// 5 s whenever the client made no attempt, until `maxCallWaitMs` has passed since the call began.
// The error it finally throws is the client's `RpcUnavailable` from the last call that reached the
// endpoints, so it names each endpoint and what it said, with how long it waited. A failure that
// is not a rate refusal (no connection, a 5xx, a timeout) is thrown at once: the client has
// already tried every endpoint.
//
// Measured on 2026-11-12 against https://archival-rpc.testnet.fastnear.com: 5 `tx` lookups in a
// row answered 200, the next 20 answered HTTP 429 with `retry-after: 0`, and it answered 200 again
// within 5 s.
//
// `spacedFetch` keeps at least `minGapMs` between two requests to one host, which the client does
// not do.
import { NearRpc, RpcUnavailable, type FetchLike, type RpcOptions } from "../../chain/src/near.ts";

/** The deploy tool's bounds, in milliseconds. */
export const DEPLOY_MAX_RATE_WAIT_MS = 30_000;
export const DEPLOY_MAX_CALL_WAIT_MS = 120_000;
/** Pause before calling again when the client made no attempt (every endpoint still cooling). */
export const COOLING_PAUSE_MS = 5_000;

export interface PatientOptions extends RpcOptions {
  /** How long one call may keep waiting out rate refusals, from its start. Default 120 s. */
  maxCallWaitMs?: number;
}

const rateOnly = (e: RpcUnavailable) => e.attempts.every((a) => a.rateLimited);

/** `NearRpc` that waits out rate limits for up to `maxCallWaitMs` per call. */
export class PatientRpc extends NearRpc {
  readonly maxCallWaitMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(opts: PatientOptions) {
    super({ maxRateWaitMs: DEPLOY_MAX_RATE_WAIT_MS, ...opts });
    this.maxCallWaitMs = opts.maxCallWaitMs ?? DEPLOY_MAX_CALL_WAIT_MS;
    this.#now = opts.now ?? (() => Date.now());
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  override async call<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    const start = this.#now();
    let reached: RpcUnavailable | null = null;
    for (;;) {
      try {
        return await super.call<T>(method, params, timeoutMs);
      } catch (e) {
        if (!(e instanceof RpcUnavailable) || !rateOnly(e)) throw e;
        if (e.attempts.length > 0) reached = e;
        const waited = this.#now() - start;
        if (waited >= this.maxCallWaitMs) {
          const secs = Math.round(waited / 1000);
          throw new RpcUnavailable(method, reached?.attempts ?? [], ` (rate-limited on every endpoint; gave up after ${secs} s of waiting, the bound is ${this.maxCallWaitMs / 1000} s)`);
        }
        if (e.attempts.length === 0) await this.#sleep(Math.min(COOLING_PAUSE_MS, this.maxCallWaitMs - waited));
      }
    }
  }
}

/** A fetch that spaces requests to one host by at least `minGapMs` (default 100 ms). */
export function spacedFetch(opts: { fetch?: FetchLike; minGapMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}): FetchLike {
  const inner: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const minGap = opts.minGapMs ?? 100;
  const last = new Map<string, number>();
  return async (url, init) => {
    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      // not a URL: space by the string itself
    }
    const since = now() - (last.get(host) ?? -Infinity);
    if (since < minGap) await sleep(minGap - since);
    last.set(host, now());
    return inner(url, init);
  };
}
