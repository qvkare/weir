// The Worker's routes through the keeper's Durable Object (on fake storage), the object's
// alarm with bad keys and the network down, and recognisable fake keys.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { sha256Hex } from "@weir/index";
import { readSecrets } from "../src/config.ts";
import { handle } from "../src/routes.ts";
import { KeeperObject } from "../src/durable.ts";
import { KEYS, MemoryStore } from "../src/store.ts";
import worker, { type Env } from "../src/worker.ts";
import { Clock, fakeObject, workerEnv } from "./fakes.ts";
import { deploymentsFor, fakeKey, IDS, KEEPER_ACCOUNT, REPORTERS, secretVars, START, SWARM_SECRET, world } from "./harness.ts";

interface StatusBody {
  config: { market?: string; text: string }[];
  log: { text: string }[];
}

const BASE = "https://weir-keeper.example.workers.dev";
const get = (path: string, env: Env, method = "GET") => worker.fetch(new Request(`${BASE}${path}`, { method }), env);

/** Every secret a leak test looks for: whole keys, their base58 bodies, and the swarm secret. */
const SECRETS = [...REPORTERS, KEEPER_ACCOUNT, "buyer-1.test", "seller-2.test", "noise-2.test"].flatMap((id) => [fakeKey(id), fakeKey(id).slice(8)]).concat(SWARM_SECRET, "FAKESECRETKEY");

function assertNoSecret(text: string, where: string): void {
  for (const s of SECRETS) assert.ok(!text.includes(s), `${where} contains a secret (${s.slice(0, 16)}...)`);
}

/** Fifteen minutes of ticks on the model, written to the object's SQL store; the object's
 * clock stands at the last tick. */
async function ranWorld() {
  const w = world();
  const clock = new Clock((START + 15 * 60) * 1000);
  const o = fakeObject(secretVars(), { clock, deployments: deploymentsFor(IDS) });
  for (let t = START; t <= START + 15 * 60; t += 60) await w.at(t, { store: o.object.store });
  return { w, clock, ...o, store: o.object.store, env: workerEnv(o.object, secretVars()).env };
}

test("GET /bundles/<hash>.json: the stored canonical bundle, immutable, its sha256 is its name", async () => {
  const { store, env } = await ranWorld();
  const latest = (JSON.parse((await store.get(KEYS.latest))!) as Record<string, { hash: string }>).h200!;
  const res = await get(`/bundles/${latest.hash}.json`, env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.match(res.headers.get("content-type")!, /^application\/json/);
  const body = await res.text();
  assert.equal(await sha256Hex(body), latest.hash);
  assert.equal(JSON.parse(body).index, 4_250_000);
  assert.equal(JSON.parse(body).chip, "h200");

  const missing = await get(`/bundles/${"0".repeat(64)}.json`, env);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("access-control-allow-origin"), "*");
  assert.equal(missing.headers.get("cache-control"), "no-store");
  for (const bad of ["/bundles/ABC.json", `/bundles/${"g".repeat(64)}.json`, `/bundles/${latest.hash}`]) assert.equal((await get(bad, env)).status, 404, bad);
});

test("GET /latest.json, /status, /health, unknown paths, OPTIONS and other methods", async () => {
  const { w, store, env, clock } = await ranWorld();
  const latest = await get("/latest.json", env);
  assert.equal(latest.status, 200);
  assert.equal(latest.headers.get("cache-control"), "public, max-age=30");
  const stored = JSON.parse((await store.get(KEYS.latest))!) as Record<string, { hash: string }>;
  const body = (await latest.json()) as { chip: string; hash: string; bundle: { index: number; chip: string } };
  assert.deepEqual([body.chip, body.hash, body.bundle.index, body.bundle.chip], ["h100", stored.h100!.hash, 2_900_000, "h100"]);
  for (const [chip, index] of [["h200", 4_250_000], ["a100-80", 1_590_000]] as const) {
    const r = (await (await get(`/latest.json?chip=${chip}`, env)).json()) as { hash: string; bundle: { index: number } };
    assert.deepEqual([r.hash, r.bundle.index], [stored[chip]!.hash, index]);
  }
  assert.equal((await get("/latest.json?chip=b200", env)).status, 404);

  const status = await get("/status", env);
  assert.equal(status.status, 200);
  assert.equal(status.headers.get("cache-control"), "no-store");
  assert.equal(status.headers.get("access-control-allow-origin"), "*");
  const s = (await status.json()) as { last_tick: number; operator_note: string; log: unknown[]; markets: Record<string, { contract: string }> };
  assert.equal(s.last_tick, START + 15 * 60);
  assert.match(s.operator_note, /run by this one keeper, from the same fetch/);
  assert.equal(s.log.length, 50);
  assert.deepEqual(Object.keys(s.markets).sort(), [...IDS].sort());
  assert.equal(s.markets["h100-fast"]?.contract, "weir-h100-fast.test");
  assert.ok(BigInt((s.markets["h100-fast"] as unknown as { costs: { fees: string } }).costs.fees) > 0n, "fees shown");

  // /health against the object's clock: fresh 30 s after the last tick, stale after 300 s.
  clock.ms = (START + 15 * 60 + 30) * 1000;
  const fresh = await get("/health", env);
  assert.equal(fresh.status, 200);
  assert.deepEqual(await fresh.json(), { ok: true, last_tick: START + 15 * 60, age_secs: 30 });
  clock.ms = (START + 15 * 60 + 301) * 1000;
  assert.equal((await get("/health", env)).status, 503);
  assert.equal((await handle(new Request(`${BASE}/health`), w.store, START + 15 * 60 + 30)).status, 503, "the world's own store was not used");
  assert.equal((await handle(new Request(`${BASE}/health`), new MemoryStore())).status, 503);

  assert.equal((await get("/nope", env)).status, 404);
  const pre = await get("/status", env, "OPTIONS");
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-methods"), "GET, HEAD, OPTIONS");
  for (const m of ["POST", "PUT", "DELETE"]) {
    const r = await get("/status", env, m);
    assert.equal(r.status, 405, m);
    assert.equal(r.headers.get("allow"), "GET, HEAD, OPTIONS");
  }
  const head = await get("/latest.json", env, "HEAD");
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");

  const empty = workerEnv(fakeObject({}, { clock: new Clock(Date.now()) }).object).env;
  assert.equal((await get("/latest.json", empty)).status, 404);
  assert.equal((await get("/status", empty)).status, 200);
});

test("no secret ever reaches /status or the store, even when keys are bad and the network is down", async () => {
  // 1. A normal run on the model with the fake keys configured.
  const { store, storage, env, clock } = await ranWorld();
  // 2. The real alarm path: bad keys (they are not base58 keys), malformed JSON in one secret, every request failing.
  const realFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    return new Response("down", { status: 503 });
  }) as typeof fetch;
  try {
    // The object restarted with new secrets (as a `wrangler secret` change does), on the same storage.
    const bad = new KeeperObject({ storage }, { ...secretVars(), AGENTS: `${secretVars().AGENTS.slice(0, 120)}` }, { deployments: deploymentsFor(IDS), nowMs: clock.now });
    clock.ms = (START + 3600) * 1000;
    const lease = await store.get(KEYS.lease); // written by the world's own ticks, which take the lease
    await bad.alarm();
    assert.equal(bad.last?.now, START + 3600);
    const afterCron = await (await get("/status", env)).text();
    assertNoSecret(afterCron, "/status after the cron run");
    const s1 = JSON.parse(afterCron) as StatusBody;
    assert.ok(s1.config.some((c) => c.text === "AGENTS is not valid JSON" && c.market === undefined), "the malformed secret is a configuration problem");
    assert.ok(s1.config.some((c) => c.market === "h100-fast" && /keeper\.test \(keeper\) not used on h100-fast/.test(c.text)), "a key that does not parse is one too");
    assert.equal(await store.get(KEYS.lease), lease, "the object takes no lease");
    // The secret mended: that problem no longer holds and leaves `config`, the bad keys stay.
    const mended = new KeeperObject({ storage }, secretVars(), { deployments: deploymentsFor(IDS), nowMs: clock.now });
    clock.ms = (START + 3660) * 1000;
    await mended.alarm();
    const report = mended.last!;
    assert.ok(report.budget.used <= 40);
    assert.ok(report.entries.some((e) => e.action === "config" && e.status === "failed"), "bad keys are reported");
    assert.ok(report.entries.some((e) => /market not run this tick/.test(e.text)), "the unreachable chain is reported");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(requests > 0 && requests <= 80);
  const secrets = readSecrets({ ...secretVars(), AGENTS: `${secretVars().AGENTS.slice(0, 120)}` });
  assert.deepEqual(secrets.problems, ["AGENTS is not valid JSON"]);
  const status = await (await get("/status", env)).text();
  const s2 = JSON.parse(status) as StatusBody;
  assert.ok(!s2.config.some((c) => /AGENTS is not valid JSON/.test(c.text)), "a problem that no longer holds is not shown");
  assert.equal(s2.config.filter((c) => /\(agent\) not used on/.test(c.text)).length, 32, "eight agents on four markets, each key unreadable");
  assertNoSecret(status, "/status");
  for (const { key } of store.sizes()) assertNoSecret((await store.get(key))!, `store key ${key}`);
  for (const path of ["/latest.json", "/health"]) assertNoSecret(await (await get(path, env)).text(), path);
});

test("src/ is portable: nothing but node.ts imports a Node built-in or uses Node globals", () => {
  const dir = new URL("../src/", import.meta.url);
  for (const name of readdirSync(dir)) {
    if (name === "node.ts") continue;
    assert.doesNotMatch(readFileSync(new URL(name, dir), "utf8"), /from\s+["']node:|require\(|process\.|Buffer\./, name);
  }
});

test("a configuration problem stays in /status for as long as it holds, however much is logged after it", async () => {
  const vars = secretVars();
  const agents = JSON.parse(vars.AGENTS) as object[];
  const typo = { account_id: "typo.test", role: "trader", market: "h100-fast", secret_key: fakeKey("typo.test") };
  // Sixty agents with a key for another contract only: sixty "cannot act" lines every tick,
  // all logged after the typo, more than the 50 entries /status shows.
  const keyless = Array.from({ length: 60 }, (_, i) => ({ account_id: `keyless-${i}.test`, role: "noise", market: "h100-fast", keys: { "elsewhere.test": fakeKey(`keyless-${i}`) } }));
  const w = world({ vars: { ...vars, AGENTS: JSON.stringify([...agents, typo, ...keyless]) } });
  const problem = `AGENTS[${agents.length}] (typo.test): role must be buyer, seller, maker or noise`;
  const status = async () => (await (await handle(new Request(`${BASE}/status`), w.store)).json()) as StatusBody;
  for (let t = START; t <= START + 5 * 60; t += 60) {
    await w.at(t);
    const s = await status();
    assert.ok(!s.log.some((e) => e.text === problem), `at ${t} the last 50 log entries no longer hold it`);
    assert.deepEqual(s.config[0], { text: problem }, `config at ${t}`);
    assert.equal(s.config.filter((c) => c.market === "h100-fast" && /keyless-\d+\.test \(agent\) cannot act on h100-fast/.test(c.text)).length, 60);
  }
  // Mended, both are gone at the next tick.
  await w.at(START + 6 * 60, { secrets: readSecrets(vars) });
  assert.deepEqual((await status()).config, []);
});

test("with no secrets set, /status lists them as configuration problems and nothing is signed", async () => {
  assert.deepEqual(readSecrets({}).problems, ["REPORTERS is not set: no price is reported", "AGENTS is not set: no agent trades"]);
  const w = world({ markets: ["h100-fast"] });
  const clock = new Clock(START * 1000);
  const { object, fire } = fakeObject({}, { clock, deployments: w.deployments, chain: w.chain, fetch: w.sources.fetch });
  w.setTime(START);
  await fire();
  assert.equal(object.last!.txs.length, 0);
  const s = (await (await get("/status", workerEnv(object).env)).json()) as StatusBody;
  assert.deepEqual(s.config.map((c) => c.text), ["REPORTERS is not set: no price is reported", "AGENTS is not set: no agent trades"]);
});
