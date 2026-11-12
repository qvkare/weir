// Specification 0.6, section 10: a void series pays every LONG and every SHORT half the band,
// whatever was traded (wash trades at an extreme price included) and whatever prints exist;
// and section 3: the quorum
// must be a majority of the reporters. Every call is made on the model too.
import { ChainWeir, ModelWeir, paramsFromWire } from "../../chain/src/mod.ts";
import { auctionOpen, commitHash, deliveryEnd, Market, roundStart, type Side } from "../../engine/src/mod.ts";
import { NEAR, type Signer } from "./accounts.ts";
import { SALT } from "./lifecycle.ts";
import type { TwinPort } from "./twin.ts";
import { onGrid, type World } from "./world.ts";

const BUNDLE = "0d".repeat(32);
const DOLLAR = 1_000_000n;
const DEPOSIT = 100n * DOLLAR;

export async function voids(w: World, reporters: Signer[]): Promise<{ contract: string; quorum_refusal: { chain: string; model: string } }> {
  w.scenario = "void";
  const rpc = w.sandbox.rpc;

  // Section 3: a quorum of one in three is refused by `new`, on the contract and on the model.
  const now0 = await w.sandbox.now();
  const t0 = onGrid(now0 + 3900 + 120, 300);
  const minority = w.fastParams(reporters.map((r) => r.accountId), t0, { quorum: 1 });
  let chainText = "(deployed)";
  try {
    await w.root.createAccount("weir-q1", { balance: 30n * NEAR, code: w.wasm.weir.bytes, init: { method: "new", args: { params: minority } } });
  } catch (e) {
    chainText = /Smart contract panicked: ([^"\\]*)/.exec(String(e))?.[1] ?? String(e);
  }
  let modelText = "(accepted)";
  try {
    new Market(paramsFromWire(minority), now0);
  } catch (e) {
    modelText = e instanceof Error ? e.message : String(e);
  }
  w.eq("new refuses a quorum that is not a majority, on chain", chainText, "quorum must be a majority of the reporters");
  w.eq("the model refuses it with the same text", modelText, chainText);
  w.eq("nothing was deployed", await rpc.viewAccount(`weir-q1.${w.root.accountId}`).then(() => "exists", () => "absent"), "absent");

  const params = w.fastParams(reporters.map((r) => r.accountId), t0);
  const { id: weir } = await w.deployWeir("weir-void", params);
  const { twin, tp } = await w.twin(weir);
  twin.scenario = "void";
  const view = new ChainWeir({ rpc, contractId: weir });
  const FEE = BigInt(params.commit_fee);
  const names = ["va", "vb", "vc", "vd"] as const;
  const s: Record<(typeof names)[number], Signer> = {} as never;
  const p: Record<(typeof names)[number], TwinPort> = {} as never;
  const rootPort = twin.port(w.root.near());
  for (const n of names) {
    s[n] = await w.root.createAccount(n);
    p[n] = twin.port(s[n].near());
    await rootPort.call("register", { account_id: s[n].accountId });
    await rootPort.call("deposit", { amount: DEPOSIT.toString(), msg: s[n].accountId });
  }
  const reps = reporters.map((r) => twin.port(r.near()));
  const free = async (n: (typeof names)[number]) => BigInt((await view.get_account({ account_id: s[n].accountId }))!.balance);
  const hash = (n: (typeof names)[number], series: number, round: number, side: Side, size: number, price: number) =>
    commitHash({ series, round, accountId: s[n].accountId, side, size, price, salt: SALT });

  // Series 0 opens on a print and trades in three rounds at three prices; C mints 3 sets.
  const open = auctionOpen(tp, 0);
  await w.sandbox.warpTo(open + 2);
  for (const r of reps) await r.call("report", { bucket: open, price: 2_000_000, bundle: BUNDLE });
  // Rounds 0 to 2: A buys LONG from B at 0.30, 0.36 and 0.24. Round 3: A wash-trades with
  // itself, LONG and SHORT 5 at 0.59, the most extreme price it can, to drag the average.
  const rounds: [number, number, string, string, (typeof names)[number]][] = [
    [10, 300_000, "3000000", "3000000", "vb"],
    [5, 360_000, "1800000", "1200000", "vb"],
    [4, 240_000, "1000000", "1440000", "vb"],
    [5, 590_000, "2950000", "1000000", "va"],
  ];
  for (const [r, [size, price, lockL, lockS, shortSide]] of rounds.entries()) {
    await w.sandbox.warpTo(roundStart(tp, 0, r) + 1);
    if (r > 0) await p.vd.call("clear", { series: 0, round: r - 1 });
    const a = await p.va.call("commit", { series: 0, hash: hash("va", 0, r, "Long", size, price), lock: lockL });
    const b = await p[shortSide].call("commit", { series: 0, hash: hash(shortSide, 0, r, "Short", size, price), lock: lockS });
    if (r === 0) await p.vc.call("mint", { series: 0, sets: 3 });
    await w.sandbox.warpTo(roundStart(tp, 0, r) + tp.commitSecs + 1);
    await p.va.call("reveal", { series: 0, round: r, seq: a, side: "Long", size, price, salt: SALT });
    await p[shortSide].call("reveal", { series: 0, round: r, seq: b, side: "Short", size, price, salt: SALT });
  }
  await w.sandbox.warpTo(roundStart(tp, 0, 4) + 1);
  await p.vd.call("clear", { series: 0, round: 3 });
  w.eq("four rounds traded at four prices, the last a wash at 0.59", (await view.get_results({ series: 0, from_round: 0, limit: 4 })).map(([, r]) => [r.price, r.volume]), [[300_000, 10], [360_000, 5], [240_000, 4], [590_000, 5]]);
  w.eq("the series records traded units and value, as information (mints not counted)", await view.get_series({ series: 0 }).then((x) => x && [x.traded_units, x.traded_value, x.open_sets]), [24, "8710000", 27]);
  await twin.checkpoint("void series traded", { tp, series: [0], accounts: names.map((n) => s[n].accountId) });

  // Series 1 opens on a fresh print and only mints.
  const open1 = auctionOpen(tp, 1);
  await w.sandbox.warpTo(open1 + 2);
  for (const r of reps) await r.call("report", { bucket: open1, price: 2_000_000, bundle: BUNDLE });
  await p.vd.call("mint", { series: 1, sets: 2 });
  w.eq("series 1: minted, never traded", await view.get_series({ series: 1 }).then((x) => x && [x.traded_units, x.traded_value, x.open_sets]), [0, "0", 2]);

  // No prints in either delivery window: not enough prints, then void.
  await w.sandbox.warpTo(deliveryEnd(tp, 0) + params.report_grace_secs + 1);
  await w.rejects("series 0 without prints: not enough prints yet", () => p.vd.call("settle", { series: 0 }), /not enough prints yet/);
  await w.sandbox.warpTo(deliveryEnd(tp, 0) + params.void_after_secs + 1);
  await p.vd.call("settle", { series: 0 });
  // Section 10 (0.6): void pays half the band to every unit, whatever traded (the wash round's
  // 0.59 included) and whatever prints exist.
  w.eq("series 0 void: half the band each side, the wash trades notwithstanding", await view.get_series({ series: 0 }).then((x) => x?.settlement && { ...x.settlement, settled_at: 0 }), {
    fixing: 1_700_000 + 300_000, long_payout: 300_000, short_payout: 300_000, prints: 0, void: true, settled_at: 0,
  });
  for (const n of ["va", "vb", "vc"] as const) await p.vd.call("redeem", { series: 0, account_id: s[n].accountId });
  // A: 19 LONG for 5.76 back at 5.70; its wash (5 LONG at 0.59 + 5 SHORT at 0.01) back at 3.00 for 3.00.
  w.eq("LONG buyer: paid 5.76 for 19 units, gets 19 x 0.30, its wash round neutral, five fees", await free("va"), DEPOSIT - 5_760_000n + 19n * 300_000n - 5n * FEE);
  w.eq("SHORT buyer: paid 5.64 for 19 units, gets 19 x 0.30, three fees", await free("vb"), DEPOSIT - 5_640_000n + 19n * 300_000n - 3n * FEE);
  w.eq("the minter gets its 3 sets back at the band", await free("vc"), DEPOSIT);

  await w.sandbox.warpTo(deliveryEnd(tp, 1) + params.void_after_secs + 1);
  await p.vd.call("settle", { series: 1 });
  w.eq("series 1 void with nothing traded: half the band each side", await view.get_series({ series: 1 }).then((x) => x?.settlement && [x.settlement.void, x.settlement.long_payout, x.settlement.short_payout, x.settlement.fixing]), [true, 300_000, 300_000, 2_000_000]);
  await p.vd.call("redeem", { series: 1 });
  w.eq("the minter of series 1 gets everything back", await free("vd"), DEPOSIT);
  w.eq("totals: free balances and eight fees burned", await view.get_totals({}), {
    free: (4n * DEPOSIT - 8n * FEE).toString(), locked: "0", sets_backing: "0", unredeemed: "0", burned: (8n * FEE).toString(),
  });
  await w.booksBalance("void series", weir);
  await twin.checkpoint("void series settled", { tp, series: [0, 1], accounts: names.map((n) => s[n].accountId) });
  void ModelWeir;
  return { contract: weir, quorum_refusal: { chain: chainText, model: modelText } };
}
