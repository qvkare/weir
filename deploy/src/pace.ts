// A `fetch` for `NearRpc` that paces itself against a public endpoint's rate limit. Measured on
// 2026-11-12 against https://archival-rpc.testnet.fastnear.com: 5 `tx` lookups in a row answered
// 200, the next 20 answered HTTP 429 with `retry-after: 0`, and the endpoint answered 200 again
// within 5 s. Without pacing, `NearRpc` treats a 429 as an outage and fails over at once, so one
// refusal became a failure (`verify --txs` reported "not checked" after 210 s on 2026-11-12).
//
// Here a 429 (or 503) is waited out on the same endpoint: `retry-after` seconds when the endpoint
// gives a positive one, else 1, 2, 4, 8, 16 s, ..., capped at 30 s per wait and `maxWaitMs` in all
// per request. Only then is the refusal handed to `NearRpc`, which fails over to the next URL.
// Requests to one host are also spaced by at least `minGapMs`. Network errors pass straight through.
//
// Each try has its own timeout (`timeoutMs`, or `longTimeoutMs` for `send_tx`, `tx` and
// `broadcast_tx_commit`, which wait on the chain), and the caller's signal is not used: `NearRpc`'s
// own timer would otherwise count the waits. Give `NearRpc` a timeout longer than any try plus
// `maxWaitMs` (`rpcFor` does). A try that times out throws "<url> timed out after <n> ms", the
// text `NearRpc` recognises, so a slow `send_tx` is still followed by polling `tx`.
import type { FetchLike } from "../../chain/src/near.ts";

export interface PaceOptions {
  /** Minimum time between two requests to the same host. Default 100 ms. */
  minGapMs?: number;
  /** Longest time one request may spend waiting out refusals. Default 90 s. */
  maxWaitMs?: number;
  /** Per try. Default 20 s; 60 s for the calls that wait on the chain. */
  timeoutMs?: number;
  longTimeoutMs?: number;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Told about each wait, for logging. */
  onWait?: (url: string, status: number, ms: number) => void;
}

type Reply = Awaited<ReturnType<FetchLike>> & { headers?: { get(name: string): string | null } };

export function pacedFetch(opts: PaceOptions = {}): FetchLike {
  const inner: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const minGap = opts.minGapMs ?? 100;
  const maxWait = opts.maxWaitMs ?? 90_000;
  const timeout = opts.timeoutMs ?? 20_000;
  const longTimeout = opts.longTimeoutMs ?? 60_000;
  const last = new Map<string, number>();
  const host = (url: string) => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  };
  return async (url, init) => {
    const h = host(url);
    let waited = 0;
    for (let attempt = 0; ; attempt++) {
      const since = now() - (last.get(h) ?? -Infinity);
      if (since < minGap) await sleep(minGap - since);
      last.set(h, now());
      const ms0 = /"method":"(send_tx|tx|broadcast_tx_commit)"/.test(init.body) ? longTimeout : timeout;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ms0);
      let res: Reply;
      try {
        res = (await inner(url, { ...init, signal: controller.signal })) as Reply;
        if (res.status !== 429 && res.status !== 503) {
          // Read the body inside the timeout, so a stalled body is a timeout too.
          const text = await res.text();
          return { status: res.status, text: async () => text };
        }
      } catch (e) {
        if (controller.signal.aborted) throw new Error(`${url} timed out after ${ms0} ms`);
        throw e;
      } finally {
        clearTimeout(timer);
      }
      await res.text().catch(() => "");
      const ra = Number(res.headers?.get("retry-after") ?? "");
      const ms = Math.min(30_000, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt);
      if (waited + ms > maxWait) return res;
      opts.onWait?.(url, res.status, ms);
      await sleep(ms);
      waited += ms;
    }
  };
}
