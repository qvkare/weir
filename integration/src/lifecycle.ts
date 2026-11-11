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
    w.tokenOk("storage_deposit", await w.token.storageDeposit(s.near()), 30n * TGAS);
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

  // Section 6.4: Eve's guard.
  await p.eve.call("set_guard", { guard: 5_000 });
  w.eq("eve's guard is set", await view.get_account({ account_id: people.eve.accountId }), { balance: DEPOSIT.toString(), guard: 5_000 });

  // The auction opens. No print yet: the series cannot open.
  const open = auctionOpen(tp, 0);
  await w.sandbox.warpTo(open + 2);
  const r0 = 0;
  const hashOf = (who: Signer, round: number, side: Side, size: number, price: number, salt = SALT) =>
    commitHash({ series: 0, round, accountId: who.accountId, side, size, price, salt });
  const stale = await w.rejects("commit before any print: index is stale", () => p.alice.call("commit", { series: 0, hash: hashOf(people.alice, r0, "Long", 10, 310_000), lock: "3100000" }), /^commit by .* index is stale$/);
  void stale;
  await w.rejects("mint before any print: index is stale", () => p.dave.call("mint", { series: 0, sets: 1 }), /index is stale/);

  // Section 9: a print at the auction's opening bucket.
  const b0 = open; // a multiple of 300, since t0 and lead_secs are
  await w.rejects("report by a non-reporter is refused", () => p.alice.call("report", { bucket: b0, price: 2_000_000, bundle: BUNDLE }), /not a reporter/);
  await w.rejects("report for a bucket off the grid is refused", () => reps[0]!.call("report", { bucket: b0 + 1, price: 2_000_000, bundle: BUNDLE }), /multiple of print_interval_secs/);
  await w.rejects("report with an uppercase bundle is refused", () => reps[0]!.call("report", { bucket: b0, price: 2_000_000, bundle: "0B".repeat(32) }), /bundle/);
  await w.rejects("report of price zero is refused", () => reps[0]!.call("report", { bucket: b0, price: 0, bundle: BUNDLE }), /price must be above zero/);
  await w.rejects("report for a future bucket is refused", () => reps[0]!.call("report", { bucket: b0 + 600, price: 2_000_000, bundle: BUNDLE }), /report window/);
  w.eq("first report is not final (quorum 2)", await reps[0]!.call("report", { bucket: b0, price: 2_000_000, bundle: BUNDLE }), false);
  await w.rejects("a reporter's second report for a bucket not yet final is refused", () => reps[0]!.call("report", { bucket: b0, price: 2_000_000, bundle: BUNDLE }), /already reported/);
  w.eq("second report makes the print final", await reps[1]!.call("report", { bucket: b0, price: 2_000_000, bundle: BUNDLE }), true);
  w.eq("a third report on a final print returns false", await reps[2]!.call("report", { bucket: b0, price: 2_000_000, bundle: BUNDLE }), false);
  w.eq("a repeat report on a final print returns false, not a panic", await reps[0]!.call("report", { bucket: b0, price: 2_000_000, bundle: BUNDLE }), false);
  w.eq("get_last_print", await view.get_last_print({}), { bucket: b0, price: 2_000_000 });

  // Round 0: sealed orders (section 6.2).
  w.check("round 0 is in its commit phase", (await w.sandbox.now()) < roundStart(tp, 0, 0) + 150);
  await w.rejects("an unregistered account cannot commit", () => p.outsider.call("commit", { series: 0, hash: hashOf(people.outsider, r0, "Long", 1, 300_000), lock: "1000000" }), /not registered/);
  await w.rejects("a lock below min_lock is refused", () => p.alice.call("commit", { series: 0, hash: hashOf(people.alice, r0, "Long", 3, 300_000), lock: "999999" }), /min_lock/);
  await w.rejects("an uppercase hash is refused", () => p.alice.call("commit", { series: 0, hash: hashOf(people.alice, r0, "Long", 3, 300_000).toUpperCase(), lock: "1000000" }), /hash must be 64 lowercase hex/);
  await w.rejects("a lock above the free balance is refused", () => p.alice.call("commit", { series: 0, hash: hashOf(people.alice, r0, "Long", 3, 300_000), lock: (DEPOSIT + 1n).toString() }), /balance/);
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
  const series = await view.get_series({ series: 0 });
  w.eq("the series opened on the print: anchor, floor and band (section 6.1)", series && { anchor: series.anchor, floor: series.floor, band: series.band }, { anchor: 2_000_000, floor: 1_700_000, band: 600_000 });
  await p.dave.call("mint", { series: 0, sets: 2 });
  await w.rejects("mint of zero sets is refused", () => p.dave.call("mint", { series: 0, sets: 0 }), /sets must be above zero/);
  w.eq("alice free after her lock", await free(people.alice), DEPOSIT - 3_100_000n);
  w.eq("carol free after two locks", await free(people.carol), DEPOSIT - 3_480_000n);
  w.eq("dave free after mint and lock", await free(people.dave), DEPOSIT - 1_200_000n - 1_000_000n);
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
  w.eq("eve's LONG above ref + guard is void and her lock is back at once", await free(people.eve), DEPOSIT);
  const book = await view.get_round({ series: 0, round: r0 });
  w.eq("get_round states", book?.commits.map((c) => c.state), ["Revealed", "Revealed", "Revealed", "Committed", "Void", "Committed"]);
  await w.rejects("clear during the reveal phase is refused", () => p.bob.call("clear", { series: 0, round: r0 }), /not over/);
  await twin.checkpoint("round 0 reveal phase", { tp, series: [0], accounts: allIds() });

  // Clearing (section 7): V* = 8 at 0.290, 0.300 and 0.310; the smallest |D - S| is at 0.310.
  await w.sandbox.warpTo(roundStart(tp, 0, r0 + 1) + 1);
  await p.bob.call("clear", { series: 0, round: r0 });
  await w.rejects("a second clear is refused", () => p.bob.call("clear", { series: 0, round: r0 }), /already cleared/);
  const result = await view.get_result({ series: 0, round: r0 });
  w.eq("clearing price, volume and forfeits", result && { price: result.price, volume: result.volume, long_size: result.long_size, short_size: result.short_size, orders: result.orders, commits: result.commits, forfeited: result.forfeited }, {
    price: 310_000, volume: 8, long_size: 15, short_size: 8, orders: 3, commits: 6, forfeited: "20000",
  });
  w.eq("fills", result?.fills.map((f) => [f.owner.split(".")[0], f.side, f.filled]), [["alice", "Long", 8], ["bob", "Long", 0], ["carol", "Short", 8]]);
  w.eq("alice free after clearing", await free(people.alice), DEPOSIT - 8n * 310_000n);
  w.eq("bob free after clearing (nothing filled)", await free(people.bob), DEPOSIT);
  w.eq("carol free after clearing (paid 8 x 0.29, forfeited 1% of 1.00)", await free(people.carol), DEPOSIT - 8n * 290_000n - 10_000n);
  w.eq("dave free after clearing (forfeited 1% of 1.00)", await free(people.dave), DEPOSIT - 1_200_000n - 10_000n);
  w.eq("positions", [await pos(people.alice), await pos(people.bob), await pos(people.carol)], [{ long: 8, short: 0 }, { long: 0, short: 0 }, { long: 0, short: 8 }]);
  w.eq("open_sets and bonus pool", await view.get_series({ series: 0 }).then((s) => s && [s.open_sets, s.bonus_pool, s.pending_rounds]), [10, "20000", []]);
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
    ["set_guard", { guard: 1 }],
    ["transfer_position", { series: 0, to: people.bob.accountId, long: 1, short: 0 }],
    ["register", {}],
    ["report", { bucket: b0, price: 1, bundle: BUNDLE }],
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
  w.eq("agent: free after its round (4 sets bought at 0.30 + 0.30, 2 minted, 1 merged)", await free(agentSigner), 100n * DOLLAR - 3_000_000n);
  w.eq("dave: free after merging one set", await free(people.dave), DEPOSIT - 1_200_000n - 10_000n + 600_000n);
  w.eq("open_sets", (await view.get_series({ series: 0 }))?.open_sets, 14);
  // Round 2 holds nothing: clearing it after it is over is refused.
  await w.sandbox.warpTo(roundStart(tp, 0, r1 + 2) + 1);
  await w.rejects("clear of a round with no commits is refused", () => p.bob.call("clear", { series: 0, round: r1 + 1 }), /no commits/);
  await w.booksBalance("after the agent's round", weir);
  await twin.checkpoint("after round 1", { tp, series: [0], accounts: allIds() });

  // Delivery: prints in 10 of the 12 buckets, one of them a move over max_move_bps.
  const prices: (number | [number, number] | null)[] = [2_000_000, [2_000_000, 2_100_000], 2_100_000, 2_500_000, 2_400_000, null, 2_300_000, 2_200_000, null, 2_100_000, 2_000_000, 1_900_000];
  for (const [i, price] of prices.entries()) {
    const bucket = t0 + i * 300;
    await w.sandbox.warpTo(bucket + 1);
    if (price === null) continue;
    if (i === 3) {
      w.eq("a far move: two reports are not enough", [await reps[0]!.call("report", { bucket, price: 2_500_000, bundle: BUNDLE }), await reps[1]!.call("report", { bucket, price: 2_500_000, bundle: BUNDLE })], [false, false]);
      w.eq("a far move: the third reporter makes it final", await reps[2]!.call("report", { bucket, price: 2_500_000, bundle: BUNDLE }), true);
      continue;
    }
    const [a, b] = Array.isArray(price) ? price : [price, price];
    await reps[0]!.call("report", { bucket, price: a, bundle: BUNDLE });
    w.eq(`bucket ${i}: the second report makes it final`, await reps[1]!.call("report", { bucket, price: b, bundle: BUNDLE }), true);
  }
  w.eq("the even-count median is the mean of the two middle reports", (await view.get_print({ bucket: t0 + 300 }))?.price, 2_050_000);
  await w.rejects("a report for a bucket whose window has closed is refused", () => reps[2]!.call("report", { bucket: t0 + 300, price: 2_000_000, bundle: BUNDLE }), /report window/);
  w.eq("accumulator", await view.get_accumulator({ series: 0 }), { sum: "21550000", count: 10 });
  await w.rejects("settle of a series never opened is refused", () => p.bob.call("settle", { series: 9 }), /not found|not open/);
  await w.rejects("redeem on a series never opened is refused", () => p.bob.call("redeem", { series: 9 }), /not found|not open|not settled/);
  await w.rejects("clear on a series never opened is refused", () => p.bob.call("clear", { series: 9, round: 0 }), /.+/);
  await w.rejects("settle before the last report window closes is refused", () => agent.call("settle", { series: 0 }), /report window of the delivery/);
  await w.rejects("redeem before settlement is refused", () => agent.call("redeem", { series: 0 }), /not settled/);
  await twin.checkpoint("after delivery prints", { tp, series: [0], accounts: allIds(), buckets: [t0 + 5 * 300, t0 + 8 * 300] });

  // Settlement (section 10), by the agent's function-call key.
  await w.sandbox.warpTo(deliveryEnd(tp, 0) + params.report_grace_secs + 1);
  await agent.call("settle", { series: 0 });
  await w.rejects("settling twice is refused", () => p.bob.call("settle", { series: 0 }), /settled/);
  const settled = (await view.get_series({ series: 0 }))?.settlement;
  // 21_550_000 / 10 = 2_155_000; LONG pays 0.455; 20_000 forfeited over 14 sets: 1_428 a set, 8 carried.
  w.eq("settlement", settled && { ...settled, settled_at: 0 }, {
    fixing: 2_155_000, long_payout: 455_000, short_payout: 145_000, bonus_long: "714", bonus_short: "714", prints: 10, void: false, settled_at: 0,
  });
  await w.booksBalance("after settlement", weir);

  // Section 8: positions still move after settlement.
  await p.carol.call("transfer_position", { series: 0, to: people.bob.accountId, long: 0, short: 2 });
  await w.rejects("transfer to yourself is refused", () => p.carol.call("transfer_position", { series: 0, to: people.carol.accountId, long: 0, short: 1 }), /yourself/);
  await w.rejects("transfer of more than held is refused", () => p.carol.call("transfer_position", { series: 0, to: people.bob.accountId, long: 1, short: 0 }), /position is too small/);
  await w.rejects("transfer of nothing is refused", () => p.carol.call("transfer_position", { series: 0, to: people.bob.accountId, long: 0, short: 0 }), /at least 1/);
  await w.rejects("transfer to an unregistered account is refused", () => p.carol.call("transfer_position", { series: 0, to: people.outsider.accountId, long: 0, short: 1 }), /not registered/);

  // Redemption: anyone for anyone.
  await p.bob.call("redeem", { series: 0, account_id: people.alice.accountId });
  await p.bob.call("redeem", { series: 0 });
  await p.carol.call("redeem", { series: 0 });
  await p.dave.call("redeem", { series: 0 });
  await agent.call("redeem", { series: 0 });
  await w.rejects("redeem with no position: nothing to redeem", () => p.eve.call("redeem", { series: 0 }), /nothing to redeem/);
  await w.rejects("redeem twice: nothing to redeem", () => p.bob.call("redeem", { series: 0, account_id: people.alice.accountId }), /nothing to redeem/);
  const aliceFree = DEPOSIT - 8n * 310_000n + 8n * 455_714n;
  w.eq("alice after redemption", await free(people.alice), aliceFree);
  w.eq("bob after redemption (2 SHORT from carol)", await free(people.bob), DEPOSIT + 2n * 145_714n);
  w.eq("carol after redemption (6 SHORT)", await free(people.carol), DEPOSIT - 8n * 290_000n - 10_000n + 6n * 145_714n);
  w.eq("dave after redemption (1 set)", await free(people.dave), DEPOSIT - 1_200_000n - 10_000n + 600_000n + 601_428n);
  w.eq("agent after redemption (5 sets)", await free(agentSigner), 100n * DOLLAR - 3_000_000n + 5n * 601_428n);
  w.eq("eve untouched", await free(people.eve), DEPOSIT);
  w.eq("totals after redemption: only the 8 carried and the free balances", await view.get_totals({}), {
    free: (aliceFree + DEPOSIT + 2n * 145_714n + DEPOSIT - 8n * 290_000n - 10_000n + 6n * 145_714n + DEPOSIT - 1_200_000n - 10_000n + 600_000n + 601_428n + 100n * DOLLAR - 3_000_000n + 5n * 601_428n + DEPOSIT).toString(),
    locked: "0", sets_backing: "0", pools: "8", unredeemed: "0",
  });
  await w.booksBalance("after redemption", weir);

  // Pruning (section 14).
  await p.bob.call("prune_result", { series: 0, round: r0 });
  w.eq("a pruned result is gone", await view.get_result({ series: 0, round: r0 }), null);
  await w.rejects("pruning twice is refused", () => p.bob.call("prune_result", { series: 0, round: r0 }), /result not found/);

  // Alice takes everything out.
  await p.alice.call("withdraw", { amount: aliceFree.toString() });
  w.eq("alice: free balance after withdrawing everything", await free(people.alice), 0n);
  w.eq("alice: token balance after withdrawing", await w.usdcBalance(people.alice.accountId), 500n * DOLLAR + aliceFree);
  w.eq("contract: token balance after alice's withdrawal", await w.usdcBalance(weir), 5n * DEPOSIT + 100n * DOLLAR - aliceFree);
  await w.booksBalance("at the end", weir);
  await twin.checkpoint("end of life", { tp, series: [0], accounts: allIds() });

  // The agent's allowance: what its calls cost the key, against the gas they burnt.
  const ak = await rpc.viewAccessKey(agentSigner.accountId, agentSigner.key.publicKeyString);
  const allowance = typeof ak.permission === "object" ? BigInt(ak.permission.FunctionCall.allowance ?? "0") : 0n;
  w.check("the agent's key still has allowance left", allowance > 0n, { allowance_left: allowance.toString() });
  agentAllowanceUsed = NEAR - allowance;

  // Section 5: a token that is not `usdc` is refused. Its ft_on_transfer panics, so the token
  // refunds everything and the client sees "0" kept.
  const fake = await root.createAccount("fake-usdc", { code: w.wasm.usdc.bytes });
  const fakeToken = new Token(rpc, fake.accountId);
  w.tokenOk("storage_deposit", await fakeToken.storageDeposit(root.near(), weir), 30n * TGAS);
  w.tokenOk("mint", await fakeToken.mint(people.bob.near(), people.bob.accountId, "5000000"), 30n * TGAS);
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

  return { contract: weir, agentRefusals, rawRefusals, gasFloor };

  function allIds(): string[] {
    return [...names.map((n) => people[n].accountId), agentSigner.accountId, root.accountId];
  }
}

export let agentAllowanceUsed = 0n;
