// One door for every contract view: the chain (JSON-RPC through lib/near.ts), the model
// (WEIR_MODEL=1, the engine in this process) or nothing (no market deployed). Server only.
import type { ViewMethod, ViewMethods } from "@weir/engine";
import { deployments, sourceKind } from "./build.ts";
import { readCache, type Read } from "./cache.ts";
import type { MarketId } from "./config.ts";
import { accessKeys, viewAccount, viewFunction, type AccessKeyInfo, type AccountState } from "./near.ts";
import { MODEL_AGENTS, modelContract, modelMarket, modelTokenBalance, modelView } from "./model.ts";

/** Views change at most every block; a few seconds of cache keeps a burst of visitors to one read. */
const views = readCache(4_000);
const slow = readCache(60_000);

export type SourceKind = "chain" | "model" | "none";

export interface Source {
  kind: SourceKind;
  market: MarketId;
  contract: string | null;
  view<M extends ViewMethod>(method: M, args: ViewMethods[M]["args"]): Promise<Read<ViewMethods[M]["result"]>>;
  /** Unix seconds by the source's clock: the model's clock, or this server's. */
  now(): number;
}

const NOT_DEPLOYED = "not deployed";

export function source(market: MarketId): Source {
  const kind = sourceKind(market);
  if (kind === "model") {
    return {
      kind,
      market,
      contract: modelContract(market),
      now: () => modelMarket(market).market.now,
      async view(method, args) {
        try {
          return { ok: true, value: modelView(market, method, args), at: Date.now() };
        } catch (e) {
          return { ok: false, error: (e as Error).message, lastGood: null };
        }
      },
    };
  }
  const d = deployments();
  const contract = d.markets.find((m) => m.id === market)?.contract ?? null;
  if (kind === "none" || !contract) {
    return {
      kind: "none",
      market,
      contract: null,
      now: () => Math.floor(Date.now() / 1000),
      async view() {
        return { ok: false, error: NOT_DEPLOYED, lastGood: null };
      },
    };
  }
  return {
    kind,
    market,
    contract,
    now: () => Math.floor(Date.now() / 1000),
    view: (method, args) => views.read(`${contract}|${method}|${JSON.stringify(args)}`, () => viewFunction(d.rpc, contract, method, args)),
  };
}

export const isNotDeployed = (r: Read<unknown>): boolean => !r.ok && r.error === NOT_DEPLOYED;

/** Access keys of an account. In the model, agents are either function-call only or not. */
export function readKeys(market: MarketId, account: string): Promise<Read<AccessKeyInfo[]>> {
  const kind = sourceKind(market);
  if (kind === "model") {
    const agent = MODEL_AGENTS.find((a) => a.id === account);
    const keys: AccessKeyInfo[] = agent?.functionCallOnly
      ? [{ publicKey: "ed25519:model", permission: { receiver: modelContract(market), methods: ["commit", "reveal", "clear", "mint", "merge", "redeem"], allowance: null } }]
      : agent
        ? [{ publicKey: "ed25519:model", permission: "FullAccess" }]
        : [];
    return Promise.resolve({ ok: true, value: keys, at: Date.now() });
  }
  if (kind === "none") return Promise.resolve({ ok: false, error: NOT_DEPLOYED, lastGood: null });
  return slow.read(`keys|${account}`, () => accessKeys(deployments().rpc, account));
}

export function readAccount(market: MarketId, account: string): Promise<Read<AccountState>> {
  if (sourceKind(market) !== "chain") return Promise.resolve({ ok: false, error: NOT_DEPLOYED, lastGood: null });
  return slow.read(`account|${account}`, () => viewAccount(deployments().rpc, account));
}

/** The contract's USDC balance: `ft_balance_of` on the token, or the model's own count. */
export function readTokenBalance(market: MarketId, token: string, contract: string): Promise<Read<string>> {
  const kind = sourceKind(market);
  if (kind === "model") return Promise.resolve({ ok: true, value: modelTokenBalance(market).toString(), at: Date.now() });
  if (kind === "none") return Promise.resolve({ ok: false, error: NOT_DEPLOYED, lastGood: null });
  return views.read(`ft|${token}|${contract}`, () => viewFunction<string>(deployments().rpc, token, "ft_balance_of", { account_id: contract }));
}
