// node deploy/src/cli.ts <plan|apply|status|seal|topup> --network sandbox|testnet [options]
// node deploy/src/cli.ts verify <record.json> [--rpc url,...] [--json] [--txs]   (keyless read-back, src/verify.ts)
//
//   --markets h100-fast,h100-weekly   markets to deploy (default: those in the state file, else all four)
//   --suffix <text>                   names are weir-<market>-<suffix>.testnet etc. (kept in the state file)
//   --out <dir>                       default deploy/out/<network>/ (git-ignored)
//   --keys <dir>                      default ~/.near-credentials/<network>/ (must be outside the repository)
//   --days <n>                        days of operator gas to fund (default 3)
//   --rpc <url,...>                   RPC URLs (sandbox: required; testnet: overrides the two defaults)
//   --root-key <file>                 sandbox only: the root account's key (the sandbox's validator_key.json)
//   --faucet-wait <secs>              testnet only: how long apply keeps retrying a rate-limited faucet (900)
//   --confirm <account>               seal only: once per market contract, the account name typed back
//   --json                            status only: the report as JSON
//   --dry-run                         topup only: print what it would do, send nothing, create no key
//   --max-fund-accounts <n>           topup only: fresh faucet accounts it may create (default 20)
//   --now <unix secs>                 plan only: the time t0 is worked out for (default: now)
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { KeyPair } from "../../chain/src/tx.ts";
import { apply } from "./apply.ts";
import { DEFAULT_DAYS, SANDBOX_GRANT } from "./budget.ts";
import { faucetCreator, rootCreator, rpcFor, RpcChain, type TopLevelCreator } from "./chain.ts";
import { Keystore, Redactor } from "./keys.ts";
import { layout, parseMarkets, sandboxNetwork, TESTNET, TOOL, VERSION, type MarketId, type Network } from "./layout.ts";
import { writeOutputs } from "./outputs.ts";
import { renderPlan } from "./plan.ts";
import { seal } from "./seal.ts";
import { newState, readState, writeState } from "./state.ts";
import { renderStatus, status } from "./status.ts";
import { buildPlan } from "./steps.ts";
import { DEFAULT_TOPUP_DAYS, planTopup, readTopupInputs, renderTopup, topup } from "./topup.ts";
import { verifyCli } from "./verify.ts";
import { loadWasm } from "./wasm.ts";

const USAGE =
  "usage: node deploy/src/cli.ts <plan|apply|status|seal|topup> --network sandbox|testnet [--markets a,b] [--suffix s] [--out dir] [--keys dir] [--days n] [--rpc url] [--root-key file] [--confirm account]... [--json]\n" +
  "       node deploy/src/cli.ts verify <record.json> [--rpc url,...] [--json] [--txs]";

const redactor = new Redactor();
const say = (line: string) => console.log(redactor.redact(line));

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      network: { type: "string" },
      markets: { type: "string" },
      suffix: { type: "string" },
      out: { type: "string" },
      keys: { type: "string" },
      days: { type: "string" },
      rpc: { type: "string" },
      "root-key": { type: "string" },
      "faucet-wait": { type: "string" },
      confirm: { type: "string", multiple: true },
      json: { type: "boolean" },
      "dry-run": { type: "boolean" },
      "max-fund-accounts": { type: "string" },
      now: { type: "string" },
      txs: { type: "boolean" },
    },
  });
  const command = positionals[0];
  if (command === "verify") {
    const rpc = values.rpc?.split(",").map((s) => s.trim()).filter(Boolean);
    return verifyCli(positionals.slice(1), { ...(rpc ? { rpc } : {}), json: values.json ?? false, txs: values.txs ?? false }, say);
  }
  if (!command || !["plan", "apply", "status", "seal", "topup"].includes(command) || positionals.length > 1) {
    console.error(USAGE);
    return 2;
  }
  if (values.network !== "sandbox" && values.network !== "testnet") {
    console.error("--network must be sandbox or testnet\n" + USAGE);
    return 2;
  }
  const rpcUrls = values.rpc?.split(",").map((s) => s.trim()).filter(Boolean);
  let network: Network;
  if (values.network === "testnet") network = rpcUrls ? { ...TESTNET, rpc: rpcUrls } : TESTNET;
  else network = sandboxNetwork(rpcUrls?.[0] ?? "http://127.0.0.1:33031");

  const out = resolve(values.out ?? new URL(`../out/${network.id}/`, import.meta.url).pathname);
  const state = readState(out);
  if (state && state.network !== network.id) throw new Error(`${out}/state.json is for ${state.network}, not ${network.id}`);
  if (state && values.suffix && values.suffix !== state.suffix) throw new Error(`${out}/state.json is for suffix ${state.suffix}; use another --out for suffix ${values.suffix}`);
  const suffix = values.suffix ?? state?.suffix;
  const requested: MarketId[] = values.markets ? parseMarkets(values.markets) : state ? state.markets : parseMarkets(undefined);
  const markets = parseMarkets([...new Set([...(state?.markets ?? []), ...requested])].join(","));
  const days = values.days ? Number(values.days) : DEFAULT_DAYS;

  if (command === "plan") {
    const l = layout(network, suffix ?? "example", markets, days);
    const plan = buildPlan(l, days);
    const weir = loadWasm("weir", { checkFresh: false });
    const usdc = loadWasm("mock_usdc", { checkFresh: false });
    const now = values.now ? Number(values.now) : Math.floor(Date.now() / 1000);
    say(renderPlan(plan, { weir: weir.size, usdc: usdc.size }, now));
    if (!suffix) say("\n(No --suffix given: the names above use 'example'.)");
    return 0;
  }

  if (!suffix) throw new Error("--suffix is required (it is kept in the state file afterwards)");
  const l = layout(network, suffix, markets, days);
  const plan = buildPlan(l, days);
  const keysDir = resolve(values.keys ?? join(homedir(), ".near-credentials", network.id));
  const keys = new Keystore(keysDir, { redactor });
  keys.loadAll(l.accounts.map((a) => a.id), suffix);
  const wasm = { weir: loadWasm("weir"), usdc: loadWasm("mock_usdc") };

  let creator: TopLevelCreator;
  if (network.creation === "root") {
    const file = values["root-key"];
    const root = file ? (JSON.parse(readFileSync(file, "utf8")) as { account_id: string; secret_key: string }) : null;
    if (root) redactor.add(root.secret_key);
    creator = root
      ? rootCreator({ accountId: root.account_id, key: await KeyPair.fromString(root.secret_key) }, SANDBOX_GRANT)
      : () => Promise.reject(new Error("--root-key is required on the sandbox to create accounts"));
    if (root && root.account_id !== network.root) throw new Error(`the root key is for ${root.account_id}, but names end in ${network.root}`);
  } else {
    creator = faucetCreator({ log: say, maxWaitMs: Number(values["faucet-wait"] ?? 900) * 1000 });
  }
  const chain = new RpcChain(rpcFor(network.rpc), creator);

  if (command === "status") {
    const r = await status(l, state, chain, keys, wasm, days);
    say(values.json ? JSON.stringify(r, null, 2) : renderStatus(r));
    return r.problems.length === 0 ? 0 : 1;
  }

  const st = state ?? newState(network.id, suffix, markets, new Date().toISOString());
  st.markets = markets;

  if (command === "topup") {
    if (!state) throw new Error(`no state file in ${out}: run apply first`);
    const topupDays = values.days ? Number(values.days) : DEFAULT_TOPUP_DAYS;
    if (values["dry-run"]) {
      say(`${TOOL} ${VERSION} topup --dry-run: ${network.id}, suffix ${suffix}; nothing will be sent`);
      say(renderTopup(planTopup(await readTopupInputs(l, topupDays, chain, keys)), topupDays));
      return 0;
    }
    say(`${TOOL} ${VERSION} topup: ${network.id}, suffix ${suffix}, ${topupDays} days`);
    const r = await topup({
      chain, keys, layout: l, state: st, out, days: topupDays, log: say,
      maxFundAccounts: Number(values["max-fund-accounts"] ?? 20),
      writeOutputs: async () => void (await writeOutputs(out, plan, st, chain, keys, wasm)),
    });
    say(`done: ${r.sent} transactions sent${r.fundAccountsUsed.length > 0 ? `, swept ${r.fundAccountsUsed.join(", ")}` : ""}.`);
    return 0;
  }

  if (command === "apply") {
    say(`${TOOL} ${VERSION} apply: ${network.id}, suffix ${suffix}, markets ${markets.join(", ")}; ${plan.steps.length} steps; keys in ${keysDir}; output in ${out}`);
    writeState(out, st, redactor);
    const r = await apply({ chain, keys, plan, wasm, out, state: st, log: say });
    const files = await writeOutputs(out, plan, st, chain, keys, wasm);
    say(`done: ${r.sent} transactions sent, ${r.skipped} steps already on chain.`);
    say(`wrote ${files.join(", ")} (keeper.env holds secrets, mode 600)`);
    return 0;
  }

  // seal
  const toSeal = values.markets ? requested : [];
  if (toSeal.length === 0) throw new Error("seal needs --markets naming the markets to seal, and --confirm <contract account> for each");
  await seal(l, toSeal, values.confirm ?? [], chain, keys, wasm.weir, st, out, say);
  await writeOutputs(out, plan, st, chain, keys, wasm);
  say("Sealed accounts can never be upgraded or recovered. record.json lists the seal transactions.");
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.error(redactor.redact(`error: ${e instanceof Error ? e.message : String(e)}`));
    process.exitCode = 1;
  },
);
