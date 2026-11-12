// Agent and reporter lists split over several secrets (Cloudflare refuses one over 5 KB):
// reading the parts, the redactor over every part, the object passing its whole environment
// through, and scripts/secrets.ts, which makes the parts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { readSecrets, redactor } from "../src/config.ts";
import { LIMIT_BYTES, splitSecrets, SecretsRefused } from "../scripts/secrets.ts";
import { Clock, fakeObject } from "./fakes.ts";
import { agentsFor, contractOf, fakeKey, IDS, secretVars, START, world } from "./harness.ts";

const SECRET = "a-long-enough-swarm-secret";
const bytes = (s: string) => new TextEncoder().encode(s).length;

/** Agent entries the way the deploy tool writes them: one key per contract, long values. */
const agentEntries = (perMarket = 6) =>
  IDS.flatMap((m) =>
    agentsFor(m).slice(0, perMarket).map(({ deposit: _d, secret_key: _k, ...a }) => ({ ...a, keys: { [contractOf(m)]: `${fakeKey(`${a.account_id}${m}`)}${"Q".repeat(150)}` } })),
  );

test("AGENTS and AGENTS_* parts are one list, sorted by name; a bad part is named and the others load; a duplicate is ignored", () => {
  const [a, b, c] = [agentEntries().slice(0, 3), agentEntries().slice(3, 6), agentEntries().slice(6, 9)];
  const s = readSecrets({ AGENTS_B: JSON.stringify(b), AGENTS: JSON.stringify(a), AGENTS_A: JSON.stringify(c), AGENTS_BAD: "{not json", REPORTERS_2: "[]", REPORTERS: "[]", SWARM_SECRET: SECRET });
  assert.deepEqual(s.agents.map((x) => x.account_id), [...a, ...c, ...b].map((x) => x.account_id), "AGENTS, then AGENTS_A, AGENTS_B");
  assert.deepEqual(s.problems, ["AGENTS_BAD is not valid JSON"]);

  // The same agent on the same market in two parts: one agent, and a problem naming the later entry.
  const dupWithOtherKey = { ...a[0]!, keys: { [contractOf(a[0]!.market!)]: fakeKey("another-key-for-the-same-agent") } };
  const d = readSecrets({ AGENTS: JSON.stringify(a), AGENTS_X: JSON.stringify([dupWithOtherKey]), REPORTERS: "[]", SWARM_SECRET: SECRET });
  assert.equal(d.agents.length, 3);
  assert.deepEqual(d.problems, [`agent ${a[0]!.account_id} on ${a[0]!.market} appears more than once (AGENTS_X[0] ignored)`]);
  // The redactor covers keys from every part, the ignored entry's too.
  const redact = redactor(d);
  const leaked = redact({ text: `${JSON.stringify(a)} ${fakeKey("another-key-for-the-same-agent")}` }).text;
  assert.ok(!leaked.includes("FAKESECRETKEY"), "no key survives redaction");

  // Reporters split the same way.
  const reps = (ids: string[]) => JSON.stringify(ids.map((id) => ({ account_id: id, secret_key: fakeKey(id) })));
  const r = readSecrets({ REPORTERS_2: reps(["rep-c.test"]), REPORTERS: reps(["rep-a.test", "rep-b.test"]), AGENTS: "[]" });
  assert.deepEqual(r.reporters.map((x) => x.account_id), ["rep-a.test", "rep-b.test", "rep-c.test"]);
  assert.deepEqual(r.problems, []);
  // Only parts unset: "not set" is still said.
  assert.deepEqual(readSecrets({ AGENTS_X: JSON.stringify(a), SWARM_SECRET: SECRET }).problems, ["REPORTERS is not set: no price is reported"]);
  // A single AGENTS, as the Node loop has it, reads as before.
  assert.equal(readSecrets(secretVars()).agents.length, 32);
  assert.deepEqual(readSecrets(secretVars()).problems, []);
});

test("the Durable Object reads agents split over several secrets: every market trades", async () => {
  const w = world({ markets: ["h100-fast", "h200-weekly"], fast: ["h200-weekly"] });
  const vars = secretVars({ markets: ["h100-fast", "h200-weekly"], fast: ["h200-weekly"] });
  const all = JSON.parse(vars.AGENTS) as { market: string }[];
  const { AGENTS: _whole, ...rest } = vars;
  const split = { ...rest, AGENTS_H100_FAST: JSON.stringify(all.filter((a) => a.market === "h100-fast")), AGENTS_H200_WEEKLY: JSON.stringify(all.filter((a) => a.market === "h200-weekly")), BUDGET: "80", SOME_OTHER_BINDING: "ignored" };
  const clock = new Clock(START * 1000);
  const { object, fire } = fakeObject(split, { clock, deployments: w.deployments, chain: w.chain, fetch: w.sources.fetch });
  for (let t = START; t <= START + 5 * 60; t += 60) {
    w.setTime(t);
    clock.ms = t * 1000 + 100;
    await fire();
    assert.deepEqual(object.last!.config, [], `no configuration problem at ${t}`);
  }
  for (const id of ["h100-fast", "h200-weekly"] as const) assert.ok(w.models[id].market.events.some((e) => e.event === "commit"), `${id}: agents from their own part committed`);
  for (const { key } of object.store.sizes()) assert.ok(!(await object.store.get(key))!.includes("FAKESECRETKEY"), `no key in ${key}`);
});

test("scripts/secrets.ts: splits by market under the limit, nulls AGENTS, and reads back the same lists", () => {
  const agents = agentEntries();
  const whole = JSON.stringify(agents);
  assert.ok(bytes(whole) > 5100, `the fake AGENTS is ${bytes(whole)} bytes, over Cloudflare's limit like the real one`);
  const vars = { ...secretVars(), AGENTS: whole };
  const { out, sizes } = splitSecrets(vars);
  assert.equal(out.AGENTS, null);
  assert.deepEqual(Object.keys(out).filter((k) => k.startsWith("AGENTS_")), ["AGENTS_H100_FAST", "AGENTS_H100_WEEKLY", "AGENTS_H200_WEEKLY", "AGENTS_A100_80_WEEKLY"]);
  for (const [k, v] of Object.entries(out)) if (v !== null) assert.ok(bytes(v) <= LIMIT_BYTES, `${k} under the limit`);
  assert.equal(out.SWARM_SECRET, vars.SWARM_SECRET);
  assert.equal(out.KEEPER, vars.KEEPER);
  assert.equal(out.REPORTERS, JSON.stringify(JSON.parse(vars.REPORTERS)));
  assert.equal(readSecrets(out as Record<string, string>).agents.length, agents.length);
  for (const line of sizes) assert.match(line, /^[A-Z0-9_]+: (\d+ bytes|deleted \(null\))$/);

  // One market too large for one value: numbered parts.
  const small = splitSecrets(vars, 1200).out;
  assert.ok(Object.keys(small).includes("AGENTS_H100_FAST_2"));
  for (const [k, v] of Object.entries(small)) if (v !== null && k.startsWith("AGENTS")) assert.ok(bytes(v) <= 1200, k);
  assert.equal(readSecrets(Object.fromEntries(Object.entries(small).filter(([, v]) => v !== null)) as Record<string, string>).agents.length, agents.length);

  // One entry over the limit: refused.
  assert.throws(() => splitSecrets(vars, 200), SecretsRefused);
  assert.throws(() => splitSecrets({ ...vars, AGENTS: "{oops" }), /AGENTS is not valid JSON/);
});

test("scripts/secrets.ts from the command line: JSON on stdout, names and sizes on stderr, never a value; refuses with nothing on stdout", () => {
  const script = new URL("../scripts/secrets.ts", import.meta.url).pathname;
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", script], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" });
  const vars = { ...secretVars(), AGENTS: JSON.stringify(agentEntries()) };
  const ok = run(vars);
  assert.equal(ok.status, 0, ok.stderr);
  const out = JSON.parse(ok.stdout) as Record<string, string | null>;
  assert.equal(out.AGENTS, null);
  assert.ok(!ok.stderr.includes("FAKESECRETKEY") && !ok.stderr.includes(vars.SWARM_SECRET), "no value on stderr");
  assert.match(ok.stderr, /AGENTS_H100_FAST: \d+ bytes/);

  const huge = { ...vars, KEEPER: JSON.stringify({ account_id: "keeper.test", keys: Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`c${i}.test`, fakeKey(`k${i}`)])) }) };
  const refused = run(huge);
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, "");
  assert.match(refused.stderr, /refused: KEEPER is \d+ bytes, over the 5000-byte limit/);
  assert.ok(!refused.stderr.includes("FAKESECRETKEY"));
});
