// One door for every contract view: the chain (JSON-RPC through lib/near.ts), the model
// (WEIR_MODEL=1, the engine in this process) or nothing (no market deployed). Server only.
import { deployments, sourceKind } from "./build.ts";
import { readCache, type Read } from "./cache.ts";
import type { MarketId } from "./config.ts";
import { accessKeys, rpcOrder, viewAccount, viewFunction, type AccessKeyInfo, type AccountState } from "./near.ts";
import { MODEL_AGENTS, modelContract, modelMarket, modelTokenBalance, modelView } from "./model.ts";
import { NOT_DEPLOYED, noneSource, type Source } from "./source-types.ts";

export { isNotDeployed, type Source, type SourceKind } from "./source-types.ts";

/** Views change at most every block; a few seconds of cache keeps a burst of visitors to one read. */
const views = readCache(4_000);
const slow = readCache(60_000);

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
  if (kind === "none" || !contract) return noneSource(market);
  const rpc = rpcOrder(d.rpc);
  return {
    kind,
    market,
    contract,
    now: () => Math.floor(Date.now() / 1000),
    view: (method, args) => views.read(`${contract}|${method}|${JSON.stringify(args)}`, () => viewFunction(rpc, contract, method, args)),
  };
}


/** Access keys of an account. In the model, agents are either function-call only or not. */
export function readKeys(market: MarketId, account: string): Promise<Read<AccessKeyInfo[]>> {
  const kind = sourceKind(market);
  if (kind === "model") {
    const agent = MODEL_AGENTS.find((a) => a.id === account);
    const keys: AccessKeyInfo[] = agent?.functionCallOnly
      ? [{ publicKey: "ed25519:model", permission: { receiver: modelContract(market), methods: ["commit", "reveal", "clear", "mint", "merge", "settle", "redeem"], allowance: null } }]
      : agent
        ? [{ publicKey: "ed25519:model", permission: "FullAccess" }]
        : [];
    return Promise.resolve({ ok: true, value: keys, at: Date.now() });
  }
  if (kind === "none") return Promise.resolve({ ok: false, error: NOT_DEPLOYED, lastGood: null });
  return slow.read(`keys|${account}`, () => accessKeys(rpcOrder(deployments().rpc), account));
}

export function readAccount(market: MarketId, account: string): Promise<Read<AccountState>> {
  if (sourceKind(market) !== "chain") return Promise.resolve({ ok: false, error: NOT_DEPLOYED, lastGood: null });
  return slow.read(`account|${account}`, () => viewAccount(rpcOrder(deployments().rpc), account));
}

/** The contract's USDC balance: `ft_balance_of` on the token, or the model's own count. */
export function readTokenBalance(market: MarketId, token: string, contract: string): Promise<Read<string>> {
  const kind = sourceKind(market);
  if (kind === "model") return Promise.resolve({ ok: true, value: modelTokenBalance(market).toString(), at: Date.now() });
  if (kind === "none") return Promise.resolve({ ok: false, error: NOT_DEPLOYED, lastGood: null });
  return views.read(`ft|${token}|${contract}`, () => viewFunction<string>(rpcOrder(deployments().rpc), token, "ft_balance_of", { account_id: contract }));
}

/** The server's reader for a market: views, keys, account state, a token balance. */
export function serverReader(market: MarketId): import("./reader.ts").Reader {
  return {
    src: source(market),
    keys: (account) => readKeys(market, account),
    account: (account) => readAccount(market, account),
    tokenBalance: (token, contract) => readTokenBalance(market, token, contract),
  };
}
