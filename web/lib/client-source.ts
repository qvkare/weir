// Reading the chain from the browser: the visitor's own address and its own rate limits, no
// Worker CPU. The same Source and Reader shapes the build uses, so one loader serves both.
import type { MarketId } from "./config.ts";
import type { Read } from "./cache.ts";
import { accessKeys, viewAccount, viewFunction, type AccessKeyInfo, type AccountState } from "./near.ts";
import type { SiteConfig } from "./site-config.ts";
import { NOT_DEPLOYED, noneSource, type Source } from "./source-types.ts";
import type { Reader } from "./reader.ts";

async function read<T>(load: () => Promise<T>): Promise<Read<T>> {
  try {
    return { ok: true, value: await load(), at: Date.now() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), lastGood: null };
  }
}

/** Contract views straight from the RPC endpoints, deduplicated within one page load. */
export function clientSource(cfg: SiteConfig, market: MarketId): Source {
  const c = cfg.contracts[market];
  if (cfg.mode !== "chain" || !c) return noneSource(market);
  const inflight = new Map<string, Promise<Read<unknown>>>();
  return {
    kind: "chain",
    market,
    contract: c.contract,
    now: () => Math.floor(Date.now() / 1000),
    view(method, args) {
      const key = `${method}|${JSON.stringify(args)}`;
      let p = inflight.get(key);
      if (!p) {
        p = read(() => viewFunction(cfg.rpc, c.contract, method, args));
        inflight.set(key, p);
      }
      return p as never;
    },
  };
}

export function clientReader(cfg: SiteConfig, market: MarketId): Reader {
  const src = clientSource(cfg, market);
  const chain = src.kind === "chain";
  const none = <T,>(): Promise<Read<T>> => Promise.resolve({ ok: false, error: NOT_DEPLOYED, lastGood: null });
  return {
    src,
    keys: (account: string) => (chain ? read<AccessKeyInfo[]>(() => accessKeys(cfg.rpc, account)) : none()),
    account: (account: string) => (chain ? read<AccountState>(() => viewAccount(cfg.rpc, account)) : none()),
    tokenBalance: (token: string, contract: string) => (chain ? read<string>(() => viewFunction<string>(cfg.rpc, token, "ft_balance_of", { account_id: contract })) : none()),
  };
}
