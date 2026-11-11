// What one tick costs in time. Runs the keeper on the model (ModelWeir): four markets (the
// agents package's MARKETS), three chips, eight agents and three reporters, with the index
// package's saved source responses, then measures separately the three things a real tick
// does on its own CPU that the model skips or hides: parsing the source payloads, hashing,
// and signing transactions.
//
//   node keeper/scripts/bench.ts
import { performance } from "node:perf_hooks";
import { base58Encode, KeyPair, signTransaction, utf8Encode } from "@weir/chain";
import { bundleHash, CHIP_IDS, CHIPS, makeBundle, sha256Hex, sourcesFor, type Outcome } from "@weir/index";
import { requestKey } from "@weir/index/fetch";
import { START, fixtureBody, world } from "../test/harness.ts";

const cpuMs = (f: () => void | Promise<void>) => async (): Promise<{ cpu: number; wall: number }> => {
  const c0 = process.cpuUsage();
  const w0 = performance.now();
  await f();
  const c = process.cpuUsage(c0);
  return { cpu: (c.user + c.system) / 1000, wall: performance.now() - w0 };
};

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
const fmt = (ms: number) => `${ms.toFixed(2)} ms`;

async function repeat(n: number, f: () => Promise<{ cpu: number; wall: number }>) {
  const runs = [];
  for (let i = 0; i < n; i++) runs.push(await f());
  return { cpu: median(runs.map((r) => r.cpu)), wall: median(runs.map((r) => r.wall)) };
}

// The three chips' outcomes, as one fetch of 8 distinct requests gives them.
const perChip = CHIP_IDS.map((chip) => ({ chip, bodies: sourcesFor(CHIPS[chip]).map((s) => ({ source: s, body: fixtureBody(s.id, chip) })) }));
const distinct = new Map(perChip.flatMap((c) => c.bodies.map((b) => [requestKey(b.source), b.body] as const)));
const buildAll = async () => {
  const hashes = new Map<string, string>();
  for (const [k, body] of distinct) hashes.set(k, await sha256Hex(body));
  for (const c of perChip) {
    const outs: Outcome[] = c.bodies.map((b) => ({ ...b, raw_sha256: hashes.get(requestKey(b.source))! }));
    await bundleHash(makeBundle(0, 0, outs, CHIPS[c.chip]));
  }
};

// 0. Cold: the first time each piece runs in this process, as in a fresh isolate.
const cold = {
  parse: (await cpuMs(buildAll)()).cpu,
  key: 0,
  sign: 0,
  tick: 0,
};

// 1. Whole ticks on the model: an hour of four markets, eight agents, three reporters.
const w = world();
cold.tick = (await cpuMs(async () => void (await w.at(START)))()).cpu;
for (let t = START + 60; t < START + 600; t += 60) await w.at(t); // open the series
const writes0 = w.store.writes;
const ticks: { now: number; cpu: number; wall: number; txs: number; requests: number; index: boolean }[] = [];
for (let t = START + 600; t < START + 600 + 3600; t += 60) {
  let r = null as Awaited<ReturnType<typeof w.at>> | null;
  const m = await cpuMs(async () => {
    r = await w.at(t);
  })();
  ticks.push({ now: t, ...m, txs: r!.txs.length, requests: r!.budget.used, index: r!.entries.some((e) => e.step === "index") });
}
const writesPerTick = (w.store.writes - writes0) / ticks.length;
const busiest = [...ticks].sort((a, b) => b.cpu - a.cpu)[0]!;
const indexTicks = ticks.filter((t) => t.index);
const otherTicks = ticks.filter((t) => !t.index);

// 2. Parsing: JSON.parse and the parsers over the saved payloads, as makeBundle does, per chip.
const bytes = [...distinct.values()].reduce((n, b) => n + b.length, 0);
const outcomes = await Promise.all(perChip.map(async (c) => ({ chip: c.chip, outs: await Promise.all(c.bodies.map(async (b): Promise<Outcome> => ({ ...b, raw_sha256: await sha256Hex(b.body) }))) })));
const parse = await repeat(30, cpuMs(() => void outcomes.forEach((c) => makeBundle(0, 0, c.outs, CHIPS[c.chip]))));

// 3. Hashing: sha256 of every distinct raw body (Web Crypto) and the three bundle hashes.
const bundles = outcomes.map((c) => makeBundle(0, 0, c.outs, CHIPS[c.chip]));
const hash = await repeat(30, cpuMs(async () => {
  for (const body of distinct.values()) await sha256Hex(utf8Encode(body));
  for (const b of bundles) await bundleHash(b);
}));

// 4. Signing: one function-call transaction, as NearAccount signs it (borsh, sha256, ed25519).
// The key is made up here from fixed bytes; it belongs to no account and nothing is sent.
let key = null as KeyPair | null;
cold.key = (await cpuMs(async () => void (key = await KeyPair.fromString(`ed25519:${base58Encode(new Uint8Array(32).fill(7))}`)))()).cpu;
const tx = {
  signerId: "buyer-1.example.testnet",
  publicKey: key!.publicKey,
  nonce: 123_456_789n,
  receiverId: "weir.example.testnet",
  blockHash: new Uint8Array(32).fill(1),
  actions: [{ methodName: "reveal", args: utf8Encode(JSON.stringify({ series: 3, round: 7, seq: 12, side: "Long", size: 40, price: 414000, salt: "ab".repeat(16) })), gas: 50_000_000_000_000n, deposit: 0n }],
};
cold.sign = (await cpuMs(async () => void (await signTransaction(tx, key!)))()).cpu;
const sign = await repeat(200, cpuMs(async () => void (await signTransaction(tx, key!))));

const maxTxs = Math.max(...ticks.map((t) => t.txs));
const meanTxs = ticks.reduce((s, t) => s + t.txs, 0) / ticks.length;
const chainIndexTick = parse.cpu + hash.cpu + maxTxs * sign.cpu;

console.log(`Keeper tick cost (Node ${process.version}, ${ticks.length} ticks of four markets and three chips, 8 agents, 3 reporters)

Model ticks (keeper + swarm + the engine executing every call; no network):
  median tick           cpu ${fmt(median(ticks.map((t) => t.cpu)))}   wall ${fmt(median(ticks.map((t) => t.wall)))}
  median index tick     cpu ${fmt(median(indexTicks.map((t) => t.cpu)))}   (fetch, bundle, reports; ${indexTicks.length} ticks)
  median other tick     cpu ${fmt(median(otherTicks.map((t) => t.cpu)))}
  busiest tick          cpu ${fmt(busiest.cpu)}   ${busiest.txs} transactions, ${busiest.requests} requests${busiest.index ? ", with an index fetch" : ""}
  transactions per tick mean ${meanTxs.toFixed(1)}, max ${maxTxs}

What a real tick adds on its own CPU:
  parse 3 chips         cpu ${fmt(parse.cpu)}   (${distinct.size} bodies, ${(bytes / 1024).toFixed(0)} KiB of JSON, makeBundle per chip)
  hash bodies + bundle  cpu ${fmt(hash.cpu)}   (Web Crypto sha256 of each body, canonical JSON + sha256 of 3 bundles)
  sign one transaction  cpu ${fmt(sign.cpu)}   (borsh + sha256 + ed25519 with @noble/ed25519)

Cold (first call in a fresh process):
  first model tick      cpu ${fmt(cold.tick)}   (includes an index fetch)
  first parse + hash    cpu ${fmt(cold.parse)}
  first key derivation  cpu ${fmt(cold.key)}
  first signature       cpu ${fmt(cold.sign)}

Store writes: ${writesPerTick.toFixed(1)} per tick, about ${Math.round(writesPerTick * 1440)} a day at one tick a minute.

Estimate for a tick on chain, keeper CPU only (the contract's work is NEAR's):
  index tick with ${maxTxs} transactions: parse + hash + ${maxTxs} x sign = ${fmt(chainIndexTick)}
  tick with ${Math.round(meanTxs)} transactions, no fetch: ${fmt(Math.round(meanTxs) * sign.cpu)}
  plus JSON handling of up to 40 RPC replies and the swarm's own logic (bounded above by the model tick).`);
