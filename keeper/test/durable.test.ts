// The Durable Object: the alarm chain, overlap, failures, late wakes, retention, the cron
// watchdog, the cache in front of the bundles, and carrying sealed orders across stores.
import assert from "node:assert/strict";
import { test } from "node:test";
import { RETAIN_EVERY_SECS, RETAIN_SECS, RETAINED_KEY, STARTED_KEY, type MinuteOutcome } from "../src/durable.ts";
import type { KeeperEnv, TickReport } from "../src/keeper.ts";
import { SqlStore } from "../src/sqlstore.ts";
import { KEYS } from "../src/store.ts";
import worker from "../src/worker.ts";
import { Clock, fakeObject, fakeSql, withCache, workerEnv } from "./fakes.ts";
import { START, secretVars, world } from "./harness.ts";

/** 2026-11-12 12:00:00 UTC. */
const NOON = Date.UTC(2026, 10, 12, 12, 0, 0);
const MIN = 60_000;

const emptyReport = (now: number): TickReport => ({
  now, run: "test", ran: true, order: [], acting: [], budget: { limit: 40, used: 0, by_step: {} }, requests: [], entries: [], txs: [], undone: [], markets: {}, key_faults: [], config: [], rpc_cooling: [],
});

/** An object whose tick only records the minute it was asked for. */
function recording(clock: Clock, tick?: (env: KeeperEnv, now: number) => Promise<TickReport>) {
  const minutes: number[] = [];
  const o = fakeObject({}, {
    clock,
    tick: tick ?? (async (_env, now) => {
      minutes.push(now);
      return emptyReport(now);
    }),
  });
  return { ...o, minutes };
}

test("an alarm arms the next minute, then runs the minute it woke in", async () => {
  const clock = new Clock(NOON + 200);
  const { storage, fire, minutes } = recording(clock);
  await fire();
  assert.deepEqual(minutes, [NOON / 1000]);
  assert.equal(storage.alarm, NOON + MIN, "armed for 12:01:00");
  clock.ms = NOON + MIN + 150;
  await fire();
  assert.deepEqual(minutes, [NOON / 1000, NOON / 1000 + 60]);
  assert.equal(storage.alarm, NOON + 2 * MIN);
  // An alarm firing up to a second early counts as the minute it was set for.
  clock.ms = NOON + 2 * MIN - 400;
  await fire();
  assert.deepEqual(minutes.at(-1), NOON / 1000 + 120);
  assert.equal(storage.alarm, NOON + 3 * MIN);
});

test("a second call while a tick runs does not start another tick, and both leave the next minute armed", async () => {
  const clock = new Clock(NOON);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let ticks = 0;
  const { object, storage, minutes } = recording(clock, async (_env, now) => {
    ticks++;
    minutes.push(now);
    await gate;
    return emptyReport(now);
  });
  const first = object.alarm();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(ticks, 1, "the first tick is running");
  // The next minute's alarm arrives while the first tick still waits on the network.
  clock.ms = NOON + MIN + 10;
  storage.alarm = null;
  const second: MinuteOutcome = await object.runMinute(NOON / 1000 + 60);
  assert.equal(second, "running");
  await object.alarm();
  assert.equal(ticks, 1, "no second tick while one runs");
  assert.equal(storage.alarm, NOON + 2 * MIN, "the chain goes on");
  release();
  await first;
  assert.deepEqual(minutes, [NOON / 1000]);
  // 12:01 was skipped, not replayed: the next alarm runs 12:02.
  clock.ms = NOON + 2 * MIN + 5;
  storage.alarm = null;
  await object.alarm();
  assert.deepEqual(minutes, [NOON / 1000, NOON / 1000 + 120]);
});

test("a tick that throws still leaves the next minute armed, and the next minute runs", async () => {
  const clock = new Clock(NOON);
  let n = 0;
  const { object, storage, fire } = recording(clock, async (_env, now) => {
    n++;
    if (n === 1) throw new Error("boom");
    return emptyReport(now);
  });
  await fire();
  assert.equal(storage.alarm, NOON + MIN);
  const lastNow = (): number | undefined => object.last?.now;
  assert.equal(lastNow(), undefined, "no report from the tick that threw");
  clock.ms = NOON + MIN;
  await fire();
  assert.equal(lastNow(), NOON / 1000 + 60);
  // A failed setAlarm does not stop the tick; the watchdog arms the alarm afterwards.
  clock.ms = NOON + 2 * MIN;
  storage.failNextSetAlarm = true;
  await fire();
  assert.equal(lastNow(), NOON / 1000 + 120, "the tick ran");
  assert.equal(storage.alarm, null, "nothing armed");
  assert.deepEqual(await object.ensure(), { armed: true, alarm: NOON + 3 * MIN });
});

test("a late wake runs the current minute once; a repeated delivery does not run it again", async () => {
  const clock = new Clock(NOON);
  const { storage, fire, minutes, object } = recording(clock);
  await fire();
  // Armed for 12:01; the object is woken at 12:07:40 (an outage, say).
  clock.ms = NOON + 7 * MIN + 40_000;
  await fire();
  assert.deepEqual(minutes, [NOON / 1000, NOON / 1000 + 7 * 60], "12:07 runs; 12:01 to 12:06 are not replayed");
  assert.equal(storage.alarm, NOON + 8 * MIN);
  // Alarms are at-least-once: the same alarm delivered again in the same minute does nothing.
  clock.ms = NOON + 7 * MIN + 45_000;
  await fire();
  assert.deepEqual(minutes.length, 2);
  assert.equal(await object.store.get(STARTED_KEY), String(NOON / 1000 + 7 * 60));
});

test("the cron watchdog arms a missing alarm and leaves an armed one alone; its path is closed to the public", async () => {
  const clock = new Clock(NOON + 30_000);
  const { object, storage } = recording(clock);
  const { env, ns } = workerEnv(object);
  const cron = { scheduledTime: NOON, cron: "* * * * *" };
  const ctx = { waitUntil: () => {} };
  await worker.scheduled(cron, env, ctx);
  assert.equal(storage.alarm, NOON + MIN, "armed for the next minute");
  assert.equal(storage.setAlarmCalls, 1);
  clock.ms = NOON + 40_000;
  await worker.scheduled(cron, env, ctx);
  assert.equal(storage.setAlarmCalls, 1, "an armed alarm is not touched");
  assert.equal(storage.alarm, NOON + MIN);
  assert.deepEqual([...new Set(ns.names)], ["keeper"], "one object, by one fixed name");
  // From outside, the watchdog's path is answered by the Worker and never reaches the object.
  const before = ns.requests.length;
  for (const method of ["POST", "GET"]) {
    const res = await worker.fetch(new Request("https://weir-keeper.example.workers.dev/_internal/ensure", { method }), env);
    assert.equal(res.status, method === "POST" ? 405 : 404);
  }
  assert.equal(ns.requests.length, before);
});

test("the alarm runs real ticks on the model, and the Worker's routes read what they wrote", async () => {
  const w = world({ markets: ["h100-fast"] });
  const clock = new Clock(START * 1000);
  const { object, storage, fire } = fakeObject(secretVars({ markets: ["h100-fast"] }), { clock, deployments: w.deployments, chain: w.chain, fetch: w.sources.fetch });
  for (let t = START; t <= START + 10 * 60; t += 60) {
    w.setTime(t);
    clock.ms = t * 1000 + 300;
    await fire();
    assert.equal(object.last?.now, t);
    assert.equal(storage.alarm, (t + 60) * 1000);
  }
  assert.equal(await object.store.get(KEYS.lease), null, "no lease written");
  assert.ok(w.model.market.events.some((e) => e.event === "commit"), "the swarm committed");
  assert.ok(w.model.market.events.some((e) => e.event === "report"), "the reporters reported");
  const { env } = workerEnv(object);
  const base = "https://weir-keeper.example.workers.dev";
  const status = (await (await worker.fetch(new Request(`${base}/status`), env)).json()) as { last_tick: number; age_secs: number };
  assert.equal(status.last_tick, START + 600);
  const health = await worker.fetch(new Request(`${base}/health`), env);
  assert.equal(health.status, 200);
  const latest = (await (await worker.fetch(new Request(`${base}/latest.json`), env)).json()) as { hash: string; bundle: { chip: string } };
  assert.equal(latest.bundle.chip, "h100");
  const bundle = await worker.fetch(new Request(`${base}/bundles/${latest.hash}.json`), env);
  assert.equal(bundle.status, 200);
  assert.equal(bundle.headers.get("access-control-allow-origin"), "*");
});

test("bundles and /latest.json are served from the cache after the first read; /status is not cached", async () => {
  const w = world({ markets: ["h100-fast"] });
  const clock = new Clock(START * 1000);
  const { object, fire } = fakeObject(secretVars({ markets: ["h100-fast"] }), { clock, deployments: w.deployments, chain: w.chain, fetch: w.sources.fetch });
  w.setTime(START);
  await fire();
  const { env, ns } = workerEnv(object);
  const base = "https://weir-keeper.example.workers.dev";
  const hash = (JSON.parse((await object.store.get(KEYS.latest))!) as Record<string, { hash: string }>).h100!.hash;
  await withCache(async (cache) => {
    const bodies: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await worker.fetch(new Request(`${base}/bundles/${hash}.json`), env);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("access-control-allow-origin"), "*");
      assert.match(res.headers.get("content-type")!, /^application\/json/);
      assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
      bodies.push(await res.text());
    }
    assert.equal(new Set(bodies).size, 1);
    assert.equal(ns.requests.filter((r) => r.startsWith("GET /bundles/")).length, 1, "one object request for three reads");
    // A 404 is not cached: a bundle may be written later.
    for (let i = 0; i < 2; i++) assert.equal((await worker.fetch(new Request(`${base}/bundles/${"0".repeat(64)}.json`), env)).status, 404);
    assert.equal(ns.requests.filter((r) => r === `GET /bundles/${"0".repeat(64)}.json`).length, 2);
    for (let i = 0; i < 2; i++) await worker.fetch(new Request(`${base}/latest.json?chip=h100`), env);
    assert.equal(ns.requests.filter((r) => r.startsWith("GET /latest.json")).length, 1);
    for (let i = 0; i < 2; i++) await worker.fetch(new Request(`${base}/status`), env);
    assert.equal(ns.requests.filter((r) => r === "GET /status").length, 2);
    // HEAD and OPTIONS: HEAD goes to the object, OPTIONS is answered by the Worker.
    assert.equal((await worker.fetch(new Request(`${base}/bundles/${hash}.json`, { method: "HEAD" }), env)).status, 200);
    assert.equal((await worker.fetch(new Request(`${base}/status`, { method: "OPTIONS" }), env)).status, 204);
    assert.equal(ns.requests.filter((r) => r.startsWith("OPTIONS")).length, 0);
    assert.equal(cache.map.size, 2);
  });
});

test("retention: bundles and orders older than 15 days go, every 6 hours, except each chip's latest bundle", async () => {
  const T0 = NOON;
  const clock = new Clock(T0);
  const { object, fire } = recording(clock);
  const s = object.store;
  const latestHash = "a".repeat(64);
  await s.put(KEYS.bundle(latestHash), "{}");
  await s.put(KEYS.bundle("b".repeat(64)), "{}");
  await s.put(KEYS.order("weir|0|1|a.test|0"), "{}");
  await s.put(KEYS.status, "{}");
  await s.put(KEYS.marks("weir.test"), "{}");
  await s.put(KEYS.latest, JSON.stringify({ h100: { chip: "h100", hash: latestHash, bucket: 0, fetched_at: 0, index: 1 } }));
  clock.ms = T0 + 10 * 86_400_000;
  await s.put(KEYS.bundle("c".repeat(64)), "{}");
  // Fifteen days and a minute later.
  clock.ms = T0 + RETAIN_SECS * 1000 + MIN;
  await fire();
  const keys = s.sizes().map((r) => r.key);
  assert.ok(keys.includes(KEYS.bundle(latestHash)), "the latest bundle stays however old");
  assert.ok(!keys.includes(KEYS.bundle("b".repeat(64))), "an old bundle goes");
  assert.ok(!keys.includes(KEYS.order("weir|0|1|a.test|0")), "an old order goes");
  assert.ok(keys.includes(KEYS.bundle("c".repeat(64))), "a 5-day-old bundle stays");
  for (const k of [KEYS.status, KEYS.marks("weir.test"), KEYS.latest]) assert.ok(keys.includes(k), `${k} is not subject to retention`);
  const ranAt = Number(await s.get(RETAINED_KEY));
  // Not again within 6 hours.
  clock.ms = T0;
  await s.put(KEYS.bundle("d".repeat(64)), "{}");
  clock.ms = (ranAt + 3600) * 1000;
  await fire();
  assert.ok(s.sizes().some((r) => r.key === KEYS.bundle("d".repeat(64))), "within 6 hours: not run");
  clock.ms = (ranAt + RETAIN_EVERY_SECS) * 1000;
  await fire();
  assert.ok(!s.sizes().some((r) => r.key === KEYS.bundle("d".repeat(64))), "6 hours later: run");
});

test("moving stores: sealed orders committed through one store are revealed through a fresh one, from SWARM_SECRET", async () => {
  // The Node loop's directory store and the object's SQL store are separate. An order is
  // stored before it is committed; at reveal, an order missing from the store is rebuilt from
  // the commit (salts are HMAC(SWARM_SECRET, ...), the lock fixes size and price).
  const w = world({ markets: ["h100-fast"] });
  for (let t = START; t <= START + 60; t += 60) await w.at(t);
  const committedBefore = w.model.market.events.filter((e) => e.event === "commit").length;
  assert.ok(committedBefore > 0, "orders committed through the first store");
  const fresh = new SqlStore(fakeSql());
  const entries = [];
  for (let t = START + 120; t <= START + 30 * 60; t += 60) entries.push(...(await w.at(t, { store: fresh })).entries);
  const rebuilt = entries.filter((e) => e.action === "reveal" && e.status === "done" && /rebuilt: not in store/.test(e.text));
  assert.ok(rebuilt.length > 0, "reveals rebuilt from the commit");
  const clears = w.model.market.events.filter((e) => e.event === "clear");
  assert.ok(clears.length >= 4);
  assert.deepEqual(clears.filter((e) => e.data.forfeited > 0n).map((e) => `${e.data.series}/${e.data.round}`), [], "nothing forfeited");
  assert.deepEqual(entries.filter((e) => e.status === "failed"), []);
});
