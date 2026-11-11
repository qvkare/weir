// The Worker's routes and its cron handler, with an in-memory KV and recognisable fake keys.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { sha256Hex } from "@weir/index";
import { readSecrets } from "../src/config.ts";
import { handle } from "../src/routes.ts";
import { KEYS, MemoryStore } from "../src/store.ts";
import worker, { tickOnce, type Env } from "../src/worker.ts";
import { deploymentsFor, fakeKey, IDS, KEEPER_ACCOUNT, REPORTERS, secretVars, START, SWARM_SECRET, world } from "./harness.ts";

const BASE = "https://weir-keeper.example.workers.dev";
const get = (path: string, env: Env, method = "GET") => worker.fetch(new Request(`${BASE}${path}`, { method }), env);

/** Every secret a leak test looks for: whole keys, their base58 bodies, and the swarm secret. */
const SECRETS = [...REPORTERS, KEEPER_ACCOUNT, "buyer-1.test", "seller-2.test", "noise-2.test"].flatMap((id) => [fakeKey(id), fakeKey(id).slice(8)]).concat(SWARM_SECRET, "FAKESECRETKEY");

function assertNoSecret(text: string, where: string): void {
  for (const s of SECRETS) assert.ok(!text.includes(s), `${where} contains a secret (${s.slice(0, 16)}...)`);
}

async function ranWorld() {
  const w = world();
  for (let t = START; t <= START + 15 * 60; t += 60) await w.at(t);
  return { w, env: { STORE: w.store, ...secretVars() } as Env };
}

test("GET /bundles/<hash>.json: the stored canonical bundle, immutable, its sha256 is its name", async () => {
  const { w, env } = await ranWorld();
  const latest = (JSON.parse((await w.store.get(KEYS.latest))!) as Record<string, { hash: string }>).h200!;
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
  const { w, env } = await ranWorld();
  const latest = await get("/latest.json", env);
  assert.equal(latest.status, 200);
  assert.equal(latest.headers.get("cache-control"), "public, max-age=30");
  const stored = JSON.parse((await w.store.get(KEYS.latest))!) as Record<string, { hash: string }>;
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

  // The model's clock is in January 2026, so against the real clock the keeper looks stale.
  assert.equal((await get("/health", env)).status, 503);
  const fresh = await handle(new Request(`${BASE}/health`), w.store, START + 15 * 60 + 30);
  assert.equal(fresh.status, 200);
  assert.deepEqual(await fresh.json(), { ok: true, last_tick: START + 15 * 60, age_secs: 30 });
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

  const empty = { STORE: new MemoryStore() } as Env;
  assert.equal((await get("/latest.json", empty)).status, 404);
  assert.equal((await get("/status", empty)).status, 200);
});

test("no secret ever reaches /status or the store, even when keys are bad and the network is down", async () => {
  // 1. A normal run on the model with the fake keys configured.
  const { w, env } = await ranWorld();
  // 2. The real cron path: bad keys (they are not base58 keys), malformed JSON in one secret, every request failing.
  const realFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    return new Response("down", { status: 503 });
  }) as typeof fetch;
  try {
    const bad: Env = { ...env, AGENTS: `${env.AGENTS!.slice(0, 120)}` };
    const promises: Promise<unknown>[] = [];
    await worker.scheduled({ scheduledTime: (START + 3600) * 1000, cron: "* * * * *" }, bad, { waitUntil: (p) => promises.push(p) });
    await Promise.all(promises);
    // That run holds the lease for 55 s of real time; this test does not wait for it.
    await env.STORE.delete(KEYS.lease);
    const report = await tickOnce(env, START + 3660, { deployments: deploymentsFor(IDS) });
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
  assert.match(status, /AGENTS is not valid JSON/);
  assertNoSecret(status, "/status");
  for (const [key, value] of w.store.map) assertNoSecret(value, `store key ${key}`);
  for (const path of ["/latest.json", "/health"]) assertNoSecret(await (await get(path, env)).text(), path);
});

test("src/ is portable: nothing but node.ts imports a Node built-in or uses Node globals", () => {
  const dir = new URL("../src/", import.meta.url);
  for (const name of readdirSync(dir)) {
    if (name === "node.ts") continue;
    assert.doesNotMatch(readFileSync(new URL(name, dir), "utf8"), /from\s+["']node:|require\(|process\.|Buffer\./, name);
  }
});
