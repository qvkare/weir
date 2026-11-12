// `rotate` on the fake chain: one reporter key replaced (new key with the same permission and a
// fresh allowance, old key gone, keeper.env changed for that contract only, every other key
// untouched, the record and the state file updated); --dry-run changes nothing; a run killed
// before or after the add finishes on the next run without a third key; the refusals; and no
// secret in any log line, state or record.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { apply } from "../src/apply.ts";
import { allowanceFor, METHODS_OF } from "../src/budget.ts";
import { Keystore, Redactor } from "../src/keys.ts";
import { fcKeys, layout, sandboxNetwork, type MarketId } from "../src/layout.ts";
import { writeOutputs } from "../src/outputs.ts";
import { planRotation, rotate, rotationTargets } from "../src/rotate.ts";
import { newState, readState } from "../src/state.ts";
import { buildPlan } from "../src/steps.ts";
import { FakeChain, fakeWasm, Killed } from "./fake.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "weir-rotate-test-"));
  dirs.push(d);
  return d;
};
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const wasm = { weir: fakeWasm("weir", 1), usdc: fakeWasm("mock_usdc", 2) };
const MARKETS: MarketId[] = ["h100-fast", "h100-weekly"];
let seedN = 9000;
const seed = () => {
  const s = new Uint8Array(32).fill(5);
  s[0] = ++seedN >> 8;
  s[1] = seedN & 0xff;
  return s;
};

async function deployed() {
  const chain = new FakeChain(wasm);
  const out = tmp();
  const keysDir = tmp();
  const redactor = new Redactor();
  const keys = new Keystore(keysDir, { seed, redactor });
  const l = layout(sandboxNetwork("http://fake"), "r1", MARKETS);
  keys.loadAll(l.accounts.map((a) => a.id), "r1");
  const plan = buildPlan(l, 2);
  const state = newState("sandbox", "r1", MARKETS, "2026-11-12T00:00:00.000Z");
  const lines: string[] = [];
  const log = (s: string) => lines.push(redactor.redact(s));
  await apply({ chain, keys, plan, wasm, out, state, log });
  await writeOutputs(out, plan, state, chain, keys, wasm);
  const ctx = { chain, keys, layout: l, state, out, log, writeOutputs: async () => void (await writeOutputs(out, plan, state, chain, keys, wasm)) };
  return { chain, out, keysDir, keys, l, state, lines, ctx };
}

const env = (out: string) => {
  const vars: Record<string, unknown> = {};
  for (const line of readFileSync(join(out, "keeper.env"), "utf8").split("\n")) {
    const m = /^([A-Z_]+)='(.*)'$/.exec(line);
    if (m) vars[m[1]!] = m[2]!.startsWith("[") || m[2]!.startsWith("{") ? JSON.parse(m[2]!) : m[2];
  }
  return vars as { REPORTERS: { account_id: string; keys: Record<string, string> }[]; AGENTS: unknown; KEEPER: unknown; SWARM_SECRET: string };
};
const keysOf = (chain: FakeChain, id: string) => [...chain.accounts.get(id)!.keys].map(([pk, p]) => [pk, JSON.stringify(p)] as const).sort();
const everyKeyBut = (chain: FakeChain, id: string) => [...chain.accounts].filter(([a]) => a !== id).map(([a]) => [a, keysOf(chain, a)]);
const fileCount = (d: string): number => readdirSync(d).reduce((n, f) => n + (statSync(join(d, f)).isDirectory() ? fileCount(join(d, f)) : 1), 0);

test("one reporter key rotated: same permission, fresh allowance, old key gone, only that keeper.env entry changed, record and state updated", async () => {
  const s = await deployed();
  const rep = s.l.reporters["h100-fast"]![0]!;
  const fast = s.l.contracts["h100-fast"]!;
  const weekly = s.l.contracts["h100-weekly"]!;
  const old = (await s.keys.existingFunctionCall(rep, fast))!.publicKeyString;
  const others = everyKeyBut(s.chain, rep);
  const otherOwn = keysOf(s.chain, rep).filter(([pk]) => pk !== old);
  const envBefore = env(s.out);
  const sendsBefore = s.chain.sends.length;

  const r = await rotate(s.ctx, rotationTargets(s.l, rep, fast));
  assert.equal(r.sent, 2, "one AddKey, one DeleteKey");
  assert.equal(s.chain.sends.length - sendsBefore, 2);

  const now = (await s.keys.existingFunctionCall(rep, fast))!.publicKeyString;
  assert.notEqual(now, old);
  const k = fcKeys(s.l).find((x) => x.account === rep && x.receiver === fast)!;
  const perm = s.chain.accounts.get(rep)!.keys.get(now);
  assert.deepEqual(perm, { FunctionCall: { receiver_id: fast, method_names: [...METHODS_OF.reporter], allowance: allowanceFor(s.l, k).allowance.toString() } });
  assert.equal(s.chain.accounts.get(rep)!.keys.has(old), false, "old key deleted");
  assert.deepEqual(keysOf(s.chain, rep).filter(([pk]) => pk !== now), otherOwn, "the reporter's other keys untouched");
  assert.deepEqual(everyKeyBut(s.chain, rep), others, "every other account's keys untouched");

  const envAfter = env(s.out);
  const before = envBefore.REPORTERS.find((x) => x.account_id === rep)!;
  const afterR = envAfter.REPORTERS.find((x) => x.account_id === rep)!;
  assert.notEqual(afterR.keys[fast], before.keys[fast], "keeper.env holds the new key for that contract");
  assert.equal(afterR.keys[fast], s.keys.functionCallSecret(rep, fast));
  assert.equal(afterR.keys[weekly], before.keys[weekly], "and the same key for the other contract");
  assert.deepEqual(envAfter.REPORTERS.filter((x) => x.account_id !== rep), envBefore.REPORTERS.filter((x) => x.account_id !== rep));
  assert.deepEqual([envAfter.AGENTS, envAfter.KEEPER, envAfter.SWARM_SECRET], [envBefore.AGENTS, envBefore.KEEPER, envBefore.SWARM_SECRET]);

  const record = readFileSync(join(s.out, "record.json"), "utf8");
  const rows = (JSON.parse(record) as { keys: { public_key: string }[] }).keys.map((x) => x.public_key);
  assert.ok(rows.includes(now), "the record's keys list the new public key");
  assert.ok(!rows.includes(old), "and no longer the old one (it stays only in the transaction history, as the deleted key)");
  const st = readState(s.out)!;
  assert.ok(st.steps[`rotate:${rep}:${fast}:${now}`]?.tx, "the add's hash is in state.json");
  assert.ok(st.steps[`retire:${rep}:${old}`]?.tx, "the delete's hash is in state.json");

  // A second rotation of the same key works from the new generation.
  await rotate(s.ctx, rotationTargets(s.l, rep, fast));
  assert.equal([...s.chain.accounts.get(rep)!.keys.values()].filter((p) => p !== "FullAccess" && p.FunctionCall.receiver_id === fast).length, 1);

  // No secret anywhere the tool writes or prints but keeper.env and the key files.
  const check = new Redactor();
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else check.add(n.endsWith(".swarm-secret") ? readFileSync(p, "utf8").trim() : (JSON.parse(readFileSync(p, "utf8")) as { private_key: string }).private_key);
    }
  };
  walk(s.keysDir);
  for (const [name, text] of Object.entries({ log: s.lines.join("\n"), state: readFileSync(join(s.out, "state.json"), "utf8"), record, deployments: readFileSync(join(s.out, "deployments.json"), "utf8") })) {
    assert.equal(check.leaks(text), false, `${name} holds no secret`);
  }
  assert.ok(s.lines.some((x) => x.includes("restart the keeper")));
});

test("rotating every key of an account: the keeper's one key per market", async () => {
  const s = await deployed();
  const targets = rotationTargets(s.l, s.l.keeper);
  assert.equal(targets.length, MARKETS.length);
  const olds = await Promise.all(targets.map(async (k) => (await s.keys.existingFunctionCall(k.account, k.receiver))!.publicKeyString));
  const r = await rotate(s.ctx, targets);
  assert.equal(r.sent, 2 * MARKETS.length);
  for (const o of olds) assert.equal(s.chain.accounts.get(s.l.keeper)!.keys.has(o), false);
});

test("--dry-run (planRotation) sends nothing and creates no key", async () => {
  const s = await deployed();
  const rep = s.l.reporters["h100-fast"]![0]!;
  const snap = JSON.stringify(s.chain.snapshot());
  const files = fileCount(s.keysDir);
  const txs = s.chain.txCount;
  const steps = await planRotation(s.ctx, rotationTargets(s.l, rep));
  assert.deepEqual(steps.map((x) => x.action), ["fresh", "fresh"]);
  assert.equal(JSON.stringify(s.chain.snapshot()), snap);
  assert.equal(fileCount(s.keysDir), files);
  assert.equal(s.chain.txCount, txs);
});

test("killed before or after the add: the next run finishes without a third key", async () => {
  for (const when of ["before", "after"] as const) {
    const s = await deployed();
    const rep = s.l.reporters["h100-weekly"]![1]!;
    const c = s.l.contracts["h100-weekly"]!;
    const old = (await s.keys.existingFunctionCall(rep, c))!.publicKeyString;
    if (when === "before") s.chain.dieBefore = s.chain.txCount + 1;
    else s.chain.dieAfter = s.chain.txCount + 1;
    await assert.rejects(rotate(s.ctx, rotationTargets(s.l, rep, c)), Killed);
    s.chain.dieBefore = null;
    s.chain.dieAfter = null;
    const saved = (await s.keys.allFunctionCall(rep, c)).map((x) => x.key.publicKeyString);
    assert.equal(saved.length, 2, `${when}: the new key was saved before anything was sent`);
    const plan = await planRotation(s.ctx, rotationTargets(s.l, rep, c));
    assert.equal(plan[0]!.action, when === "before" ? "add" : "finish");
    await rotate(s.ctx, rotationTargets(s.l, rep, c));
    assert.equal((await s.keys.allFunctionCall(rep, c)).length, 2, `${when}: no third key generated`);
    const onChain = [...s.chain.accounts.get(rep)!.keys].filter(([, p]) => p !== "FullAccess" && p.FunctionCall.receiver_id === c).map(([pk]) => pk);
    assert.deepEqual(onChain, [saved[1]], `${when}: exactly the new key is on chain`);
    assert.equal(s.chain.accounts.get(rep)!.keys.has(old), false);
  }
});

test("the old key is kept when the new one is not on chain as expected", async () => {
  const s = await deployed();
  const rep = s.l.reporters["h100-fast"]![2]!;
  const c = s.l.contracts["h100-fast"]!;
  const old = (await s.keys.existingFunctionCall(rep, c))!.publicKeyString;
  const send = s.chain.send.bind(s.chain);
  s.chain.send = async (signer, receiver, actions) => {
    const r = await send(signer, receiver, actions);
    // A node that stored a different method list.
    for (const p of s.chain.accounts.get(rep)!.keys.values()) if (p !== "FullAccess" && p.FunctionCall.method_names.length === 2) p.FunctionCall.method_names = ["report"];
    return r;
  };
  await assert.rejects(rotate(s.ctx, rotationTargets(s.l, rep, c)), /is not on chain with the expected permission; the old key is kept/);
  assert.ok(s.chain.accounts.get(rep)!.keys.has(old));
});

test("refusals: contracts, the token, the ops parent, unknown accounts, a contract the account has no key for", async () => {
  const s = await deployed();
  assert.throws(() => rotationTargets(s.l, s.l.contracts["h100-fast"]!), /is a contract account/);
  assert.throws(() => rotationTargets(s.l, s.l.usdc), /is a contract account/);
  assert.throws(() => rotationTargets(s.l, s.l.ops), /is the ops parent/);
  assert.throws(() => rotationTargets(s.l, "mallory.test.near"), /is not an account of this deployment/);
  const agent = s.l.agents.find((a) => a.market === "h100-fast")!.account;
  assert.throws(() => rotationTargets(s.l, agent, s.l.contracts["h100-weekly"]!), /has no function-call key for weir-h100-weekly-r1\.test\.near; its keys are for weir-h100-fast-r1\.test\.near/);
  assert.equal(rotationTargets(s.l, agent).length, 1);
});
