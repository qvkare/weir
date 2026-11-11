// Scenarios 3, 5 and 7 on a second deployment: a round filled to `max_commits` by distinct
// accounts (round is full, eviction, the most work `clear` can have), nonces under
// concurrency, and a series that never gets enough prints (not enough prints yet, then a void
// settlement).
import { ChainWeir, NearAccount, NearRpc, type PortChanges } from "../../chain/src/mod.ts";
import { auctionOpen, commitHash, deliveryEnd, roundStart, type Side } from "../../engine/src/mod.ts";
import { NEAR, type Signer } from "./accounts.ts";
import { SALT } from "./lifecycle.ts";
import type { Pending, TwinPort } from "./twin.ts";
import { onGrid, type World } from "./world.ts";

const BUNDLE = "0c".repeat(32);
const DOLLAR = 1_000_000n;

export interface ConcurrencyReport {
  one_account_burst: { sent: number; ok: number; seqs: number[]; nonces_sequential: boolean; wall_ms: number };
  same_key_two_clients: { sent: number; ok: number; failed: string[]; landed_on_chain: number; duplicates: number; invalid_nonce_replies: number; wall_ms: number };
  many_accounts: { sent: number; ok: number; wall_ms: number };
  visible_right_after: boolean;
}

export async function fullBook(w: World, reporters: Signer[]): Promise<{ contract: string; clear_full_tgas: number; concurrency: ConcurrencyReport }> {
  w.scenario = "full-book";
  const rpc = w.sandbox.rpc;
  const N = 64;
  const now0 = await w.sandbox.now();
  const t0 = onGrid(now0 + 3900 + 240, 300);
  const params = w.fastParams(reporters.map((r) => r.accountId), t0);
  const { id: weir } = await w.deployWeir("weir-full", params);
  const { twin, tp } = await w.twin(weir);
  twin.scenario = "full-book";
  const view = new ChainWeir({ rpc, contractId: weir });

  // Eight funders, each creating, registering and funding eight traders in parallel.
  const funders = await Promise.all(Array.from({ length: 8 }, (_, i) => w.root.createAccount(`funder-${i}`, { balance: 1000n * NEAR })));
  for (const f of funders) await w.mint(f.near(), f.accountId, 10_000n * DOLLAR);
  const traders: Signer[] = new Array(N);
  await twin.batch(
    funders.map((f, fi) => async () => {
      const fport = twin.port(f.near());
      const done: Pending[] = [];
      for (let k = 0; k < N / funders.length; k++) {
        const i = fi * (N / funders.length) + k;
        traders[i] = await f.createAccount(`t${String(i).padStart(2, "0")}`, { balance: 5n * NEAR });
        done.push(await ok(fport.send("register", { account_id: traders[i]!.accountId })));
        done.push(await ok(fport.send("deposit", { amount: (20n * DOLLAR).toString(), msg: traders[i]!.accountId })));
      }
      return done;
    }),
  );
  const ports = traders.map((t) => twin.port(t.near()));
  w.eq("64 traders funded", (await Promise.all(traders.map((t) => view.get_account({ account_id: t.accountId })))).every((a) => a?.balance === (20n * DOLLAR).toString()), true);

  // A print, then the first round's commit phase with plenty of time left.
  const open = auctionOpen(tp, 0);
  await w.sandbox.warpTo(open + 2);
  const reps = reporters.map((r) => twin.port(r.near()));
  // All three report, so the opening print is decided at once.
  for (const r of reps) await r.call("report", { bucket: open, price: 2_000_000, bundle: BUNDLE });
  w.eq("the opening print is final", (await view.get_print({ bucket: open }))?.state, "Final");
  const FEE = BigInt(params.commit_fee);
  const round = 0;
  const order = (i: number): { side: Side; price: number } => (i % 2 === 0 ? { side: "Long", price: 310_000 } : { side: "Short", price: 290_000 });
  const hash = (t: Signer, r: number, side: Side, size: number, price: number) => commitHash({ series: 0, round: r, accountId: t.accountId, side, size, price, salt: SALT });
  // Every lock is 3.10: 10 x 0.31 for LONG, 10 x (0.60 - 0.29) for SHORT.
  const records = await twin.batch(ports.map((p, i) => () => p.send("commit", { series: 0, hash: hash(traders[i]!, round, order(i).side, 10, order(i).price), lock: "3100000" })));
  w.eq("64 commits landed", records.filter((r) => r.chain.ok).length, N);
  const seqOf = new Map(records.map((r) => [r.account, r.chain.result as number]));
  w.eq("seqs are 0..63, each once", [...seqOf.values()].sort((a, b) => a - b), Array.from({ length: N }, (_, i) => i));

  // Round is full: a lock that is not larger than the smallest is refused; a larger one evicts
  // the smallest (the latest seq among equals).
  const extra = ports[0]!;
  const fullRecord = await extra.refused("commit", { series: 0, hash: hash(traders[0]!, round, "Long", 1, 310_000), lock: "3100000" });
  w.eq("a 65th commit with an equal lock: round is full", fullRecord.chain.error, "round is full");
  const lastSeq = N - 1;
  const evicted = [...seqOf.entries()].find(([, s]) => s === lastSeq)![0];
  const evictedIndex = traders.findIndex((t) => t.accountId === evicted);
  // The evictor places the evicted order's side and price, so the book stays 32 LONG, 32 SHORT.
  const evictorIndex = evictedIndex === 1 ? 2 : 1;
  const evictor = ports[evictorIndex]!;
  const evictOrder = order(evictedIndex);
  const evictRecord = twin.replay(await evictor.send("commit", { series: 0, hash: hash(traders[evictorIndex]!, round, evictOrder.side, 10, evictOrder.price), lock: "3200000" }));
  w.eq("a larger lock evicts the latest of the smallest", evictRecord.chain.events.map((e) => JSON.parse(e.slice(11)).event), ["evict", "commit"]);
  w.eq("the evict event returns lock and fee", JSON.parse(evictRecord.chain.events[0]!.slice(11)).data.fee, FEE.toString());
  w.eq("the evicted account has its lock and its fee back", (await view.get_account({ account_id: evicted }))?.balance, (20n * DOLLAR).toString());
  w.eq("the round still holds 64 commits", (await view.get_round({ series: 0, round }))?.commits.length, N);
  await twin.checkpoint("full book committed", { tp, series: [0], accounts: traders.map((t) => t.accountId) });

  // Every remaining commit is revealed.
  await w.sandbox.warpTo(roundStart(tp, 0, round) + tp.commitSecs + 1);
  const toReveal: (() => Promise<Pending>)[] = [];
  for (const [i, p] of ports.entries()) {
    const s = seqOf.get(traders[i]!.accountId)!;
    if (s === lastSeq) continue;
    toReveal.push(() => p.send("reveal", { series: 0, round, seq: s, side: order(i).side, size: 10, price: order(i).price, salt: SALT }));
  }
  toReveal.push(() => evictor.send("reveal", { series: 0, round, seq: evictRecord.chain.result as number, side: evictOrder.side, size: 10, price: evictOrder.price, salt: SALT }));
  const reveals = await twin.batch(toReveal);
  w.eq("64 reveals landed", reveals.filter((r) => r.chain.ok).length, N);
  const evictedReveal = await ports[evictedIndex]!.refused("reveal", { series: 0, round, seq: lastSeq, side: evictOrder.side, size: 10, price: evictOrder.price, salt: SALT });
  w.check("the evicted commit cannot be revealed", /not found|does not own/.test(evictedReveal.chain.error ?? ""), evictedReveal.chain.error);

  // The fullest clear there can be: 64 commits from 64 accounts, every one revealed and filled.
  await w.sandbox.warpTo(roundStart(tp, 0, round + 1) + 1);
  const clear = await ports[2]!.send("clear", { series: 0, round });
  twin.replay(clear);
  const result = await view.get_result({ series: 0, round });
  w.eq("full book: volume 320 and 64 fills", result && [result.volume, result.fills.length, result.fills.every((f) => f.filled === 10)], [320, 64, true]);
  const clearTgas = (clear.chain.gas_burnt ?? 0) / 1e12;
  w.check("full book: clear fits in 300 Tgas with room", clear.chain.ok && clearTgas < 150, { tgas: clearTgas });
  w.eq("full book: the 64 fees are burned, nothing forfeited", result && [result.fees, result.forfeited], [(64n * FEE).toString(), "0"]);
  w.eq("burned after the full clear", (await view.get_totals({})).burned, (64n * FEE).toString());
  await w.booksBalance("after the full clear", weir);
  await twin.checkpoint("full book cleared", { tp, series: [0], accounts: traders.map((t) => t.accountId) });

  // Scenario 7, in round 1's commit phase.
  const r1 = round + 1;
  const smallHash = (t: Signer, n: number) => commitHash({ series: 0, round: r1, accountId: t.accountId, side: "Long", size: 1, price: 100_000 + n * 1000, salt: SALT });
  // (a) ten calls at once through one client: one nonce queue.
  const burstPort = ports[4]!;
  let t = Date.now();
  const burst = await twin.batch(Array.from({ length: 10 }, (_, n) => () => burstPort.send("commit", { series: 0, hash: smallHash(traders[4]!, n), lock: "1000000" })));
  const burstMs = Date.now() - t;
  const burstOk = burst.filter((r) => r.chain.ok);
  const nonces = await Promise.all(burstOk.map((r) => txNonce(r.chain.tx_hash!, traders[4]!.accountId)));
  const sortedNonces = [...nonces].sort((a, b) => a - b);
  const book1 = await view.get_round({ series: 0, round: r1 });
  const visible = book1?.commits.filter((c) => c.owner === traders[4]!.accountId).length === burstOk.length;
  w.eq("burst from one client: 10 of 10 landed", burstOk.length, 10);
  const consecutive = sortedNonces.every((n, i) => i === 0 || n === sortedNonces[i - 1]! + 1);
  w.check("burst from one client: nonces are consecutive", consecutive, sortedNonces);
  w.check("burst: every commit is in the final state as soon as its call returns", visible);

  // (b) two clients on the same key (two processes signing for one agent), five calls each.
  const shared = traders[6]!;
  // Each client gets its own RPC whose replies are watched for InvalidNonce, the collision
  // `NearAccount` retries once.
  let invalidNonce = 0;
  const watching = () =>
    new NearRpc({
      urls: [w.sandbox.url],
      fetch: async (url, init) => {
        const res = await fetch(url, init);
        const text = await res.text();
        if (text.includes("InvalidNonce")) invalidNonce++;
        return { status: res.status, text: async () => text };
      },
    });
  const twoClients = [twin.port(new NearAccount(watching(), shared.accountId, shared.key)), twin.port(new NearAccount(watching(), shared.accountId, shared.key))];
  t = Date.now();
  const sameKey = await twin.batch(twoClients.flatMap((c, ci) => Array.from({ length: 5 }, (_, n) => () => c.send("commit", { series: 0, hash: smallHash(shared, 10 + ci * 5 + n), lock: "1000000" }))));
  const sameKeyMs = Date.now() - t;
  const landed = (await view.get_round({ series: 0, round: r1 }))?.commits.filter((c) => c.owner === shared.accountId) ?? [];
  const okCount = sameKey.filter((r) => r.chain.ok).length;
  const dupes = landed.length - new Set(landed.map((c) => c.hash)).size;
  w.eq("two clients on one key: every call that resolved landed, and nothing else", landed.length, okCount);
  w.eq("two clients on one key: nothing landed twice", dupes, 0);
  w.check("two clients on one key: every call either landed or failed with a clear error", sameKey.every((r) => r.chain.ok || (r.chain.error ?? "").length > 0));
  w.check("two clients on one key: all 10 calls landed (InvalidNonce retried)", okCount === 10, sameKey.filter((r) => !r.chain.ok).map((r) => r.chain.error));

  // (c) twenty accounts at once.
  t = Date.now();
  const many = await twin.batch(ports.slice(10, 30).map((p, i) => () => p.send("commit", { series: 0, hash: smallHash(traders[10 + i]!, 30), lock: "1000000" })));
  const manyMs = Date.now() - t;
  w.eq("twenty accounts at once: all landed", many.filter((r) => r.chain.ok).length, 20);
  const book2 = await view.get_round({ series: 0, round: r1 });
  w.eq("round 1 holds exactly the commits that resolved", book2?.commits.length, burstOk.length + okCount + 20);
  w.eq("round 1 seqs are 0..n-1 with no gap", book2?.commits.map((c) => c.seq), Array.from({ length: book2?.commits.length ?? 0 }, (_, i) => i));

  // Section 8: the cap on sets. The cap is 2^53 - 1 less what the series' auctions can still
  // add; a whale mints right up to it (5.4e15 dollars of test money), one more set is refused.
  const rounds = Math.floor((params.lead_secs - params.cutoff_secs) / (params.commit_secs + params.reveal_secs));
  const cap = Number.MAX_SAFE_INTEGER - params.max_order_size * params.max_commits * rounds;
  const openSets = (await view.get_series({ series: 0 }))!.open_sets;
  const whaleSets = cap - openSets;
  const band = BigInt((await view.get_series({ series: 0 }))!.band);
  const whale = ports[40]!;
  await w.rejects("mint up to the cap passes the cap check and stops at the balance", () => whale.call("mint", { series: 0, sets: whaleSets }), /^mint by .* free balance is too low$/);
  const whaleCost = BigInt(whaleSets) * band;
  await w.mint(funders[0]!.near(), funders[0]!.accountId, whaleCost);
  await twin.port(funders[0]!.near()).call("deposit", { amount: whaleCost.toString(), msg: traders[40]!.accountId });
  await whale.call("mint", { series: 0, sets: whaleSets });
  w.eq("open_sets is at the cap", (await view.get_series({ series: 0 }))?.open_sets, cap);
  await w.rejects("one set past the cap: too many sets", () => whale.call("mint", { series: 0, sets: 1 }), /^mint by .* too many sets$/);
  w.check("every unit count is still a safe JSON integer", Number.isSafeInteger((await view.get_position({ series: 0, account_id: traders[40]!.accountId })).long));

  // Scenario 3: these commits are never revealed, so the series cannot settle until they are
  // cleared; and with no prints in the delivery window, it settles only as void.
  await w.sandbox.warpTo(deliveryEnd(tp, 0) + params.report_grace_secs + 1);
  await w.rejects("settle with a round waiting to be cleared is refused", () => ports[0]!.call("settle", { series: 0 }), /waiting to be cleared/);
  await ports[0]!.call("clear", { series: 0, round: r1 });
  const r1Result = await view.get_result({ series: 0, round: r1 });
  const n1 = BigInt(book2?.commits.length ?? 0);
  w.eq("round 1 burns 1% of every unrevealed lock and every fee", r1Result && [r1Result.forfeited, r1Result.fees], [((n1 * 1_000_000n * 100n) / 10_000n).toString(), (n1 * FEE).toString()]);
  await w.rejects("settle with too few prints: not enough prints yet", () => ports[0]!.call("settle", { series: 0 }), /not enough prints yet/);
  await w.sandbox.warpTo(deliveryEnd(tp, 0) + params.void_after_secs + 1);
  await ports[0]!.call("settle", { series: 0 });
  const s = (await view.get_series({ series: 0 }))?.settlement;
  w.eq("void settlement with no prints fixes at floor + band / 2", s && [s.void, s.prints, s.fixing], [true, 0, 1_700_000 + 300_000]);
  await twin.batch([...ports.slice(0, 16), whale].map((p) => () => p.send("redeem", { series: 0 })));
  await w.rejects("nothing to redeem after redeeming", () => ports[0]!.call("redeem", { series: 0 }), /nothing to redeem/);
  await w.booksBalance("after the void settlement", weir);
  await twin.checkpoint("void settlement", { tp, series: [0], accounts: traders.map((t) => t.accountId) });

  return {
    contract: weir,
    clear_full_tgas: clearTgas,
    concurrency: {
      one_account_burst: { sent: 10, ok: burstOk.length, seqs: burstOk.map((r) => r.chain.result as number), nonces_sequential: consecutive, wall_ms: burstMs },
      same_key_two_clients: { sent: 10, ok: okCount, failed: sameKey.filter((r) => !r.chain.ok).map((r) => r.chain.error ?? ""), landed_on_chain: landed.length, duplicates: dupes, invalid_nonce_replies: invalidNonce, wall_ms: sameKeyMs },
      many_accounts: { sent: 20, ok: many.filter((r) => r.chain.ok).length, wall_ms: manyMs },
      visible_right_after: visible,
    },
  };

  async function txNonce(hash: string, sender: string): Promise<number> {
    const raw = await rpc.call<{ transaction: { nonce: number } }>("tx", { tx_hash: hash, sender_account_id: sender, wait_until: "FINAL" });
    return raw.transaction.nonce;
  }
}

async function ok(p: Promise<Pending>): Promise<Pending> {
  const x = await p;
  if (!x.chain.ok) throw new Error(`${x.method} by ${x.account} failed: ${x.chain.error}`);
  return x;
}

export type { PortChanges, TwinPort };
