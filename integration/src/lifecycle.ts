// Scenarios 1 to 4: a whole life of one fast-preset series through `ChainWeir`, with exact
// balances at every step, every refusal of the spec checked on the contract and through the
// client, an agent whose only key is a function-call key, and the model run alongside.
import { AGENT_KEY_METHODS, CallFailed, ChainWeir, REGISTRATION_FEE, Token, type NearAccount } from "../../chain/src/mod.ts";
import { auctionOpen, commitHash, deliveryEnd, roundStart, type Side } from "../../engine/src/mod.ts";
import { NEAR, TGAS, type Signer } from "./accounts.ts";
import type { TwinPort } from "./twin.ts";
import { onGrid, type World } from "./world.ts";

export const SALT = "5a175a175a175a175a175a175a175a17";
const BUNDLE = "0b".repeat(32);
const DOLLAR = 1_000_000n;
const DEPOSIT = 500n * DOLLAR;

export interface LifecycleResult {
  contract: string;
  agentRefusals: Record<string, string>;
  rawRefusals: Record<string, string>;
  gasFloor: { withdraw: number; deposit: number; deposit_short: unknown };
  storageFreed: { prune_result?: number; prune_print?: number };
}

/** The least whole Tgas in [3, 100] for which `works` holds, by bisection (works is monotone). */
async function leastGas(works: (gas: bigint) => Promise<boolean>): Promise<number> {
  let lo = 3;
  let hi = 100;
  if (!(await works(BigInt(hi) * TGAS))) return -1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (await works(BigInt(mid) * TGAS)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

export async function lifecycle(w: World): Promise<LifecycleResult> {
  w.scenario = "lifecycle";
  const rpc = w.sandbox.rpc;
  const root = w.root;

  // Accounts: three reporters, five traders, someone never registered.
  const reporters = await Promise.all(["rep-a", "rep-b", "rep-c"].map((n) => root.createAccount(n)));
  const names = ["alice", "bob", "carol", "dave", "eve", "outsider"] as const;
  const people: Record<(typeof names)[number], Signer> = {} as never;
  for (const n of names) people[n] = await root.createAccount(n);

  const now0 = await w.sandbox.now();
  // Series 0's auction opens about two minutes after setup is expected to be done.
  const t0 = onGrid(now0 + 3900 + 240, 300);
  const params = w.fastParams(reporters.map((r) => r.accountId), t0);
  const { id: weir } = await w.deployWeir("weir-life", params);
  const { twin, tp } = await w.twin(weir);
  twin.scenario = "lifecycle";
  const port = (s: Signer | NearAccount): TwinPort => twin.port("near" in s ? s.near() : s);
  const p = Object.fromEntries(names.map((n) => [n, port(people[n])])) as Record<(typeof names)[number], TwinPort>;
  const reps = reporters.map(port);
  const rootPort = port(root);
  const view = new ChainWeir({ rpc, contractId: weir });
  const free = async (s: Signer) => BigInt((await view.get_account({ account_id: s.accountId }))?.balance ?? "-1");
  const pos = (s: Signer, series = 0) => view.get_position({ series, account_id: s.accountId });

  w.eq("get_params is the fast preset with usdc, reporters and t0 replaced", await view.get_params({}), params);

  // The agent: an account whose only key is a function-call key limited to AGENT_KEY_METHODS.
  const agentSigner = await root.createAccount("agent", {
    balance: 5n * NEAR,
    permission: { receiverId: weir, methodNames: [...AGENT_KEY_METHODS], allowance: NEAR },
  });
  const agent = port(agentSigner);
  const keys = await rpc.call<{ keys: { access_key: { permission: unknown } }[] }>("query", { request_type: "view_access_key_list", finality: "final", account_id: agentSigner.accountId });
  w.eq("the agent account holds exactly one key, a function-call key for Weir", keys.keys.map((k) => k.access_key.permission), [
    { FunctionCall: { allowance: NEAR.toString(), receiver_id: weir, method_names: [...AGENT_KEY_METHODS] } },
  ]);

  // Section 5: registration, the token, deposits with ft_transfer_call.
  for (const n of ["alice", "bob", "carol", "dave", "eve"] as const) {
    const s = people[n];
    w.tokenOk("storage_deposit", await w.token.storageDeposit(s.near()), 10n * TGAS);
    await w.mint(s.near(), s.accountId, 1_000n * DOLLAR);
    const nearBefore = BigInt((await rpc.viewAccount(s.accountId)).amount);
    await p[n].call("register", {});
    const nearAfter = BigInt((await rpc.viewAccount(s.accountId)).amount);
    w.check(`${n}: register costs the 0.02 NEAR fee plus gas, no more`, nearBefore - nearAfter >= REGISTRATION_FEE && nearBefore - nearAfter < REGISTRATION_FEE + NEAR / 100n, { spent: (nearBefore - nearAfter).toString() });
    w.eq(`${n}: deposit returns the amount Weir kept`, await p[n].call("deposit", { amount: DEPOSIT.toString() }), DEPOSIT.toString());
    w.eq(`${n}: free balance after deposit`, await free(s), DEPOSIT);
    w.eq(`${n}: token balance after deposit`, await w.usdcBalance(s.accountId), 500n * DOLLAR);
  }
  await w.mint(root.near(), root.accountId, 1_000_000n * DOLLAR);
  await rootPort.call("register", { account_id: agentSigner.accountId });
  w.eq("root deposits for the agent (msg names it)", await rootPort.call("deposit", { amount: (100n * DOLLAR).toString(), msg: agentSigner.accountId }), (100n * DOLLAR).toString());
  w.eq("agent: free balance", await free(agentSigner), 100n * DOLLAR);
  w.eq("contract token balance after deposits", await w.usdcBalance(weir), 5n * DEPOSIT + 100n * DOLLAR);

  // Refusals of section 5 (scenario 3).
  await w.rejects("register twice is refused", () => p.alice.call("register", {}), /already registered/);
  w.eq("deposit crediting an unregistered account keeps nothing", await p.alice.call("deposit", { amount: "1000000", msg: people.outsider.accountId }), "0");
  w.eq("deposit with a msg that is not an account id keeps nothing", await p.alice.call("deposit", { amount: "1000000", msg: "Not An Account!" }), "0");
  w.eq("alice's token balance is unchanged by the two refunded deposits", await w.usdcBalance(people.alice.accountId), 500n * DOLLAR);
  await w.rejects("withdraw above the free balance is refused", () => p.bob.call("withdraw", { amount: (DEPOSIT + 1n).toString() }), /balance/);
  await w.rejects("withdraw of zero is refused", () => p.bob.call("withdraw", { amount: "0" }), /above zero/);
  await w.rejects("an unregistered account cannot set a guard", () => p.outsider.call("set_guard", { guard: 1 }), /not registered/);
  await w.booksBalance("after deposits", weir);
  await twin.checkpoint("after deposits", { tp, series: [0], accounts: allIds() });

  // A missing yoctoNEAR: sent without ChainWeir, which always attaches it.
  const rawRefusals: Record<string, string> = {};
  for (const [method, args] of [
    ["withdraw", { amount: "1" }],
    ["set_guard", { guard: 1 }],
    ["transfer_position", { series: 0, to: people.bob.accountId, long: 1, short: 0 }],
  ] as const) {
    for (const deposit of [0n, 2n]) {
      const o = await people.alice.near().functionCall(weir, method, args, 50n * TGAS, deposit);
      const surfaced = o.ok ? "(succeeded)" : new CallFailed(o).message;
      rawRefusals[`${method} with ${deposit} yoctoNEAR`] = surfaced;
      w.check(`${method} with ${deposit} yoctoNEAR attached is refused with the 1-yocto message`, !o.ok && surfaced === "requires exactly 1 yoctoNEAR attached", surfaced);
    }
  }

  // Sections 5 and 6.4: Eve's guard, Bob's round lock limit.
  const FEE = BigInt(params.commit_fee);
  w.eq("the fast preset burns 0.02 per commit", FEE, 20_000n);
  await p.eve.call("set_guard", { guard: 5_000 });
  w.eq("eve's guard is set", await view.get_account({ account_id: people.eve.accountId }), { balance: DEPOSIT.toString(), guard: 5_000, max_round_lock: null });
  await p.bob.call("set_guard", { max_round_lock: "2000000" });
  w.eq("bob's round lock limit is set", await view.get_account({ account_id: people.bob.accountId }), { balance: DEPOSIT.toString(), guard: null, max_round_lock: "2000000" });

  // The auction opens. No print yet: the series cannot open.
  const open = auctionOpen(tp, 0);
  await w.sandbox.warpTo(open + 2);
  const r0 = 0;
  const hashOf = (who: Signer, round: number, side: Side, size: number, price: number, salt = SALT) =>
    commitHash({ series: 0, round, accountId: who.accountId, side, size, price, salt });
  await w.rejects("commit before any print: index is stale", () => p.alice.call("commit", { series: 0, hash: hashOf(people.alice, r0, "Long", 10, 310_000), lock: "3100000" }), /^commit by .* index is stale$/);
  await w.rejects("mint before any print: index is stale", () => p.dave.call("mint", { series: 0, sets: 1 }), /index is stale/);

  // Section 9: a print at the auction's opening bucket, decided by all three reporters.
  const b0 = open; // a multiple of 300, since t0 and lead_secs are
  const report = (k: number, bucket: number, price: number) => reps[k]!.call("report", { bucket, price, bundle: BUNDLE });
  await w.rejects("report by a non-reporter is refused", () => p.alice.call("report", { bucket: b0, price: 2_000_000, bundle: BUNDLE }), /not a reporter/);
  await w.rejects("report for a bucket off the grid is refused", () => report(0, b0 + 1, 2_000_000), /multiple of print_interval_secs/);
  await w.rejects("report with an uppercase bundle is refused", () => reps[0]!.call("report", { bucket: b0, price: 2_000_000, bundle: "0B".repeat(32) }), /bundle/);
  await w.rejects("report of price zero is refused", () => report(0, b0, 0), /price must be above zero/);
  await w.rejects("report for a future bucket is refused", () => report(0, b0 + 600, 2_000_000), /report window/);
  w.eq("first report does not decide", await report(0, b0, 2_000_000), false);
  await w.rejects("a reporter's second report for an undecided bucket is refused", () => report(0, b0, 2_000_000), /already reported/);
  w.eq("second report does not decide either (quorum 2, but a third reporter may still come)", await report(1, b0, 2_000_000), false);
  w.eq("the third report decides the bucket: all three reported", await report(2, b0, 2_000_000), true);
  w.eq("a repeat report on a decided bucket returns false, not a panic", await report(0, b0, 2_000_000), false);
  w.eq("get_last_print", await view.get_last_print({}), { bucket: b0, price: 2_000_000 });
  w.eq("get_print state", (await view.get_print({ bucket: b0 }))?.state, "Final");

  // Round 0: sealed orders (section 6.2).
  w.check("round 0 is in its commit phase", (await w.sandbox.now()) < roundStart(tp, 0, 0) + 150);
  await w.rejects("an unregistered account cannot commit", () => p.outsider.call("commit", { series: 0, hash: hashOf(people.outsider, r0, "Long", 1, 300_000), lock: "1000000" }), /not registered/);
  await w.rejects("a lock below min_lock is refused", () => p.alice.call("commit", { series: 0, hash: hashOf(people.alice, r0, "Long", 3, 300_000), lock: "999999" }), /min_lock/);
  await w.rejects("an uppercase hash is refused", () => p.alice.call("commit", { series: 0, hash: hashOf(people.alice, r0, "Long", 3, 300_000).toUpperCase(), lock: "1000000" }), /hash must be 64 lowercase hex/);
  await w.rejects("a lock above the free balance is refused", () => p.alice.call("commit", { series: 0, hash: hashOf(people.alice, r0, "Long", 3, 300_000), lock: (DEPOSIT + 1n).toString() }), /balance/);
  await w.rejects("a lock equal to the free balance is refused: the fee must fit too", () => p.alice.call("commit", { series: 0, hash: hashOf(people.alice, r0, "Long", 3, 300_000), lock: (DEPOSIT - FEE + 1n).toString() }), /free balance is too low/);
  const seq = {
    alice: await p.alice.call("commit", { series: 0, hash: hashOf(people.alice, r0, "Long", 10, 310_000), lock: "3100000" }),
    bob: await p.bob.call("commit", { series: 0, hash: hashOf(people.bob, r0, "Long", 5, 300_000), lock: "1500000" }),
    carol: await p.carol.call("commit", { series: 0, hash: hashOf(people.carol, r0, "Short", 8, 290_000), lock: "2480000" }),
    carolHidden: await p.carol.call("commit", { series: 0, hash: hashOf(people.carol, r0, "Short", 4, 350_000), lock: "1000000" }),
    eve: await p.eve.call("commit", { series: 0, hash: hashOf(people.eve, r0, "Long", 4, 320_000), lock: "1280000" }),
    // Dave's order costs 3_000_000 but locks 1_000_000: its reveal will be refused.
    daveUnder: await p.dave.call("commit", { series: 0, hash: hashOf(people.dave, r0, "Long", 10, 300_000), lock: "1000000" }),
  };
  w.eq("commits get seq 0, 1, 2, ... in order", Object.values(seq), [0, 1, 2, 3, 4, 5]);
  // Bob's limit is 2.00 a round; he holds 1.50, so another 1.00 is refused, after the balance check.
  await w.rejects("over the round lock limit", () => p.bob.call("commit", { series: 0, hash: hashOf(people.bob, r0, "Long", 2, 300_000), lock: "1000000" }), /^commit by .* over the round lock limit$/);
  await w.rejects("the balance is checked before the round lock limit", () => p.bob.call("commit", { series: 0, hash: hashOf(people.bob, r0, "Long", 2, 300_000), lock: (DEPOSIT * 2n).toString() }), /free balance is too low$/);
  // Eve widens her guard after committing: her order was settled as void at commit, so this changes nothing.
  await p.eve.call("set_guard", { guard: 50_000 });
  const series = await view.get_series({ series: 0 });
  w.eq("the series opened on the print: anchor, floor and band (section 6.1)", series && { anchor: series.anchor, floor: series.floor, band: series.band }, { anchor: 2_000_000, floor: 1_700_000, band: 600_000 });
  await p.dave.call("mint", { series: 0, sets: 2 });
  await w.rejects("mint of zero sets is refused", () => p.dave.call("mint", { series: 0, sets: 0 }), /sets must be above zero/);
  w.eq("alice free after her lock and fee", await free(people.alice), DEPOSIT - 3_100_000n - FEE);
  w.eq("carol free after two locks and fees", await free(people.carol), DEPOSIT - 3_480_000n - 2n * FEE);
  w.eq("dave free after mint, lock and fee", await free(people.dave), DEPOSIT - 1_200_000n - 1_000_000n - FEE);
  w.eq("each commit in get_round carries its fee", (await view.get_round({ series: 0, round: r0 }))?.commits.map((c) => c.fee), Array(6).fill(FEE.toString()));
  w.eq("dave holds the minted sets", await pos(people.dave), { long: 2, short: 2 });
  await w.rejects("reveal during the commit phase is refused", () => p.alice.call("reveal", { series: 0, round: r0, seq: seq.alice, side: "Long", size: 10, price: 310_000, salt: SALT }), /reveal phase/);
  await w.rejects("clear during the commit phase is refused", () => p.bob.call("clear", { series: 0, round: r0 }), /not over/);
  await w.booksBalance("after commits", weir);
  await twin.checkpoint("round 0 commit phase", { tp, series: [0], accounts: allIds(), hashes: [{ series: 0, round: r0, account_id: people.alice.accountId, side: "Long", size: 10, price: 310_000, salt: SALT }] });

  // Reveals (section 6.3).
  await w.sandbox.warpTo(roundStart(tp, 0, r0) + tp.commitSecs + 1);
  await w.rejects("commit during the reveal phase is refused", () => p.bob.call("commit", { series: 0, hash: hashOf(people.bob, r0, "Long", 2, 300_000), lock: "1000000" }), /commit phase/);
  await w.rejects("a reveal with the wrong price (wrong hash) is refused", () => p.bob.call("reveal", { series: 0, round: r0, seq: seq.bob, side: "Long", size: 5, price: 301_000, salt: SALT }), /do not match the hash/);
  await w.rejects("a reveal of someone else's commit is refused", () => p.bob.call("reveal", { series: 0, round: r0, seq: seq.alice, side: "Long", size: 10, price: 310_000, salt: SALT }), /does not own/);
  await w.rejects("a reveal with a short salt is refused", () => p.bob.call("reveal", { series: 0, round: r0, seq: seq.bob, side: "Long", size: 5, price: 300_000, salt: "5a17" }), /salt/);
  await w.rejects("a reveal of a seq that does not exist is refused", () => p.bob.call("reveal", { series: 0, round: r0, seq: 99, side: "Long", size: 5, price: 300_000, salt: SALT }), /not found/);
  await w.rejects("an under-locked reveal is refused", () => p.dave.call("reveal", { series: 0, round: r0, seq: seq.daveUnder, side: "Long", size: 10, price: 300_000, salt: SALT }), /lock does not cover the order/);
  await p.alice.call("reveal", { series: 0, round: r0, seq: seq.alice, side: "Long", size: 10, price: 310_000, salt: SALT });
  await p.bob.call("reveal", { series: 0, round: r0, seq: seq.bob, side: "Long", size: 5, price: 300_000, salt: SALT });
  await p.carol.call("reveal", { series: 0, round: r0, seq: seq.carol, side: "Short", size: 8, price: 290_000, salt: SALT });
  await p.eve.call("reveal", { series: 0, round: r0, seq: seq.eve, side: "Long", size: 4, price: 320_000, salt: SALT });
  await w.rejects("a second reveal of the same commit is refused", () => p.alice.call("reveal", { series: 0, round: r0, seq: seq.alice, side: "Long", size: 10, price: 310_000, salt: SALT }), /already revealed/);
  w.eq("eve's LONG is void by the guard and reference recorded at commit (the guard changed since), her lock is back, her fee is not", await free(people.eve), DEPOSIT - FEE);
  const book = await view.get_round({ series: 0, round: r0 });
  w.eq("get_round states", book?.commits.map((c) => c.state), ["Revealed", "Revealed", "Revealed", "Committed", "Void", "Committed"]);
  await w.rejects("clear during the reveal phase is refused", () => p.bob.call("clear", { series: 0, round: r0 }), /not over/);
  await twin.checkpoint("round 0 reveal phase", { tp, series: [0], accounts: allIds() });

  // Clearing (section 7): V* = 8 at 0.290, 0.300 and 0.310; the smallest |D - S| is at 0.310.
  await w.sandbox.warpTo(roundStart(tp, 0, r0 + 1) + 1);
  await p.bob.call("clear", { series: 0, round: r0 });
  await w.rejects("a second clear is refused", () => p.bob.call("clear", { series: 0, round: r0 }), /already cleared/);
  const result = await view.get_result({ series: 0, round: r0 });
  w.eq("clearing price, volume, forfeits and fees", result && { price: result.price, volume: result.volume, long_size: result.long_size, short_size: result.short_size, orders: result.orders, commits: result.commits, forfeited: result.forfeited, fees: result.fees }, {
    price: 310_000, volume: 8, long_size: 15, short_size: 8, orders: 3, commits: 6, forfeited: "20000", fees: (6n * FEE).toString(),
  });
  w.eq("fills list only the filled orders", result?.fills.map((f) => [f.owner.split(".")[0], f.side, f.filled]), [["alice", "Long", 8], ["carol", "Short", 8]]);
  w.eq("alice free after clearing", await free(people.alice), DEPOSIT - 8n * 310_000n - FEE);
  w.eq("bob free after clearing (nothing filled, fee burned)", await free(people.bob), DEPOSIT - FEE);
  w.eq("carol free after clearing (paid 8 x 0.29, forfeited 1% of 1.00, two fees)", await free(people.carol), DEPOSIT - 8n * 290_000n - 10_000n - 2n * FEE);
  w.eq("dave free after clearing (forfeited 1% of 1.00, one fee)", await free(people.dave), DEPOSIT - 1_200_000n - 10_000n - FEE);
  w.eq("positions", [await pos(people.alice), await pos(people.bob), await pos(people.carol)], [{ long: 8, short: 0 }, { long: 0, short: 0 }, { long: 0, short: 8 }]);
  w.eq("open_sets and pending rounds", await view.get_series({ series: 0 }).then((s) => s && [s.open_sets, s.pending_rounds]), [10, []]);
  w.eq("burned: forfeits and every fee of the round", (await view.get_totals({})).burned, (20_000n + 6n * FEE).toString());
  await w.booksBalance("after clearing round 0", weir);

  // Round 1: the agent trades with its function-call key: LONG 4 and SHORT 4 at 0.300, mint 2, merge 1.
  const r1 = r0 + 1;
  const agentSeqL = await agent.call("commit", { series: 0, hash: hashOf(agentSigner, r1, "Long", 4, 300_000), lock: "1200000" });
  const agentSeqS = await agent.call("commit", { series: 0, hash: hashOf(agentSigner, r1, "Short", 4, 300_000), lock: "1200000" });
  await agent.call("mint", { series: 0, sets: 2 });
  await agent.call("merge", { series: 0, sets: 1 });
  await p.dave.call("merge", { series: 0, sets: 1 });
  await w.rejects("merge of more sets than held is refused", () => p.dave.call("merge", { series: 0, sets: 5 }), /position is too small/);
  const agentRefusals: Record<string, string> = {};
  for (const [method, args] of [
    ["withdraw", { amount: "1" }],
    ["set_guard", { guard: 1, max_round_lock: "1" }],
    ["transfer_position", { series: 0, to: people.bob.accountId, long: 1, short: 0 }],
    ["register", {}],
    ["report", { bucket: b0, price: 1, bundle: BUNDLE }],
    ["finalize_print", { bucket: b0 }],
    ["prune_print", { bucket: b0 }],
    ["prune_result", { series: 0, round: 0 }],
    ["deposit", { amount: "1" }],
  ] as const) {
    const msg = await w.rejects(`agent key: ${method} is refused before any code runs`, () => agent.call(method as never, args as never), method === "deposit" ? /ReceiverMismatch|InvalidAccessKeyError/ : /MethodNameMismatch|DepositWithFunctionCall|InvalidAccessKeyError/);
    agentRefusals[method] = msg;
  }
  await w.sandbox.warpTo(roundStart(tp, 0, r1) + tp.commitSecs + 1);
  await agent.call("reveal", { series: 0, round: r1, seq: agentSeqL, side: "Long", size: 4, price: 300_000, salt: SALT });
  await agent.call("reveal", { series: 0, round: r1, seq: agentSeqS, side: "Short", size: 4, price: 300_000, salt: SALT });
  await w.sandbox.warpTo(roundStart(tp, 0, r1 + 1) + 1);
  await agent.call("clear", { series: 0, round: r1 });
  w.eq("agent: position after its round", await pos(agentSigner), { long: 5, short: 5 });
  w.eq("agent: free after its round (4 sets bought at 0.30 + 0.30, 2 minted, 1 merged, two fees)", await free(agentSigner), 100n * DOLLAR - 3_000_000n - 2n * FEE);
  w.eq("dave: free after merging one set", await free(people.dave), DEPOSIT - 1_200_000n - 10_000n - FEE + 600_000n);
  w.eq("open_sets", (await view.get_series({ series: 0 }))?.open_sets, 14);
  // Round 2 holds nothing: clearing it after it is over is refused.
  await w.sandbox.warpTo(roundStart(tp, 0, r1 + 2) + 1);
  await w.rejects("clear of a round with no commits is refused", () => p.bob.call("clear", { series: 0, round: r1 + 1 }), /no commits/);
  await w.booksBalance("after the agent's round", weir);
  await twin.checkpoint("after round 1", { tp, series: [0], accounts: allIds() });

  // Delivery (section 9): every way a bucket can be decided.
  const B = (i: number) => t0 + i * 300;
  const eventsOf = async (k: number, bucket: number, price: number) => {
    const r = twin.replay(await reps[k]!.send("report", { bucket, price, bundle: BUNDLE }));
    return { result: r.chain.result, events: r.chain.events.map((e) => JSON.parse(e.slice(11)) as { event: string; data: { bucket?: number } }).map((e) => `${e.event}${e.data.bucket === bucket ? "" : `@${e.data.bucket}`}`) };
  };
  // B0: all three.
  await w.sandbox.warpTo(B(0) + 1);
  w.eq("B0: two reports leave it open", [await report(0, B(0), 2_000_000), await report(1, B(0), 2_000_000)], [false, false]);
  w.eq("B0: the third reporter decides it", await report(2, B(0), 2_000_000), true);
  // B1: two that agree within max_spread_bps (1%), decided by finalize_print once the window closes.
  await w.sandbox.warpTo(B(1) + 1);
  w.eq("B1: two agreeing reports", [await report(0, B(1), 2_000_000), await report(1, B(1), 2_020_000)], [false, false]);
  w.eq("B1 is pending", await view.get_pending_prints({}), [B(1)]);
  w.eq("B1 is open, without a price", await view.get_print({ bucket: B(1) }).then((x) => x && [x.state, x.price]), ["Open", null]);
  await w.rejects("finalize_print while the window is open is refused", () => p.bob.call("finalize_print", { bucket: B(1) }), /has not closed/);
  await w.sandbox.warpTo(B(2) + 61);
  w.eq("B1: finalize_print after the window gives a print", await p.bob.call("finalize_print", { bucket: B(1) }), true);
  w.eq("B1: the mean of the two", await view.get_print({ bucket: B(1) }).then((x) => x && [x.state, x.price]), ["Final", 2_010_000]);
  await w.rejects("finalize_print twice is refused", () => p.bob.call("finalize_print", { bucket: B(1) }), /already decided/);
  await w.rejects("finalize_print of a bucket with no reports is refused", () => p.bob.call("finalize_print", { bucket: t0 - 600 }), /no reports/);
  await w.rejects("a report for a bucket whose window has closed is refused", () => report(2, B(1), 2_000_000), /report window/);
  // B2: two that agree, decided by a later report.
  w.eq("B2: two agreeing reports", [await report(0, B(2), 2_100_000), await report(1, B(2), 2_100_000)], [false, false]);
  await w.sandbox.warpTo(B(3) + 61);
  w.eq("B3's first report decides B2, events in order", await eventsOf(0, B(3), 2_000_000), { result: false, events: ["report", `print@${B(2)}`] });
  // B3: two that disagree by 10%: no print, through finalize_print.
  w.eq("B3: a second, far report", await report(1, B(3), 2_200_000), false);
  await w.sandbox.warpTo(B(4) + 61);
  w.eq("B3: finalize_print decides it without a print", await p.bob.call("finalize_print", { bucket: B(3) }), false);
  w.eq("B3: NoPrint", await view.get_print({ bucket: B(3) }).then((x) => x && [x.state, x.price]), ["NoPrint", null]);
  // B4: one report, below quorum, decided as no print by a later report.
  w.eq("B4: a lone report", await report(0, B(4), 2_000_000), false);
  await w.sandbox.warpTo(B(5) + 61);
  w.eq("B5's first report decides B4 without a print", await eventsOf(0, B(5), 2_300_000), { result: false, events: ["report", `no_print@${B(4)}`] });
  w.eq("B5: the median of three", [await report(1, B(5), 2_400_000), await report(2, B(5), 2_500_000)], [false, true]);
  w.eq("B5: price", (await view.get_print({ bucket: B(5) }))?.price, 2_400_000);
  for (const [i, price] of [[6, 2_300_000], [7, 2_200_000], [8, 2_100_000], [9, 2_000_000]] as const) {
    await w.sandbox.warpTo(B(i) + 1);
    for (const k of [0, 1, 2]) await report(k, B(i), price);
  }
  // B10 and B11: two agreeing reports each, left for settle to decide.
  await w.sandbox.warpTo(B(10) + 1);
  await report(0, B(10), 1_900_000);
  await report(1, B(10), 1_900_000);
  await w.sandbox.warpTo(B(11) + 1);
  await report(0, B(11), 1_950_000);
  await report(1, B(11), 1_970_000);
  w.eq("B10 and B11 are pending", await view.get_pending_prints({}), [B(10), B(11)]);
  w.eq("accumulator before settlement", await view.get_accumulator({ series: 0 }), { sum: "17110000", count: 8 });
  await w.rejects("settle of a series never opened is refused", () => p.bob.call("settle", { series: 9 }), /not found|not open/);
  await w.rejects("redeem on a series never opened is refused", () => p.bob.call("redeem", { series: 9 }), /not found|not open|not settled/);
  await w.rejects("clear on a series never opened is refused", () => p.bob.call("clear", { series: 9, round: 0 }), /.+/);
  await w.rejects("settle before the last report window closes is refused", () => agent.call("settle", { series: 0 }), /report window of the delivery/);
  await w.rejects("redeem before settlement is refused", () => agent.call("redeem", { series: 0 }), /not settled/);
  await twin.checkpoint("after delivery reports", { tp, series: [0], accounts: allIds(), buckets: [B(3), B(4), B(10), B(11)] });

  // Settlement (section 10), by the agent's function-call key; it decides B10 and B11 first.
  await w.sandbox.warpTo(deliveryEnd(tp, 0) + params.report_grace_secs + 1);
  const settleRecord = twin.replay(await agent.send("settle", { series: 0 }));
  w.eq("settle decides the pending buckets, then settles", settleRecord.chain.events.map((e) => JSON.parse(e.slice(11)).event), ["print", "print", "settle"]);
  w.eq("nothing is pending after settlement", await view.get_pending_prints({}), []);
  await w.rejects("settling twice is refused", () => p.bob.call("settle", { series: 0 }), /settled/);
  const settled = (await view.get_series({ series: 0 }))?.settlement;
  // 20_970_000 / 10 = 2_097_000; LONG pays 0.397, SHORT 0.203.
  w.eq("settlement", settled && { ...settled, settled_at: 0 }, { fixing: 2_097_000, long_payout: 397_000, short_payout: 203_000, prints: 10, void: false, settled_at: 0 });
  await w.booksBalance("after settlement", weir);

  // Section 8: positions still move after settlement.
  await p.carol.call("transfer_position", { series: 0, to: people.bob.accountId, long: 0, short: 2 });
  await w.rejects("transfer to yourself is refused", () => p.carol.call("transfer_position", { series: 0, to: people.carol.accountId, long: 0, short: 1 }), /yourself/);
  await w.rejects("transfer of more than held is refused", () => p.carol.call("transfer_position", { series: 0, to: people.bob.accountId, long: 1, short: 0 }), /position is too small/);
  await w.rejects("transfer of nothing is refused", () => p.carol.call("transfer_position", { series: 0, to: people.bob.accountId, long: 0, short: 0 }), /at least 1/);
  await w.rejects("transfer to an unregistered account is refused", () => p.carol.call("transfer_position", { series: 0, to: people.outsider.accountId, long: 0, short: 1 }), /not registered/);

  // Redemption: anyone for anyone. No bonus in 0.4.
  await p.bob.call("redeem", { series: 0, account_id: people.alice.accountId });
  await p.bob.call("redeem", { series: 0 });
  await p.carol.call("redeem", { series: 0 });
  await p.dave.call("redeem", { series: 0 });
  await agent.call("redeem", { series: 0 });
  await w.rejects("redeem with no position: nothing to redeem", () => p.eve.call("redeem", { series: 0 }), /nothing to redeem/);
  await w.rejects("redeem twice: nothing to redeem", () => p.bob.call("redeem", { series: 0, account_id: people.alice.accountId }), /nothing to redeem/);
  const expected = {
    alice: DEPOSIT - 8n * 310_000n - FEE + 8n * 397_000n,
    bob: DEPOSIT - FEE + 2n * 203_000n,
    carol: DEPOSIT - 8n * 290_000n - 10_000n - 2n * FEE + 6n * 203_000n,
    dave: DEPOSIT - 1_200_000n - 10_000n - FEE + 600_000n + 600_000n,
    agent: 100n * DOLLAR - 3_000_000n - 2n * FEE + 5n * 600_000n,
    eve: DEPOSIT - FEE,
  };
  w.eq("alice after redemption", await free(people.alice), expected.alice);
  w.eq("bob after redemption (2 SHORT from carol)", await free(people.bob), expected.bob);
  w.eq("carol after redemption (6 SHORT)", await free(people.carol), expected.carol);
  w.eq("dave after redemption (1 set)", await free(people.dave), expected.dave);
  w.eq("agent after redemption (5 sets)", await free(agentSigner), expected.agent);
  w.eq("eve: only her fee is gone", await free(people.eve), expected.eve);
  const burned = 20_000n + 8n * FEE;
  w.eq("totals after redemption: free balances and what was burned", await view.get_totals({}), {
    free: Object.values(expected).reduce((a, b) => a + b, 0n).toString(), locked: "0", sets_backing: "0", unredeemed: "0", burned: burned.toString(),
  });
  w.eq("every dollar deposited is free or burned", Object.values(expected).reduce((a, b) => a + b, 0n) + burned, 5n * DEPOSIT + 100n * DOLLAR);
  await w.booksBalance("after redemption", weir);

  // Pruning (section 14) releases the contract's storage.
  const storage = async () => (await rpc.viewAccount(weir)).storage_usage;
  let before = await storage();
  await p.bob.call("prune_result", { series: 0, round: r0 });
  const afterResult = await storage();
  w.check("prune_result releases storage", afterResult < before, { before, after: afterResult });
  storageFreed.prune_result = before - afterResult;
  w.eq("a pruned result is gone", await view.get_result({ series: 0, round: r0 }), null);
  await w.rejects("pruning a result twice is refused", () => p.bob.call("prune_result", { series: 0, round: r0 }), /result not found/);
  await w.rejects("prune_print before two periods is refused", () => p.bob.call("prune_print", { bucket: B(0) }), /two periods/);
  await w.rejects("prune_print of a bucket with no reports is refused", () => p.bob.call("prune_print", { bucket: t0 - 600 }), /no reports/);
  const lateBucket = Math.floor((await w.sandbox.now()) / 300) * 300;
  await report(0, lateBucket, 2_000_000);
  await w.rejects("prune_print of an undecided bucket is refused", () => p.bob.call("prune_print", { bucket: lateBucket }), /not decided/);
  await w.sandbox.warpTo(B(3) + 2 * tp.periodSecs + 1);
  const lastBefore = await view.get_last_print({});
  const accBefore = await view.get_accumulator({ series: 0 });
  before = await storage();
  await p.bob.call("prune_print", { bucket: B(0) });
  const afterPrint = await storage();
  w.check("prune_print of a final print releases storage", afterPrint < before, { before, after: afterPrint });
  storageFreed.prune_print = before - afterPrint;
  await p.bob.call("prune_print", { bucket: B(3) });
  w.check("prune_print of a NoPrint bucket releases storage", (await storage()) < afterPrint);
  w.eq("pruned buckets read null", [await view.get_print({ bucket: B(0) }), await view.get_print({ bucket: B(3) })], [null, null]);
  w.eq("pruning keeps the last print and the accumulator", [await view.get_last_print({}), await view.get_accumulator({ series: 0 })], [lastBefore, accBefore]);

  // Alice takes everything out.
  await p.alice.call("withdraw", { amount: expected.alice.toString() });
  w.eq("alice: free balance after withdrawing everything", await free(people.alice), 0n);
  w.eq("alice: token balance after withdrawing", await w.usdcBalance(people.alice.accountId), 500n * DOLLAR + expected.alice);
  w.eq("contract: token balance after alice's withdrawal", await w.usdcBalance(weir), 5n * DEPOSIT + 100n * DOLLAR - expected.alice);
  await w.booksBalance("at the end", weir);
  await twin.checkpoint("end of life", { tp, series: [0, 1], accounts: allIds(), buckets: [B(0), B(3), lateBucket] });

  // The agent's allowance: what its calls cost the key, against the gas they burnt.
  const ak = await rpc.viewAccessKey(agentSigner.accountId, agentSigner.key.publicKeyString);
  const allowance = typeof ak.permission === "object" ? BigInt(ak.permission.FunctionCall.allowance ?? "0") : 0n;
  w.check("the agent's key still has allowance left", allowance > 0n, { allowance_left: allowance.toString() });
  agentAllowanceUsed = NEAR - allowance;

  // Section 5: a token that is not `usdc` is refused. Its ft_on_transfer panics, so the token
  // refunds everything and the client sees "0" kept.
  const fake = await root.createAccount("fake-usdc", { code: w.wasm.usdc.bytes });
  const fakeToken = new Token(rpc, fake.accountId);
  w.tokenOk("storage_deposit", await fakeToken.storageDeposit(root.near(), weir), 10n * TGAS);
  w.tokenOk("mint", await fakeToken.mint(people.bob.near(), people.bob.accountId, "5000000"), 10n * TGAS);
  const wrongToken = new ChainWeir({ rpc, account: people.bob.near(), contractId: weir, usdcId: fake.accountId });
  const bobBefore = await free(people.bob);
  w.eq("a deposit of another token keeps nothing", await wrongToken.deposit({ amount: "5000000" }), "0");
  w.eq("a deposit of another token credits nothing", await free(people.bob), bobBefore);
  w.eq("a deposit of another token is refunded in full", await fakeToken.balanceOf(people.bob.accountId), "5000000");

  // The least gas `withdraw` and a deposit (`ft_transfer_call`) can be sent with and still do
  // their whole job: both reserve static gas for the calls they make, so the gas they burn is
  // not the gas they need. Raw calls, after the last checkpoint: the model does not follow.
  const bob = people.bob.near();
  const gasFloor = {
    withdraw: await leastGas(async (g) => {
      const o = await bob.functionCall(weir, "withdraw", { amount: "1" }, g, 1n);
      return o.ok && o.logs.some((l) => l.includes('"event":"withdraw"')) && !o.logs.some((l) => l.includes("withdraw_failed"));
    }),
    deposit: await leastGas(async (g) => {
      const o = await bob.functionCall(w.usdc.accountId, "ft_transfer_call", { receiver_id: weir, amount: "1", msg: "" }, g, 1n);
      return o.ok && o.result === "1";
    }),
    // What a deposit sent with too little gas looks like to the client.
    deposit_short: await (async () => {
      const o = await bob.functionCall(w.usdc.accountId, "ft_transfer_call", { receiver_id: weir, amount: "1", msg: "" }, 6n * TGAS, 1n);
      return { ok: o.ok, result: o.result, error: o.error };
    })(),
  };

  return { contract: weir, agentRefusals, rawRefusals, gasFloor, storageFreed };

  function allIds(): string[] {
    return [...names.map((n) => people[n].accountId), agentSigner.accountId, root.accountId];
  }
}

export let agentAllowanceUsed = 0n;
export const storageFreed: { prune_result?: number; prune_print?: number } = {};
