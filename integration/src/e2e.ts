// `pnpm --filter @weir/integration run e2e`: every scenario on one local sandbox, then
// `out/run.json` and a summary. Exits non-zero on any failed check or parity difference.
import { mkdirSync, writeFileSync } from "node:fs";
import { fullBook } from "./fullbook.ts";
import { gasMarkdown, gasTable } from "./gas.ts";
import { lifecycle } from "./lifecycle.ts";
import { swarm } from "./swarm.ts";
import { voids } from "./voids.ts";
import { Sandbox } from "./sandbox.ts";
import { World } from "./world.ts";

const only = new Set((process.env.WEIR_E2E_ONLY ?? "").split(",").filter(Boolean));
const want = (name: string) => only.size === 0 || only.has(name);
const OUT = process.env.WEIR_E2E_OUT ?? new URL("../out/", import.meta.url).pathname;

const started = Date.now();
const timings: Record<string, number> = {};
const results: Record<string, unknown> = {};
let fatal: string | null = null;
const sandbox = await Sandbox.start({ log: (l) => console.log(l) });
let world: World | null = null;
try {
  world = await World.create(sandbox);
  const w = world;
  const run = async (name: string, fn: () => Promise<unknown>) => {
    if (!want(name)) return;
    const t = Date.now();
    console.log(`\n== ${name}`);
    try {
      results[name] = await fn();
    } catch (e) {
      w.scenario = name;
      w.check(`${name} ran to the end`, false, e instanceof Error ? e.stack : String(e));
    }
    timings[name] = Date.now() - t;
    console.log(`   ${name}: ${(timings[name] / 1000).toFixed(1)} s`);
  };
  await run("lifecycle", () => lifecycle(w));
  // The reporters of the lifecycle serve the other deployments too.
  const reporters = await Promise.all(["rep-x", "rep-y", "rep-z"].map((n) => w.root.createAccount(n)));
  await run("void", () => voids(w, reporters));
  await run("full-book", () => fullBook(w, reporters));
  await run("swarm", () => swarm(w, reporters, { second: process.env.WEIR_E2E_SECOND !== "0" }));
} catch (e) {
  fatal = e instanceof Error ? (e.stack ?? e.message) : String(e);
  console.error(fatal);
} finally {
  sandbox.stop();
}

function countBy(xs: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
}

/** Clears are told apart by how full their book was. */
function tagOf(r: { method: string; scenario: string; args: unknown; chain: { events: string[] } }): string | null {
  if (r.method === "settle") {
    const decided = r.chain.events.filter((e) => /"event":"(print|no_print)"/.test(e)).length;
    return decided > 0 ? `deciding ${decided} pending bucket${decided > 1 ? "s" : ""}` : "nothing pending";
  }
  if (r.method === "commit" && r.chain.events.some((e) => e.includes('"event":"evict"'))) return `evicting from a full round of ${r.scenario === "full-book" ? 128 : "?"}`;
  if (r.method === "report") {
    const decided = r.chain.events.filter((e) => /"event":"(print|no_print)"/.test(e)).length;
    return decided > 0 ? "deciding" : "not deciding";
  }
  if (r.method !== "clear") return null;
  const round = (r.args as { round: number }).round;
  if (r.scenario === "full-book" && round === 0) return "128 commits, all filled";
  if (r.scenario === "full-book") return "unrevealed commits only";
  return r.scenario.startsWith("swarm") ? "keeper books" : "lifecycle books";
}

const w = world;
const failed = w?.checks.filter((c) => !c.ok) ?? [];
const record = {
  started: new Date(started).toISOString(),
  wall_ms: Date.now() - started,
  timings,
  fatal,
  sandbox: { binary: sandbox.binary, version: sandbox.version, fast_forward_ms: sandbox.fastForwardMs, fast_forward_blocks: sandbox.fastForwardBlocks },
  wasm: w && { weir: { sha256: w.wasm.weir.sha256, built: w.wasm.weir.built }, usdc: { sha256: w.wasm.usdc.sha256, built: w.wasm.usdc.built } },
  checks: { total: w?.checks.length ?? 0, failed: failed.length, list: w?.checks ?? [] },
  parity: w && {
    calls: w.log.calls.length,
    differing_calls: w.log.calls.filter((c) => !c.same).length,
    by_kind: countBy(w.log.diffs.map((d) => d.kind)),
    views_compared: w.log.views.reduce((s, v) => s + v.compared, 0),
    diffs: w.log.diffs,
    views: w.log.views,
  },
  results,
  gas: w ? gasTable(w.log.calls, w.tokenCalls, tagOf) : [],
  calls: w?.log.calls ?? [],
  token_calls: w?.tokenCalls ?? [],
};
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}run.json`, JSON.stringify(record, null, 1));

console.log("\n" + gasMarkdown(record.gas));
console.log(`\nchecks: ${record.checks.total - failed.length} passed, ${failed.length} failed`);
for (const f of failed) console.log(`  FAIL [${f.scenario}] ${f.name}: ${JSON.stringify(f.detail)?.slice(0, 600)}`);
console.log(`parity: ${record.parity?.calls ?? 0} calls and ${record.parity?.views_compared ?? 0} views compared; ${record.parity?.differing_calls ?? 0} calls differ; differences by kind ${JSON.stringify(record.parity?.by_kind ?? {})}`);
for (const d of w?.log.diffs ?? []) console.log(`  DIFF [${d.scenario}] ${d.kind} ${d.method} ${JSON.stringify(d.args).slice(0, 200)}\n     chain: ${JSON.stringify(d.chain)?.slice(0, 400)}\n     model: ${JSON.stringify(d.model)?.slice(0, 400)}`);
console.log(`wall time ${(record.wall_ms / 1000).toFixed(1)} s; record in ${OUT}run.json`);
process.exitCode = fatal || failed.length > 0 || (record.parity?.diffs.length ?? 0) > 0 ? 1 : 0;
