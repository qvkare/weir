// A fast-preset market on the engine model, eight funded agents, three reporters, and a fake
// fetch that serves the index package's saved source responses.
import { readFileSync } from "node:fs";
import { PRESETS } from "@weir/agents";
import { ModelWeir, paramsFromWire } from "@weir/chain";
import { auctionOpen, Market, type WireParams } from "@weir/engine";
import { SOURCES } from "@weir/index";
import { readSecrets, type AgentSpec, type Deployments, type Secrets } from "../src/config.ts";
import { runTick, type KeeperEnv, type TickReport } from "../src/keeper.ts";
import { modelChain } from "../src/model.ts";
import type { Fetch } from "../src/ports.ts";
import { MemoryStore } from "../src/store.ts";
import { timeParams } from "@weir/agents";

export const CONTRACT = "weir-fast.test";
export const REPORTERS = ["rep-a.test", "rep-b.test", "rep-c.test"];
export const PARAMS: WireParams = { ...PRESETS.fast, usdc: "usdc.test", reporters: [...REPORTERS], t0: PRESETS.fast.t0 };
export const TP = timeParams(PARAMS);

export const DEPLOYMENTS: Deployments = {
  network: "model",
  rpc: ["https://rpc.invalid"],
  explorer: "https://explorer.invalid",
  bundles_base: null,
  markets: [{ id: "fast", label: "Fast (test)", contract: CONTRACT, usdc: "usdc.test" }],
};

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

export const TOTAL_DEPOSIT = AGENTS.reduce((s, a) => s + a.deposit, 0n);

export const secretVars = () => ({
  REPORTERS: JSON.stringify(REPORTERS.map((id) => ({ account_id: id, secret_key: fakeKey(id) }))),
  AGENTS: JSON.stringify(AGENTS.map(({ deposit: _d, ...a }) => a)),
  SWARM_SECRET,
});

const FIXTURES = new URL("../../index/test/fixtures/", import.meta.url);
export const fixtureBody = (id: string) => readFileSync(new URL(`${id}.json`, FIXTURES), "utf8");

/** Serves the saved responses by URL; ids in `failing` answer HTTP 503. Counts every call. */
export class FakeSources {
  failing = new Set<string>();
  calls: string[] = [];
  readonly #bodies = new Map(SOURCES.map((s) => [s.url, { id: s.id, body: fixtureBody(s.id) }]));

  readonly fetch: Fetch = async (url) => {
    this.calls.push(url);
    const hit = this.#bodies.get(url);
    if (!hit) return new Response("not found", { status: 404 });
    if (this.failing.has(hit.id)) return new Response("unavailable", { status: 503 });
    return new Response(hit.body, { status: 200, headers: { "content-type": "application/json" } });
  };
}

export interface World {
  model: ModelWeir;
  store: MemoryStore;
  sources: FakeSources;
  secrets: Secrets;
  env: (extra?: Partial<KeeperEnv>) => KeeperEnv;
  /** Sets the model's clock and the keeper's wall clock to `t`. */
  setTime: (t: number) => void;
  /** Sets both clocks to `t` and runs one tick. */
  at: (t: number, extra?: Partial<KeeperEnv>) => Promise<TickReport>;
}

/** Market time when the world starts: one minute into round 2 of series 0's auction, so that
 * three hours later series 1 has settled (at delivery end plus the report grace) five minutes ago. */
export const START = auctionOpen(TP, 0) + 660;

export function world(start = START): World {
  const model = new ModelWeir(new Market(paramsFromWire(PARAMS), start), "keeper-viewer");
  for (const a of AGENTS) {
    model.as(a.account_id).sync.change("register", {});
    model.as(a.account_id).sync.change("deposit", { amount: a.deposit.toString() });
  }
  const store = new MemoryStore();
  const sources = new FakeSources();
  const secrets = readSecrets(secretVars());
  const chain = modelChain({ [CONTRACT]: model });
  let wall = start;
  const env = (extra: Partial<KeeperEnv> = {}): KeeperEnv => ({
    deployments: DEPLOYMENTS,
    store,
    secrets,
    fetch: sources.fetch,
    chain,
    wallNow: () => wall,
    leaseConfirmMs: 0,
    ...extra,
  });
  const setTime = (t: number) => {
    model.setTime(t);
    wall = t;
  };
  const at = async (t: number, extra: Partial<KeeperEnv> = {}) => {
    setTime(t);
    return runTick(env(extra), t);
  };
  return { model, store, sources, secrets, env, setTime, at };
}
