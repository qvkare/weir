// Four markets, one per entry of the agents package's `MARKETS`, each on its own engine model,
// eight funded agents on every one, three reporters, an optional housekeeping account, and a
// fake fetch that serves the index package's saved responses for every chip.
import { readFileSync } from "node:fs";
import { MARKETS, SIM_T0, timeParams, type MarketId } from "@weir/agents";
import { ModelWeir, paramsFromWire } from "@weir/chain";
import { auctionOpen, Market, type TimeParams, type WireParams } from "@weir/engine";
import { CHIP_IDS, CHIPS, sourcesFor, type ChipId } from "@weir/index";
import { readSecrets, type AgentSpec, type Deployments, type MarketDeployment, type Secrets } from "../src/config.ts";
import { runTick, type KeeperEnv, type TickReport } from "../src/keeper.ts";
import { modelChain, type ModelKey } from "../src/model.ts";
import type { Fetch } from "../src/ports.ts";
import { MemoryStore } from "../src/store.ts";

export const REPORTERS = ["rep-a.test", "rep-b.test", "rep-c.test"];
export const KEEPER_ACCOUNT = "keeper.test";

/** The fast market's series 0 is delivered from SIM_T0; the weekly markets' series 0 a week
 * later, so their first auction opens an hour before the fast one's and runs all three hours. */
const T0: Record<MarketId, number> = {
  "h100-fast": SIM_T0,
  "h100-weekly": SIM_T0 + 7 * 86_400,
  "h200-weekly": SIM_T0 + 7 * 86_400,
  "a100-80-weekly": SIM_T0 + 7 * 86_400,
};

export const IDS = Object.keys(MARKETS) as MarketId[];
export const contractOf = (id: MarketId) => `weir-${id}.test`;
export const paramsOf = (id: MarketId, preset?: "fast"): WireParams =>
  preset === "fast"
    ? { ...MARKETS["h100-fast"].params, underlying: MARKETS[id].underlying, usdc: "usdc.test", reporters: [...REPORTERS], t0: T0["h100-fast"] }
    : { ...MARKETS[id].params, usdc: "usdc.test", reporters: [...REPORTERS], t0: T0[id] };
export const tpOf = (id: MarketId): TimeParams => timeParams(paramsOf(id));
export const FAST: MarketId = "h100-fast";
export const PARAMS = paramsOf(FAST);
export const TP = tpOf(FAST);

export const deploymentsFor = (ids: readonly MarketId[]): Deployments => ({
  network: "model",
  rpc: ["https://rpc.invalid"],
  explorer: "https://explorer.invalid",
  bundles_base: null,
  markets: ids.map((id): MarketDeployment => ({ id, label: MARKETS[id].label, chip: MARKETS[id].chip, contract: contractOf(id), usdc: "usdc.test" })),
});

/** Recognisable fake keys: a test greps for them in everything the keeper serves. */
export const fakeKey = (who: string) => `ed25519:FAKESECRETKEY${who.replace(/[^a-z0-9]/gi, "")}ZZZZZZZZZZZZZZZZ`;
export const SWARM_SECRET = "FAKESWARMSECRET-do-not-leak-0123456789";

export const AGENTS: (AgentSpec & { deposit: bigint })[] = [
  { account_id: "buyer-1.test", role: "buyer", need: 40, premium_bps: 400, deposit: 60_000_000n },
  { account_id: "buyer-2.test", role: "buyer", need: 30, premium_bps: 600, deposit: 60_000_000n },
  { account_id: "buyer-3.test", role: "buyer", need: 50, premium_bps: 300, deposit: 60_000_000n },
  { account_id: "seller-1.test", role: "seller", capacity: 150, premium_bps: 300, deposit: 200_000_000n },
  { account_id: "seller-2.test", role: "seller", capacity: 120, premium_bps: 500, deposit: 200_000_000n },
  { account_id: "maker-1.test", role: "maker", spread_bps: 500, share_bps: 1000, max_size: 30, deposit: 400_000_000n },
  { account_id: "noise-1.test", role: "noise", deposit: 30_000_000n },
  { account_id: "noise-2.test", role: "noise", deposit: 30_000_000n },
].map((a) => ({ ...a, secret_key: fakeKey(a.account_id) }) as AgentSpec & { deposit: bigint });

/** Deposited on each market. */
export const TOTAL_DEPOSIT = AGENTS.reduce((s, a) => s + a.deposit, 0n);

export const secretVars = (opts: { reporters?: readonly string[]; keeper?: boolean } = {}) => ({
  REPORTERS: JSON.stringify((opts.reporters ?? REPORTERS).map((id) => ({ account_id: id, secret_key: fakeKey(id) }))),
  AGENTS: JSON.stringify(AGENTS.map(({ deposit: _d, ...a }) => a)),
  SWARM_SECRET,
  ...(opts.keeper === false ? {} : { KEEPER: JSON.stringify({ account_id: KEEPER_ACCOUNT, secret_key: fakeKey(KEEPER_ACCOUNT) }) }),
});

const FIXTURES = new URL("../../index/test/fixtures/", import.meta.url);
/** The second day's saved body for a source and chip (Verda's equals the first day's). */
export const fixtureBody = (sourceId: string, chip: ChipId): string =>
  readFileSync(new URL(sourceId === "verda" ? "verda.json" : sourceId === "vast" ? `v2/vast-${chip}.json` : `v2/${sourceId}.json`, FIXTURES), "utf8");

/** Serves the saved responses by request; source ids in `failing` answer HTTP 503. Counts every call. */
export class FakeSources {
  failing = new Set<string>();
  calls: string[] = [];
  readonly #bodies = new Map<string, { id: string; body: string }>();

  constructor() {
    for (const chip of CHIP_IDS) for (const s of sourcesFor(CHIPS[chip])) this.#bodies.set(`${s.url}\n${s.body ?? ""}`, { id: s.id, body: fixtureBody(s.id, chip) });
  }

  readonly fetch: Fetch = async (url, init) => {
    this.calls.push(url);
    const hit = this.#bodies.get(`${url}\n${typeof init?.body === "string" ? init.body : ""}`);
    if (!hit) return new Response("not found", { status: 404 });
    if (this.failing.has(hit.id)) return new Response("unavailable", { status: 503 });
    return new Response(hit.body, { status: 200, headers: { "content-type": "application/json" } });
  };
}

export interface World {
  models: Record<MarketId, ModelWeir>;
  model: ModelWeir;
  chain: ReturnType<typeof modelChain>;
  store: MemoryStore;
  sources: FakeSources;
  secrets: Secrets;
  deployments: Deployments;
  env: (extra?: Partial<KeeperEnv>) => KeeperEnv;
  /** Sets every model's clock and the keeper's wall clock to `t`. */
  setTime: (t: number) => void;
  /** Sets the clocks to `t` and runs one tick. */
  at: (t: number, extra?: Partial<KeeperEnv>) => Promise<TickReport>;
}

/** Market time when the world starts: one minute into round 2 of the fast market's series 0,
 * so that three hours later its series 1 settled (at delivery end plus the report grace) five minutes ago. */
export const START = auctionOpen(TP, 0) + 660;

export interface WorldOptions {
  markets?: readonly MarketId[];
  start?: number;
  reporters?: readonly string[];
  keeper?: boolean;
  /** Markets run on the fast preset whatever their id. */
  fast?: readonly MarketId[];
  /** Secret variables instead of the default ones. */
  vars?: Record<string, string>;
  /** Keys the transport enforces, by secret key. */
  keys?: Record<string, ModelKey>;
}

export function world(opts: WorldOptions = {}): World {
  const start = opts.start ?? START;
  const ids = opts.markets ?? IDS;
  const models = {} as Record<MarketId, ModelWeir>;
  for (const id of ids) {
    const model = new ModelWeir(new Market(paramsFromWire(paramsOf(id, opts.fast?.includes(id) ? "fast" : undefined)), start), "keeper-viewer");
    for (const a of AGENTS) {
      model.as(a.account_id).sync.change("register", {});
      model.as(a.account_id).sync.change("deposit", { amount: a.deposit.toString() });
    }
    models[id] = model;
  }
  const store = new MemoryStore();
  const sources = new FakeSources();
  const secrets = readSecrets(opts.vars ?? secretVars(opts));
  const deployments = deploymentsFor(ids);
  const chain = modelChain(Object.fromEntries(ids.map((id) => [contractOf(id), models[id]])), opts.keys ?? {});
  let wall = start;
  const env = (extra: Partial<KeeperEnv> = {}): KeeperEnv => ({
    deployments,
    store,
    secrets,
    fetch: sources.fetch,
    chain,
    wallNow: () => wall,
    leaseConfirmMs: 0,
    ...extra,
  });
  const setTime = (t: number) => {
    for (const id of ids) models[id].setTime(t);
    wall = t;
  };
  const at = async (t: number, extra: Partial<KeeperEnv> = {}) => {
    setTime(t);
    return runTick(env(extra), t);
  };
  return { models, model: models[ids[0]!], chain, store, sources, secrets, deployments, env, setTime, at };
}
