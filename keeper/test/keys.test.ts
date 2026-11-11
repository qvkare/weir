// Function-call keys, one per contract, enforced by the transport as a NEAR node does: a key
// names one receiver and a list of methods. Two markets, both on the fast preset so that both
// settle within the three hours.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MarketId } from "@weir/agents";
import { AGENT_KEY_METHODS, KEEPER_KEY_METHODS, REPORTER_KEY_METHODS } from "@weir/chain";
import { readSecrets } from "../src/config.ts";
import { FAULT_SECS } from "../src/keys.ts";
import type { KeeperEntry, StoredStatus, TickReport } from "../src/keeper.ts";
import type { ModelKey } from "../src/model.ts";
import { KEYS } from "../src/store.ts";
import { AGENTS, agentsFor, contractOf, KEEPER_ACCOUNT, REPORTERS, START, SWARM_SECRET, world, type World } from "./harness.ts";

const MARKETS: MarketId[] = ["h100-fast", "h200-weekly"];
const HOUR = 3600;

/** A distinct fake function-call key for an account on a contract. */
const key = (account: string, contract: string) => `ed25519:FAKEFCKEY${account.replace(/[^a-z0-9]/gi, "")}${contract.replace(/[^a-z0-9]/gi, "")}`;

interface Setup {
  /** Contracts the housekeeping account has a key for, and the receiver each key really names. */
  keeper: Record<string, string>;
}

function keyedWorld(setup: Setup): World {
  const keys: Record<string, ModelKey> = {};
  const issue = (account: string, contract: string, methods: readonly string[], receiver = contract) => {
    const k = key(account, contract);
    keys[k] = { receiver, methods };
    return k;
  };
  const perContract = (account: string, methods: readonly string[]) =>
    Object.fromEntries(MARKETS.map((m) => [contractOf(m), issue(account, contractOf(m), methods)]));
  const vars = {
    REPORTERS: JSON.stringify(REPORTERS.map((id) => ({ account_id: id, keys: perContract(id, REPORTER_KEY_METHODS) }))),
    AGENTS: JSON.stringify(
      MARKETS.flatMap((m) => agentsFor(m, true).map(({ deposit: _d, secret_key: _k, ...a }) => ({ ...a, keys: { [contractOf(m)]: issue(a.account_id, contractOf(m), AGENT_KEY_METHODS) } }))),
    ),
    SWARM_SECRET,
    KEEPER: JSON.stringify({
      account_id: KEEPER_ACCOUNT,
      keys: Object.fromEntries(Object.entries(setup.keeper).map(([contract, receiver]) => [contract, issue(KEEPER_ACCOUNT, contract, KEEPER_KEY_METHODS, receiver)])),
    }),
  };
  assert.deepEqual(readSecrets(vars).problems, []);
  return world({ markets: MARKETS, fast: MARKETS, vars, keys });
}

async function run(w: World, hours = 3): Promise<TickReport[]> {
  const out: TickReport[] = [];
  for (let t = START; t <= START + hours * HOUR; t += 60) out.push(await w.at(t));
  return out;
}

const all = (rs: TickReport[]): KeeperEntry[] => rs.flatMap((r) => r.entries);

async function assertMarketDone(w: World, id: MarketId): Promise<void> {
  const m = w.models[id];
  const committed = new Set(m.market.events.filter((e) => e.event === "commit").map((e) => (e.event === "commit" ? `${e.data.series}/${e.data.round}` : "")));
  const cleared = new Set(m.market.events.filter((e) => e.event === "clear").map((e) => (e.event === "clear" ? `${e.data.series}/${e.data.round}` : "")));
  assert.ok(committed.size >= 20, `${id}: ${committed.size} rounds with commits`);
  for (const r of committed) if (Number(r.split("/")[0]) <= 1) assert.ok(cleared.has(r), `${id} round ${r} cleared`);
  for (const series of [0, 1]) assert.ok((await m.get_series({ series }))?.settlement, `${id} series ${series} settled`);
  assert.ok(m.market.events.some((e) => e.event === "print"), `${id} printed`);
}

test("per-contract keys on two markets: reports, clears, settles and prunes on both, nothing refused", async () => {
  const w = keyedWorld({ keeper: Object.fromEntries(MARKETS.map((m) => [contractOf(m), contractOf(m)])) });
  const reports = await run(w);
  for (const id of MARKETS) {
    await assertMarketDone(w, id);
    assert.deepEqual(await w.models[id].get_results({ series: 0, from_round: 0, limit: 100 }), [], `${id}: series 0 results pruned`);
    assert.ok(all(reports).some((e) => e.market === id && e.action === "prune" && e.status === "done"));
    // The housekeeping account signed every clear and settle.
    const signers = new Set(reports.flatMap((r) => r.txs).filter((t) => t.market === id && (t.method === "clear" || t.method === "settle")).map((t) => t.signer));
    assert.deepEqual([...signers], [KEEPER_ACCOUNT]);
  }
  assert.deepEqual(w.chain.refused, []);
  assert.deepEqual(all(reports).filter((e) => e.status === "failed" || e.action === "key" || e.action === "forfeit"), []);
  for (const [k, v] of w.store.map) assert.ok(!v.includes("FAKEFCKEY"), `per-contract key in store key ${k}`);
});

test("no housekeeping key for one market: its agents clear and settle there, pruning is skipped with one line", async () => {
  const fast = contractOf("h100-fast");
  const w = keyedWorld({ keeper: { [fast]: fast } });
  const reports = await run(w);
  for (const id of MARKETS) await assertMarketDone(w, id);
  const txs = reports.flatMap((r) => r.txs);
  const weeklySigners = new Set(txs.filter((t) => t.market === "h200-weekly" && (t.method === "clear" || t.method === "settle")).map((t) => t.signer));
  assert.ok(!weeklySigners.has(KEEPER_ACCOUNT) && weeklySigners.size >= 1, `signed by ${[...weeklySigners].join(", ")}`);
  assert.ok([...weeklySigners].every((s) => AGENTS.some((a) => a.account_id === s)));
  for (const r of reports) {
    const lines = r.entries.filter((e) => e.action === "key");
    assert.equal(lines.length, 1, `tick ${r.now}: one line`);
    assert.match(lines[0]!.text, new RegExp(`^${KEEPER_ACCOUNT.replace(".", "\\.")} \\(keeper\\) cannot act on h200-weekly: it has no key for ${contractOf("h200-weekly").replace(/\./g, "\\.")}`));
  }
  assert.equal(all(reports).filter((e) => e.market === "h200-weekly" && e.action === "prune").length, 0);
  assert.ok(all(reports).some((e) => e.market === "h100-fast" && e.action === "prune" && e.status === "done"));
  const st = JSON.parse((await w.store.get(KEYS.status))!) as StoredStatus;
  assert.match(st.markets["h200-weekly"]!.pruning, /off: the KEEPER account has no key for/);
  assert.deepEqual(w.chain.refused, [], "nothing was sent without a key");
  assert.deepEqual(all(reports).filter((e) => e.status === "failed" || e.action === "forfeit"), []);
});

test("a key that names the wrong contract: refused once, one log line with the fix, not retried for an hour, and an agent does the work", async () => {
  const fast = contractOf("h100-fast");
  const weekly = contractOf("h200-weekly");
  // The housekeeping account's key listed for the weekly market really names the fast one.
  const w = keyedWorld({ keeper: { [fast]: fast, [weekly]: fast } });
  const reports = await run(w, 2);
  // Two hours, and the key is set aside for one hour after each refusal: tried twice in all,
  // each time one log line, never twice within an hour (let alone within a run).
  const lines = all(reports).filter((e) => e.action === "key");
  assert.equal(w.chain.refused.length, lines.length, `refused: ${w.chain.refused.join("; ")}`);
  assert.equal(lines.length, 2);
  assert.ok(lines[1]!.at - lines[0]!.at >= FAULT_SECS);
  for (const r of w.chain.refused) assert.match(r, new RegExp(`^${KEEPER_ACCOUNT} \\w+ ${weekly} ReceiverMismatch$`));
  assert.match(lines[0]!.text, /the node refused its key \(ReceiverMismatch\)\. Fix: the key names another contract; give keeper\.test a function-call key for weir-h200-weekly\.test/);
  const st = JSON.parse((await w.store.get(KEYS.status))!) as StoredStatus;
  assert.equal(st.key_faults.length, 1);
  assert.equal(st.key_faults[0]!.reason, "ReceiverMismatch");
  // The work was done anyway: every round with commits that is over got cleared, by an agent.
  const m = w.models["h200-weekly"].market;
  const committed = new Set(m.events.filter((e) => e.event === "commit").map((e) => (e.event === "commit" ? `${e.data.series}/${e.data.round}` : "")));
  const cleared = new Set(m.events.filter((e) => e.event === "clear").map((e) => (e.event === "clear" ? `${e.data.series}/${e.data.round}` : "")));
  assert.ok(cleared.size >= committed.size - 1 && cleared.size >= 15);
  assert.ok((await w.models["h200-weekly"].get_series({ series: 0 }))?.settlement);
  assert.deepEqual(all(reports).filter((e) => e.status === "failed" || e.action === "forfeit"), []);
  // Fewer requests than one refusal a turn would cost: the refused key cost 2 requests once.
  assert.ok(reports.every((r) => r.budget.used <= 40));
});
