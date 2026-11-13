// Node CLI.
// `quote --from arbitrum --amount 20 --to <near account>`: a dry 1Click quote for moving USDC
// from another chain to USDC on NEAR. Nothing is signed or sent.
// `try`: a throwaway testnet account places one sealed bid in the hourly demo market
// (src/guest.ts). `try --plan` reads the chain and sends nothing.
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Guest, GuestError, price, readPlan, txUrl, usd, viewPort, type GuestConfig, type GuestEvent, type GuestStorage } from "./guest.ts";
import { IntentsClient, PLACEHOLDER_REFUND, summarize, USDC, usdcToNear, usdcUnits, type Chain } from "./intents.ts";

const ORIGINS = Object.keys(USDC).filter((c) => c !== "near") as Exclude<Chain, "near">[];
/** Long names accepted for --from. */
const ALIASES: Record<string, Exclude<Chain, "near">> = { arbitrum: "arb", ethereum: "eth", solana: "sol" };

async function quote(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      from: { type: "string", default: "arbitrum" },
      amount: { type: "string", default: "20" },
      to: { type: "string" },
      "refund-to": { type: "string" },
      slippage: { type: "string", default: "100" },
    },
  });
  const from = ALIASES[values.from] ?? (values.from as Exclude<Chain, "near">);
  if (!ORIGINS.includes(from)) throw new Error(`--from must be one of base, arbitrum, ethereum, solana`);
  if (!values.to) throw new Error("--to <near account> is required: the account that would receive USDC on NEAR");
  const refundTo = values["refund-to"];
  const req = usdcToNear({
    from,
    amount: usdcUnits(values.amount),
    recipient: values.to,
    refundTo,
    slippageBps: Number(values.slippage),
  });
  let res;
  try {
    res = await new IntentsClient().quote(req);
  } catch (e) {
    if (e instanceof Error && /not available/i.test(e.message)) {
      throw new Error(`1Click does not quote USDC on ${values.from} -> USDC on NEAR right now (pair not available). Try --from arbitrum, ethereum or solana.`);
    }
    throw e;
  }
  const s = summarize(res);
  const mins = s.seconds >= 120 ? ` (~${Math.round(s.seconds / 60)} min)` : "";
  console.log(`Dry 1Click quote: USDC on ${values.from} -> USDC on NEAR for ${values.to} (nothing was sent)`);
  console.log(`  amount in        ${s.amountIn} USDC`);
  console.log(`  amount out       ${s.amountOut} USDC`);
  console.log(`  minimum out      ${s.minAmountOut} USDC  (slippage tolerance ${req.slippageTolerance} bps)`);
  console.log(`  time estimate    ${s.seconds} s${mins}`);
  if (!refundTo) console.log(`  refund address   ${PLACEHOLDER_REFUND[from]}  (placeholder for the dry quote, not a real wallet)`);
}

/** deployments.json at the repository root: the network's RPC URLs and the markets. */
function deployment(market: string): { contractId: string; usdcId: string; rpcUrls: string[] } {
  const d = JSON.parse(readFileSync(new URL("../../deployments.json", import.meta.url), "utf8")) as {
    rpc: string[];
    markets: { id: string; contract: string; usdc: string }[];
  };
  const m = d.markets.find((x) => x.id === market);
  if (!m) throw new Error(`no market ${market} in deployments.json (markets: ${d.markets.map((x) => x.id).join(", ")})`);
  return { contractId: m.contract, usdcId: m.usdc, rpcUrls: d.rpc };
}

/** The guest's state in `<dir>/state.json`, readable by the owner only. It holds the
 * throwaway account's secret key, so it is never printed. */
function fileStorage(dir: string): GuestStorage {
  const file = join(dir, "state.json");
  return {
    get: () => (existsSync(file) ? readFileSync(file, "utf8") : null),
    set: (_key, value) => {
      writeFileSync(file, value, { mode: 0o600 });
      chmodSync(file, 0o600);
    },
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function tryOne(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      plan: { type: "boolean", default: false },
      settle: { type: "boolean", default: false },
      market: { type: "string", default: "h100-fast" },
      state: { type: "string" },
      "limit-min": { type: "string", default: "15" },
      "gap-ms": { type: "string", default: "1000" },
    },
  });
  const dep = deployment(values.market);
  const config: GuestConfig = { ...dep, minGapMs: Number(values["gap-ms"]), timeLimitMs: Number(values["limit-min"]) * 60_000 };
  const started = Date.now();

  if (values.plan) {
    console.log(`Weir try --plan: ${dep.contractId} on NEAR testnet. Views only: nothing is created or sent.`);
    const plan = await readPlan(viewPort(config, { fetch, now: Date.now, sleep }));
    const p = plan.params;
    console.log(`  chain time        ${new Date(plan.now * 1000).toISOString()}`);
    console.log(`  rounds            ${p.commit_secs} s commit, ${p.reveal_secs} s reveal; min_lock ${usd(BigInt(p.min_lock))}, commit fee ${usd(BigInt(p.commit_fee))}, forfeit ${p.forfeit_bps / 100}% of the lock if not revealed`);
    console.log(`  last index print  ${plan.lastPrint ? `${price(plan.lastPrint.price)} per GPU-hour, bucket ${new Date(plan.lastPrint.bucket * 1000).toISOString()} (${plan.now - plan.lastPrint.bucket} s old)` : "none read (read only when a commit phase is open)"}`);
    console.log(`  series, round     ${plan.series ?? "-"}, ${plan.round ?? "-"}  phase ${plan.phase ?? "-"}${plan.phaseEndsAt ? `, ends in ${plan.phaseEndsAt - plan.now} s` : ""}`);
    console.log(`  status            ${plan.status}: ${plan.reason}`);
    if (plan.floor !== null && plan.band !== null) {
      console.log(`  band              floor ${price(plan.floor)}, width ${price(plan.band)}, tick ${price(plan.tick)} (series ${plan.seriesOpen ? "open" : "not open yet: the commit would open it on the last print"})`);
      console.log(`  last clearing     ${plan.lastClearing ? `round ${plan.lastClearing.round}: ${price(plan.floor + plan.lastClearing.price)}` : "none in this series yet; the reference price (last print) is used"}`);
    }
    if (plan.order) {
      const o = plan.order;
      console.log(`  suggested order   ${o.side.toUpperCase()} ${o.size} GPU-hours at most ${price(plan.floor! + o.price)} per GPU-hour (${o.price} above the floor); lock ${usd(BigInt(o.lock))} + fee ${usd(BigInt(o.fee))}`);
      console.log(`  would fund        up to ${usd(BigInt(o.maxNeed))} (size x band + fee), minted on the test dollar ${dep.usdcId}`);
    }
    console.log(`What try would do: create a throwaway account with the testnet faucet, register (0.02 NEAR), mint and deposit test dollars,`);
    console.log(`commit the order above, reveal it in the reveal phase, clear the round if the keeper has not after 20 s, and print the fill.`);
    console.log(`(${Math.round((Date.now() - started) / 1000)} s)`);
    return;
  }

  const dir = values.state ?? mkdtempSync(join(tmpdir(), "weir-try-"));
  const t = () => `${String(Math.round((Date.now() - started) / 1000)).padStart(4)} s`;
  const onEvent = (e: GuestEvent) => {
    if (e.type === "tx") console.log(`${t()}  ${e.step.padEnd(8)} tx ${e.method}${e.ok ? "" : " (failed)"}  ${e.url}`);
    else if (e.type === "refused") console.log(`${t()}  ${e.step.padEnd(8)} REFUSED ${e.method}: "${e.text}"${e.url ? `  ${e.url}` : ""}`);
    else if (e.type === "wait") console.log(`${t()}  ${e.step.padEnd(8)} waiting: ${e.message}`);
    else console.log(`${t()}  ${e.step.padEnd(8)} ${e.message}`);
  };
  const deps = { fetch, now: Date.now, sleep, randomBytes: (n: number) => crypto.getRandomValues(new Uint8Array(n)), storage: fileStorage(dir), onEvent };
  const guest = await Guest.load(config, deps);
  const resume = `node chain/src/cli.ts try --state ${dir}`;
  console.log(`Weir try: one sealed bid on ${dep.contractId} (NEAR testnet) by a throwaway account.`);
  console.log(`State, including the throwaway key, is kept in ${dir}/state.json (outside the repository; the key is never printed).`);
  console.log(`Time limit: no commit is started after ${values["limit-min"]} min; a commit already made is always revealed and cleared (at most about 6 min more).`);
  try {
    if (values.settle) {
      const s = await guest.settle();
      console.log(s.settled ? `Settled${s.redeemed ? " and redeemed" : ""}. Free balance in Weir: ${usd(BigInt(s.balance))}.` : `Not settled yet: "${s.reason}". Run again later: ${resume} --settle`);
      for (const x of s.txs) console.log(`  ${x.method.padEnd(38)} ${txUrl(x.hash)}`);
      if (!s.settled) process.exitCode = 1;
      return;
    }
    const r = await guest.run();
    const o = r.order;
    console.log("");
    console.log(`Account          ${r.accountId}`);
    console.log(`Order            series ${r.series} round ${r.round}: ${o.side.toUpperCase()} ${o.size} GPU-hours at most ${price(o.floor + o.price)} per GPU-hour`);
    console.log(`Clearing price   ${r.clearingPriceAbs === null ? "none: the round did not trade" : `${price(r.clearingPriceAbs)} per GPU-hour`}`);
    console.log(`Fill             ${r.filled} of ${o.size * Math.max(1, (o.seqs ?? []).length)} GPU-hours: ${r.outcome}`);
    console.log(`Position         long ${r.position.long}, short ${r.position.short} in series ${r.series}`);
    console.log(`Free balance     ${usd(BigInt(r.balance))} in Weir`);
    console.log(`Transactions     ${r.txs.length}`);
    for (const x of r.txs) console.log(`  ${x.method.padEnd(38)} ${txUrl(x.hash)}${x.ok ? "" : " (failed)"}`);
    console.log(`Total time       ${Math.round((Date.now() - started) / 1000)} s this run (${r.seconds} s since the key was made)`);
    console.log(`After the delivery hour, settle and redeem with: ${resume} --settle`);
  } catch (e) {
    const why = e instanceof GuestError ? `${e.kind}, at ${e.step}` : "error";
    console.error(`FAILED (${why}): ${e instanceof Error ? e.message : String(e)}`);
    if (guest.accountId) console.error(`Account ${guest.accountId}. To resume: ${resume}`);
    console.error(`Total time ${Math.round((Date.now() - started) / 1000)} s`);
    process.exitCode = 1;
  }
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === "quote") await quote(rest);
  else if (command === "try") await tryOne(rest);
  else {
    console.log("usage: node chain/src/cli.ts quote --from arbitrum|ethereum|solana|base --amount 20 --to <near account> [--refund-to <address>] [--slippage 100]");
    console.log("       node chain/src/cli.ts try [--plan] [--market h100-fast] [--state <dir>] [--settle] [--limit-min 15] [--gap-ms 1000]");
    process.exitCode = command ? 1 : 0;
  }
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  console.error(message);
  if (/Internal server error/.test(message)) {
    console.error("hint: --to must be an existing NEAR mainnet account or a 64-hex implicit account");
  }
  process.exitCode = 1;
}
