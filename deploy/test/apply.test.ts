import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { base58Encode, KeyPair } from "../../chain/src/tx.ts";
import { apply, StepError } from "../src/apply.ts";
import { Keystore, Redactor, assertOutsideRepo } from "../src/keys.ts";
import { layout, sandboxNetwork, type MarketId } from "../src/layout.ts";
import { checkKeeperEnv, writeOutputs } from "../src/outputs.ts";
import { seal } from "../src/seal.ts";
import { newState, readState } from "../src/state.ts";
import { renderStatus, status } from "../src/status.ts";
import { buildPlan } from "../src/steps.ts";
import { FakeChain, fakeWasm, Killed } from "./fake.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "weir-deploy-test-"));
  dirs.push(d);
  return d;
};
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const wasm = { weir: fakeWasm("weir", 1), usdc: fakeWasm("mock_usdc", 2) };
const NET = sandboxNetwork("http://fake");
const MARKETS: MarketId[] = ["h100-fast", "h100-weekly"];

/** Seeds that are easy to recognise: 32 bytes of 0x01, then of 0x02, and so on (two bytes of a
 * counter once past 250), shared by every keystore of the file so no two keys ever repeat, as
 * with a real random source. */
let seedCounter = 0;
function recognisableSeeds(): () => Uint8Array {
  return () => {
    const n = ++seedCounter;
    const seed = new Uint8Array(32).fill(n % 250 || 250);
    seed[0] = n >> 8;
    seed[1] = n & 0xff;
    return seed;
  };
}

function setup(chain: FakeChain, dirs?: { out: string; keys: string }, seeds = recognisableSeeds()) {
  const out = dirs?.out ?? tmp();
  const keysDir = dirs?.keys ?? tmp();
  const redactor = new Redactor();
  const keys = new Keystore(keysDir, { seed: seeds, redactor });
  const l = layout(NET, "t1", MARKETS);
  keys.loadAll(l.accounts.map((a) => a.id), "t1");
  const plan = buildPlan(l, 3);
  const state = readState(out) ?? newState("sandbox", "t1", MARKETS, "2026-11-12T00:00:00.000Z");
  const lines: string[] = [];
  const log = (s: string) => lines.push(redactor.redact(s));
  let tick = 0;
  const clock = () => new Date(Date.UTC(2026, 10, 12, 0, 0, tick++));
  return { out, keysDir, keys, l, plan, state, lines, redactor, ctx: { chain, keys, plan, wasm, out, state, log, clock } };
}

test("apply sends every step once; a second apply sends nothing", async () => {
  const chain = new FakeChain(wasm);
  const s = setup(chain);
  const r1 = await apply(s.ctx);
  assert.equal(r1.sent, s.plan.steps.length);
  assert.equal(r1.skipped, 0);
  assert.equal(chain.txCount, s.plan.steps.length);
  const snap = JSON.stringify(chain.snapshot());
  const s2 = setup(chain, { out: s.out, keys: s.keysDir });
  const r2 = await apply(s2.ctx);
  assert.equal(r2.sent, 0);
  assert.equal(r2.skipped, s.plan.steps.length);
  assert.equal(chain.txCount, s.plan.steps.length, "no transaction on the second run");
  assert.equal(JSON.stringify(chain.snapshot()), snap);
  // Everything the plan promised is there.
  for (const m of MARKETS) {
    const c = s.l.contracts[m]!;
    assert.equal(chain.accounts.get(c)!.code, wasm.weir.codeHash);
    const p = chain.weir.get(c)!.params;
    assert.deepEqual(p.reporters, s.l.reporters[m]);
    assert.equal(p.usdc, s.l.usdc);
    assert.equal(s.state.t0[m]!.t0, p.t0);
  }
  for (const a of s.l.agents) {
    const acc = chain.weir.get(s.l.contracts[a.market]!)!.accounts.get(a.account)!;
    assert.equal(acc.balance, a.deposit.toString());
    assert.equal(acc.guard, a.guard);
    assert.equal(acc.max_round_lock, a.maxRoundLock.toString());
  }
  const keeper = chain.accounts.get(s.l.keeper)!;
  assert.equal(keeper.keys.size, 1 + MARKETS.length);
  const st = await status(s.l, s.state, chain, s.keys, wasm);
  assert.deepEqual(st.problems, []);
  assert.match(renderStatus(st), /Problems: none/);
});

test("killed at any point, apply resumes and ends where an uninterrupted run ends", async () => {
  const ref = new FakeChain(wasm);
  await apply(setup(ref).ctx);
  const want = JSON.stringify(ref.snapshot());
  const total = ref.txCount;
  // Before and after landing, at the first, an early, a middle, a late and the last transaction.
  for (const n of [1, 2, 6, 7, 30, Math.floor(total / 2), total - 5, total]) {
    for (const when of ["before", "after"] as const) {
      const chain = new FakeChain(wasm);
      const s = setup(chain);
      if (when === "before") chain.dieBefore = n;
      else chain.dieAfter = n;
      await assert.rejects(apply(s.ctx), Killed);
      chain.dieBefore = chain.dieAfter = null;
      const landed = chain.txCount - (when === "before" ? 1 : 0);
      const again = setup(chain, { out: s.out, keys: s.keysDir });
      const r = await apply(again.ctx);
      assert.equal(JSON.stringify(chain.snapshot()), want, `${when} ${n}`);
      assert.equal(r.skipped, landed, `${when} ${n}: the ${landed} landed steps are skipped`);
      // No transaction landed twice: the total equals the uninterrupted run's.
      assert.equal(chain.txCount - (when === "before" ? 1 : 0), total, `${when} ${n}: ${total} transactions in all`);
    }
  }
});

test("a name someone else holds stops apply before anything else is sent", async () => {
  const chain = new FakeChain(wasm);
  const s = setup(chain);
  const stranger = await KeyPair.fromString(`ed25519:${base58Encode(new Uint8Array(32).fill(200))}`);
  await chain.createTopLevel(s.l.usdc, stranger);
  await assert.rejects(apply(s.ctx), (e: unknown) => e instanceof StepError && /another --suffix/.test(e.message));
  assert.equal(chain.txCount, 1);
});

test("the ops account is checked before it pays for anything", async () => {
  const chain = new FakeChain(wasm);
  chain.grant = 2n * 10n ** 24n;
  const s = setup(chain);
  await assert.rejects(apply(s.ctx), /holds 2\.000 NEAR but the \d+ steps it still has to pay for need/);
  assert.equal(chain.sends.filter((x) => x.signer === s.l.ops).length, 0);
});

test("no secret in any log line, the state file, the record or deployments.json; all of them in keeper.env", async () => {
  const chain = new FakeChain(wasm);
  const s = setup(chain);
  await apply(s.ctx);
  await writeOutputs(s.out, s.plan, s.state, chain, s.keys, wasm);
  // Every secret the tool generated, read back from the credentials directory.
  const secrets: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else {
        assert.equal(statSync(p).mode & 0o777, 0o600, `${p} is mode 600`);
        const t = readFileSync(p, "utf8");
        secrets.push(n.endsWith(".swarm-secret") ? t.trim() : (JSON.parse(t) as { private_key: string }).private_key);
      }
    }
  };
  walk(s.keysDir);
  assert.equal(secrets.length, s.l.accounts.length + s.plan.steps.filter((x) => x.kind === "add-key").length + 1);
  // They are recognisable: the first seed is 32 bytes of 0x01.
  assert.ok(secrets.some((x) => x.startsWith("ed25519:") && x.length > 60));
  const env = readFileSync(join(s.out, "keeper.env"), "utf8");
  assert.equal(statSync(join(s.out, "keeper.env")).mode & 0o777, 0o600);
  const check = new Redactor();
  for (const x of secrets) check.add(x);
  const outputs = { log: s.lines.join("\n"), ...Object.fromEntries(["state.json", "record.json", "deployments.json"].map((f) => [f, readFileSync(join(s.out, f), "utf8")])) };
  for (const [name, text] of Object.entries(outputs)) assert.equal(check.leaks(text), false, `${name} holds no secret`);
  // keeper.env holds exactly the function-call keys, and no full-access key.
  for (const a of s.l.accounts) {
    const fa = JSON.parse(readFileSync(join(s.keysDir, `${a.id}.json`), "utf8")) as { private_key: string };
    assert.ok(!env.includes(fa.private_key), `${a.id}'s full-access key is not in keeper.env`);
  }
  for (const st of s.plan.steps.filter((x) => x.kind === "add-key")) assert.ok(env.includes(s.keys.functionCallSecret(st.key!.account, st.key!.receiver)));
  // The shape the keeper is moving to: one key per contract, named by the contract.
  assert.deepEqual(checkKeeperEnv(env, s.l, s.keys), []);
  const vars = Object.fromEntries(env.split("\n").filter((x) => /^[A-Z_]+='/.test(x)).map((x) => [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 2, -1)]));
  assert.deepEqual(Object.keys(vars), ["REPORTERS", "AGENTS", "SWARM_SECRET", "KEEPER"]);
  const reps = JSON.parse(vars.REPORTERS!) as { account_id: string; keys: Record<string, string> }[];
  assert.equal(reps.length, 3);
  for (const r of reps) assert.deepEqual(Object.keys(r.keys), MARKETS.map((m) => s.l.contracts[m]));
  const ags = JSON.parse(vars.AGENTS!) as { account_id: string; market: string; role: string; keys: Record<string, string> }[];
  assert.equal(ags.length, 6 * MARKETS.length);
  for (const a of ags) assert.deepEqual(Object.keys(a.keys), [s.l.contracts[a.market]]);
  assert.deepEqual(ags[0], { account_id: "h100-fast-buyer-1.weir-ops-t1.test.near", market: "h100-fast", role: "buyer", need: 40, premium_bps: 400, keys: ags[0]!.keys });
  const kp = JSON.parse(vars.KEEPER!) as { account_id: string; keys: Record<string, string> };
  assert.equal(kp.account_id, s.l.keeper);
  assert.deepEqual(Object.keys(kp.keys), MARKETS.map((m) => s.l.contracts[m]));
  // A tampered file is caught, and the message holds no secret.
  const tampered = env.replace(Object.values(kp.keys)[0]!, Object.values(kp.keys)[1]!);
  const bad = checkKeeperEnv(tampered, s.l, s.keys);
  assert.ok(bad.length > 0 && !check.leaks(bad.join(" ")));
  // The redactor catches each secret in every form it could be printed in.
  const r = new Redactor();
  r.add(secrets[0]!);
  const raw = secrets[0]!.slice("ed25519:".length);
  assert.equal(r.redact(`a ${secrets[0]} b ${raw} c`), "a [redacted] b [redacted] c");
  assert.throws(() => r.assertClean(`x${raw}`, "f"), (e: unknown) => e instanceof Error && !e.message.includes(raw));
});

test("a corrupt key file is reported without its contents", async () => {
  const d = tmp();
  const ks = new Keystore(d, { seed: recognisableSeeds() });
  await ks.fullAccess("a.test.near");
  const p = join(d, "a.test.near.json");
  const f = JSON.parse(readFileSync(p, "utf8")) as { private_key: string; public_key: string };
  const wrong = { ...f, public_key: "ed25519:11111111111111111111111111111111" };
  writeFileSync(p, JSON.stringify(wrong), { mode: 0o600 });
  const ks2 = new Keystore(d);
  await assert.rejects(ks2.existingFullAccess("a.test.near"), (e: unknown) => e instanceof Error && /does not match/.test(e.message) && !e.message.includes(f.private_key.slice(8, 30)));
  // Keys are never overwritten.
  await assert.rejects(new Keystore(d).fullAccess("a.test.near"));
  assert.throws(() => assertOutsideRepo(new URL("../", import.meta.url).pathname, "keys"), /inside the repository/);
  assert.ok(existsSync(p));
});

test("seal deletes every key of the confirmed market only, after its checks", async () => {
  const chain = new FakeChain(wasm);
  const s = setup(chain);
  await apply(s.ctx);
  const c = s.l.contracts["h100-fast"]!;
  await assert.rejects(seal(s.l, ["h100-fast"], [], chain, s.keys, wasm.weir, s.state, s.out, () => {}), /pass --confirm/);
  await assert.rejects(seal(s.l, ["h100-fast"], [c, "weir-usdc-t1.test.near"], chain, s.keys, wasm.weir, s.state, s.out, () => {}), /names no selected market/);
  chain.weir.get(c)!.params.quorum = 3;
  await assert.rejects(seal(s.l, ["h100-fast"], [c], chain, s.keys, wasm.weir, s.state, s.out, () => {}), /quorum/);
  chain.weir.get(c)!.params.quorum = 2;
  assert.equal(chain.accounts.get(c)!.keys.size, 1);
  await seal(s.l, ["h100-fast"], [c], chain, s.keys, wasm.weir, s.state, s.out, () => {});
  assert.equal(chain.accounts.get(c)!.keys.size, 0);
  assert.equal(chain.accounts.get(s.l.contracts["h100-weekly"]!)!.keys.size, 1, "the other market is untouched");
  assert.equal(chain.accounts.get(s.l.usdc)!.keys.size, 1, "the token is untouched");
  assert.ok(s.state.sealed["h100-fast"]);
  await assert.rejects(seal(s.l, ["h100-fast"], [c], chain, s.keys, wasm.weir, s.state, s.out, () => {}), /already sealed/);
  // apply still recognises the sealed market as done, and sends nothing.
  const again = setup(chain, { out: s.out, keys: s.keysDir });
  const n = chain.txCount;
  assert.equal((await apply(again.ctx)).sent, 0);
  assert.equal(chain.txCount, n);
  const st = await status(s.l, s.state, chain, s.keys, wasm);
  assert.deepEqual(st.problems, []);
  assert.ok(st.contracts.find((x) => x.account === c)!.sealed);
});
