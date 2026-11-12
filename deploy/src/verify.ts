// `verify <record.json>`: reads a committed deployment record (`record.json`, written by apply)
// back from the public chain, with no keys, no state file and no Rust. Every check is a
// read-only RPC call, sent one at a time so that a public endpoint's rate limit is not hit.
//
// Three outcomes, three exit codes:
//   0  match        every check agrees with the record
//   1  differs      the chain answered, and something differs from the record
//   3  unreachable  the chain could not be reached (network, timeouts, rate limits): nothing is
//                   claimed either way
// (2 is a usage error or a file that is not a deployment record.)
// Information lines (sealed or not, the market's status, its last print, its totals) are never
// failures: a quiet market or a contract that is not sealed is not a broken deployment.
import { existsSync, readFileSync } from "node:fs";
import { decodeOutcome, RpcError, RpcUnavailable, type NearRpc, type AccessKeyPermission, type AccountInfo, type FetchLike } from "../../chain/src/near.ts";
import type { WireLastPrint, WireParams, WireStatus, WireTotals } from "../../engine/src/mod.ts";
import { rpcFor } from "./chain.ts";
import { TESTNET } from "./layout.ts";
import type { RecordJson } from "./outputs.ts";
import { loadWasm } from "./wasm.ts";

export const EXIT = { match: 0, differs: 1, usage: 2, unreachable: 3 } as const;

/** Endpoints for `--txs` on testnet: fastnear's archival node first (a regular node forgets
 * transactions after about five epochs, roughly two and a half days), then dRPC. Not
 * archival-rpc.testnet.near.org: on 2026-11-12 it answered HTTP 429 "THIS ENDPOINT IS DEPRECATED". */
export const TESTNET_ARCHIVAL = ["https://archival-rpc.testnet.fastnear.com", "https://near-testnet.drpc.org"];

/** How long `verify` lets one call wait out rate refusals on every endpoint (`src/pace.ts`). */
export const VERIFY_MAX_CALL_WAIT_MS = 60_000;

export const LOCAL_WEIR_WASM = "contracts/target/near/weir/weir.wasm";

export type Outcome = "match" | "differs" | "unreachable";

export interface Check {
  status: "ok" | "fail" | "info";
  text: string;
}

export interface VerifyReport {
  network: string;
  suffix: string;
  rpc: string[];
  outcome: Outcome;
  /** Why the chain could not be reached, when it could not. */
  unreachable: string | null;
  checks: Check[];
}

export interface VerifyOptions {
  rpc: NearRpc;
  /** For `--txs`; defaults to `rpc`. */
  txRpc?: NearRpc;
  txs?: boolean;
  /** The local weir.wasm's code hash, or null when there is no local build. */
  localWeirCodeHash?: string | null;
  /** Attempts per call when no endpoint answers for a reason other than rate (default 2, 5 s
   * apart). Rate refusals are waited out by the client (`src/pace.ts`), not retried here. */
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** The chain did not answer: every endpoint failed, timed out or rate-limited us. */
class Unreachable extends Error {}

const RETRY_CODES = new Set(["INTERNAL_ERROR", "TIMEOUT_ERROR"]);
/** A node's answer (an unknown account, a failed view) as opposed to no answer at all. */
const isAnswer = (e: unknown) => e instanceof RpcError && !RETRY_CODES.has(e.code);
const isUnknownAccount = (e: unknown) => e instanceof RpcError && /UNKNOWN_ACCOUNT|does not exist/i.test(`${e.code} ${e.message}`);
const msg = (e: unknown): string => {
  if (!(e instanceof Error)) return String(e);
  const c = (e as { cause?: { code?: string; message?: string } }).cause;
  return c && (c.code || c.message) ? `${e.message} (${c.code ?? c.message})` : e.message;
};

/** Checks the file is a deployment record and returns it. Throws with what is missing. */
export function parseRecord(text: string): RecordJson {
  let r: unknown;
  try {
    r = JSON.parse(text);
  } catch (e) {
    throw new Error(`not JSON: ${msg(e)}`);
  }
  const o = r as Partial<RecordJson> | null;
  const missing: string[] = [];
  if (!o || typeof o !== "object") throw new Error("not a deployment record: not an object");
  if (typeof o.network !== "string") missing.push("network");
  if (typeof o.suffix !== "string") missing.push("suffix");
  if (typeof o.wasm?.weir?.code_hash !== "string") missing.push("wasm.weir.code_hash");
  if (typeof o.wasm?.mock_usdc?.code_hash !== "string") missing.push("wasm.mock_usdc.code_hash");
  for (const k of ["accounts", "markets", "keys", "transactions"] as const) if (!Array.isArray(o[k])) missing.push(k);
  if (missing.length > 0) throw new Error(`not a deployment record written by apply: missing ${missing.join(", ")}`);
  return o as RecordJson;
}

/** The RPC endpoints for a record's network: `--rpc` if given, else testnet's two public ones. */
export function rpcUrlsFor(record: RecordJson, override?: string[]): string[] {
  if (override && override.length > 0) return override;
  if (record.network === "testnet") return [...TESTNET.rpc];
  throw new Error(`the record is for ${record.network}, which has no public endpoint: pass --rpc <url>`);
}

/** The code hash of the local weir.wasm, or null when it has not been built. */
export function localWeirCodeHash(): string | null {
  const path = new URL(`../../${LOCAL_WEIR_WASM}`, import.meta.url).pathname;
  if (!existsSync(path)) return null;
  return loadWasm("weir", { checkFresh: false }).codeHash;
}

const short = (k: string) => (k.length > 24 ? `${k.slice(0, 20)}...` : k);
const usd = (micro: string | number) => {
  const v = Number(micro) / 1e6;
  return Math.abs(v) >= 1000 ? v.toFixed(2) : String(Math.round(v * 1e6) / 1e6);
};
const iso = (secs: number) => new Date(secs * 1000).toISOString().replace(".000Z", "Z");
const sameSet = (a: readonly string[], b: readonly string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** The account that signed a recorded step, as the deploy tool names its steps (`steps.ts`,
 * `topup.ts`, `seal.ts`); null when the record does not say (an account the faucet created). */
export function signerOf(step: string, record: RecordJson): string | null {
  const ops = record.accounts.find((a) => a.role === "ops")?.id ?? null;
  const [kind, a] = step.split(":");
  switch (kind) {
    case "account": {
      const acc = record.accounts.find((x) => x.id === a);
      return acc && acc.created_by === ops ? ops : null;
    }
    case "deploy":
    case "seal":
    case "sweep":
      return a ?? null;
    case "storage":
    case "mint":
    case "register":
    case "topup":
      return ops;
    case "deposit":
    case "guard":
    case "key":
    case "rotate":
    case "retire":
      return a ?? null;
    default:
      return null;
  }
}

/** The account a step's transaction is looked up by when its signer is not recorded (the
 * account the step is about; a public node finds the transaction by its hash). */
const lookupAccount = (step: string): string => step.split(":")[1] || step;

export async function verifyRecord(record: RecordJson, opts: VerifyOptions): Promise<VerifyReport> {
  const checks: Check[] = [];
  const ok = (text: string) => checks.push({ status: "ok", text });
  const fail = (text: string) => checks.push({ status: "fail", text });
  const info = (text: string) => checks.push({ status: "info", text });
  const attempts = opts.attempts ?? 2;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  /** One read, retried through outages; a node's answer (even an error) is returned or thrown as is. */
  const ask = async <T>(fn: () => Promise<T>): Promise<T> => {
    let last: unknown = null;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await sleep(5000 * 2 ** (i - 1));
      try {
        return await fn();
      } catch (e) {
        if (isAnswer(e)) throw e;
        last = e;
        // The client has already waited out the rate limit for its bound: do not double it.
        if (e instanceof RpcUnavailable && e.attempts.every((a) => a.rateLimited)) break;
      }
    }
    throw new Unreachable(msg(last));
  };
  const rpc = opts.rpc;
  const account = (id: string) =>
    ask(async (): Promise<AccountInfo | null> => {
      try {
        return await rpc.viewAccount(id);
      } catch (e) {
        if (isUnknownAccount(e)) return null;
        throw e;
      }
    });
  const keys = (id: string) =>
    ask(async () => {
      try {
        const r = await rpc.call<{ keys: { public_key: string; access_key: { permission: AccessKeyPermission } }[] }>("query", {
          request_type: "view_access_key_list", finality: "final", account_id: id,
        });
        return r.keys.map((k) => ({ public_key: k.public_key, permission: k.access_key.permission }));
      } catch (e) {
        if (isUnknownAccount(e)) return [];
        throw e;
      }
    });
  /** A view; a contract error comes back as `{ error }` so the caller can name it. */
  const view = async <T>(contract: string, method: string): Promise<{ value: T } | { error: string }> => {
    try {
      return { value: await ask(() => rpc.view<T>(contract, method, {})) };
    } catch (e) {
      if (e instanceof Unreachable) throw e;
      return { error: msg(e) };
    }
  };

  /** Access keys of a contract account: sealed, or how many full-access keys remain. Not a failure. */
  const describeKeys = (id: string, onChain: { public_key: string; permission: AccessKeyPermission }[]) => {
    if (onChain.length === 0) return info(`${id}: sealed: no access keys, so its code can never change`);
    const full = onChain.filter((k) => k.permission === "FullAccess");
    const recorded = new Set(record.keys.filter((k) => k.account === id).map((k) => k.public_key));
    const ours = full.filter((k) => recorded.has(k.public_key)).length;
    const fc = onChain.length - full.length;
    const which = full.length === 0 ? "" : ours === full.length ? (full.length === 1 ? " (the one the record lists)" : " (all listed in the record)") : ` (${full.length - ours} not listed in the record)`;
    info(
      `${id}: not sealed: ${full.length} full-access key(s)${which}${fc > 0 ? ` and ${fc} function-call key(s)` : ""}; ` +
        (full.length > 0 ? "whoever holds a full-access key can replace this account's code" : "no full-access key, so its code cannot be replaced"),
    );
  };

  let unreachable: string | null = null;
  try {
    // Markets.
    const reporters = record.accounts.filter((a) => a.role === "reporter").map((a) => a.id);
    let localSaid = false;
    for (const m of record.markets) {
      const id = m.contract;
      const acct = await account(id);
      if (!acct) {
        fail(`${id} (${m.id}): the account does not exist`);
        continue;
      }
      const want = record.wasm.weir!.code_hash;
      if (acct.code_hash === want) ok(`${id}: code hash ${want} = the record's weir.wasm`);
      else fail(`${id}: code hash on chain ${acct.code_hash}, the record says ${want}`);
      if (!localSaid && opts.localWeirCodeHash !== undefined) {
        localSaid = true;
        const lh = opts.localWeirCodeHash;
        if (lh === null) info(`no local ${LOCAL_WEIR_WASM}: run contracts/build.sh to compare a build of your own (information, not a check)`);
        else if (lh === want) info(`local ${LOCAL_WEIR_WASM} has the record's code hash ${lh}: the local build is the same bytes`);
        else info(`local ${LOCAL_WEIR_WASM} has code hash ${lh}, not ${want}: the build is not reproducible across machines (cargo-near non-reproducible-wasm), so this alone does not show different source`);
      }

      const p = await view<WireParams>(id, "get_params");
      if ("error" in p) fail(`${id}: get_params failed: ${p.error}`);
      else if (!m.params) fail(`${id}: the record holds no parameters for ${m.id} (it could not read them when it was written)`);
      else {
        const diff = paramsDiff(p.value, m.params);
        if (diff.length === 0) ok(`${id}: get_params = the record's ${Object.keys(m.params).length} fields (t0 ${m.params.t0}, ${iso(m.params.t0)})`);
        else fail(`${id}: get_params differs from the record in ${diff.length} field(s): ${diff.join("; ")}`);
        if (sameSet(p.value.reporters, reporters)) ok(`${id}: reporters on chain are the record's ${reporters.length} reporter accounts (quorum ${p.value.quorum})`);
        else fail(`${id}: reporters on chain [${p.value.reporters.join(", ")}], the record's reporter accounts [${reporters.join(", ")}]`);
      }

      const ks = await keys(id);
      if (m.sealed && ks.length > 0) fail(`${id}: the record says it was sealed (tx ${m.sealed.tx}), but it has ${ks.length} access key(s)`);
      describeKeys(id, ks);

      // What the market is doing now: information only.
      const st = await view<WireStatus>(id, "get_status");
      let now: number | null = null;
      if ("error" in st) info(`${id}: get_status failed: ${st.error}`);
      else {
        now = st.value.now;
        const live = st.value.live.map((s) => `series ${s.series}${s.round !== null ? ` round ${s.round}` : ""} (${s.phase})`);
        info(`${id}: status at ${iso(st.value.now)}: ${live.length === 0 ? "no live series" : live.join(", ")}`);
      }
      const lp = await view<WireLastPrint | null>(id, "get_last_print");
      const every = m.params?.print_interval_secs ?? (("value" in p && p.value.print_interval_secs) || 0);
      if ("error" in lp) info(`${id}: get_last_print failed: ${lp.error}`);
      else if (lp.value === null) info(`${id}: no print yet (prints every ${every / 60} min): no reporter has made a print`);
      else {
        const age = now === null ? null : Math.max(0, Math.round((now - lp.value.bucket) / 60));
        const grace = m.params?.report_grace_secs ?? 0;
        const fresh = now !== null && now - lp.value.bucket <= 2 * every + grace;
        info(
          `${id}: last print bucket ${lp.value.bucket} (${iso(lp.value.bucket)}), ${usd(lp.value.price)} USD/GPU-hour` +
            (age === null ? "" : `, ${age} min before chain time`) +
            `; prints every ${every / 60} min: ${fresh ? "reporters look active" : "no recent print, the reporters or keeper may be stopped"}`,
        );
      }
      const t = await view<WireTotals>(id, "get_totals");
      if ("error" in t) info(`${id}: get_totals failed: ${t.error}`);
      else info(`${id}: totals in tUSDC: free ${usd(t.value.free)}, locked ${usd(t.value.locked)}, sets backing ${usd(t.value.sets_backing)}, unredeemed ${usd(t.value.unredeemed)}, burned ${usd(t.value.burned)}`);
    }

    // The test token.
    const usdc = record.accounts.find((a) => a.role === "usdc")?.id ?? record.markets[0]?.usdc;
    if (usdc) {
      const acct = await account(usdc);
      const want = record.wasm.mock_usdc!.code_hash;
      if (!acct) fail(`${usdc} (test token): the account does not exist`);
      else {
        if (acct.code_hash === want) ok(`${usdc}: code hash ${want} = the record's mock_usdc.wasm (the test token tUSDC)`);
        else fail(`${usdc}: code hash on chain ${acct.code_hash}, the record says ${want}`);
        describeKeys(usdc, await keys(usdc));
      }
    } else fail("the record names no test token account");

    // Operator keys: every function-call key the record lists.
    const byAccount = new Map<string, RecordJson["keys"]>();
    for (const k of record.keys.filter((x) => x.receiver !== undefined)) byAccount.set(k.account, [...(byAccount.get(k.account) ?? []), k]);
    for (const [acc, rows] of byAccount) {
      const onChain = await keys(acc);
      let bad = 0;
      for (const r of rows) {
        const k = onChain.find((x) => x.public_key === r.public_key);
        const label = `${acc}: key ${short(r.public_key)} for ${r.receiver}`;
        if (!k) {
          fail(`${label}: not on chain${onChain.length === 0 ? " (the account has no keys or does not exist)" : ""}`);
          bad++;
          continue;
        }
        if (k.permission === "FullAccess") {
          fail(`${label}: is a full-access key on chain, the record says function call`);
          bad++;
          continue;
        }
        const fc = k.permission.FunctionCall;
        const problems: string[] = [];
        if (fc.receiver_id !== r.receiver) problems.push(`receiver on chain ${fc.receiver_id}, the record says ${r.receiver}`);
        const want = r.methods ?? [];
        if (!sameSet(fc.method_names, want)) {
          const extra = fc.method_names.filter((x) => !want.includes(x));
          const lack = want.filter((x) => !fc.method_names.includes(x));
          problems.push(`methods on chain [${fc.method_names.join(", ")}], the record says [${want.join(", ")}]${extra.length ? `; extra: ${extra.join(", ")}` : ""}${lack.length ? `; missing: ${lack.join(", ")}` : ""}`);
        }
        if (problems.length > 0) {
          fail(`${label}: ${problems.join("; ")}`);
          bad++;
        }
      }
      if (bad === 0) {
        const methods = [...new Set(rows.map((r) => (r.methods ?? []).join(", ")))].join(" / ");
        ok(`${acc}: ${rows.length} function-call key(s) as recorded, for ${rows.map((r) => r.receiver).join(", ")} [${methods}]`);
      }
    }

    // Transactions, only when asked: one lookup each.
    if (opts.txs) {
      const txRpc = opts.txRpc ?? rpc;
      const rows = record.transactions.filter((t) => t.tx);
      const notSent = record.transactions.length - rows.length;
      let good = 0;
      for (const t of rows) {
        const signer = signerOf(t.step, record);
        let raw: { transaction?: { signer_id?: string } } & Parameters<typeof decodeOutcome>[0];
        try {
          raw = await ask(() => txRpc.call("tx", { tx_hash: t.tx, sender_account_id: signer ?? lookupAccount(t.step), wait_until: "NONE" }));
        } catch (e) {
          if (e instanceof Unreachable) throw e;
          fail(`tx ${t.tx} (${t.step}): ${/UNKNOWN_TRANSACTION|doesn't exist/i.test(msg(e)) ? "unknown to the chain" : msg(e)}`);
          continue;
        }
        const o = decodeOutcome(raw, t.tx!);
        const by = raw.transaction?.signer_id;
        if (!o.ok) fail(`tx ${t.tx} (${t.step}): failed on chain: ${o.error}`);
        else if (signer && by && by !== signer) fail(`tx ${t.tx} (${t.step}): signed by ${by}, the deploy tool signs this step as ${signer}`);
        else good++;
      }
      if (good === rows.length) ok(`transactions: all ${rows.length} recorded hashes are known to the chain and succeeded${notSent ? ` (${notSent} steps were found already done and have no hash)` : ""}`);
      else info(`transactions: ${good} of ${rows.length} recorded hashes known and successful`);
    }
  } catch (e) {
    if (!(e instanceof Unreachable)) throw e;
    unreachable = e.message;
  }

  const fails = checks.filter((c) => c.status === "fail").length;
  const outcome: Outcome = fails > 0 ? "differs" : unreachable !== null ? "unreachable" : "match";
  return { network: record.network, suffix: record.suffix, rpc: [...rpc.urls], outcome, unreachable, checks };
}

/** Every field where the chain's parameters differ from the record's, named. */
export function paramsDiff(chain: WireParams, record: WireParams): string[] {
  const out: string[] = [];
  for (const k of new Set([...Object.keys(record), ...Object.keys(chain)])) {
    const a = JSON.stringify((chain as unknown as Record<string, unknown>)[k]);
    const r = JSON.stringify((record as unknown as Record<string, unknown>)[k]);
    if (a !== r) out.push(`${k}: chain ${a ?? "(absent)"}, record ${r ?? "(absent)"}`);
  }
  return out;
}

export function renderVerify(r: VerifyReport, file: string): string {
  const out = [`Deployment record ${file}: ${r.network}, suffix ${r.suffix}; read from ${r.rpc.join(", ")}`];
  for (const c of r.checks) out.push(`${c.status === "ok" ? "  ok  " : c.status === "fail" ? "  FAIL " : "  --  "}${c.text}`);
  const n = r.checks.filter((c) => c.status !== "info").length;
  const fails = r.checks.filter((c) => c.status === "fail").length;
  if (r.unreachable !== null) out.push(`  --  the chain could not be reached: ${r.unreachable}`);
  if (r.outcome === "match") out.push(`RESULT match: all ${n} checks against ${r.network} agree with ${file}`);
  else if (r.outcome === "differs")
    out.push(`RESULT DIFFERS: ${fails} of ${n} checks found ${r.network} different from ${file}${r.unreachable !== null ? " (the read stopped early: the chain stopped answering)" : ""}`);
  else out.push(`RESULT NOT CHECKED: ${r.network} could not be reached after ${n} checks; nothing is claimed either way about ${file}`);
  return out.join("\n");
}

/** The CLI: `verify <record.json> [--rpc url,...] [--json] [--txs]`. Returns the exit code. */
export async function verifyCli(
  args: string[],
  opts: { rpc?: string[]; json?: boolean; txs?: boolean; fetch?: FetchLike; sleep?: (ms: number) => Promise<void>; now?: () => number; localWeirCodeHash?: string | null },
  say: (line: string) => void,
): Promise<number> {
  if (args.length !== 1) {
    console.error("usage: node deploy/src/cli.ts verify <record.json> [--rpc url,...] [--json] [--txs]");
    return EXIT.usage;
  }
  const file = args[0]!;
  let record: RecordJson;
  let urls: string[];
  try {
    record = parseRecord(readFileSync(file, "utf8"));
    urls = rpcUrlsFor(record, opts.rpc);
  } catch (e) {
    console.error(`${file}: ${msg(e)}`);
    return EXIT.usage;
  }
  // src/pace.ts: rate refusals on every endpoint are waited out for up to 60 s per call.
  const mk = (u: string[]) =>
    rpcFor(u, opts.fetch, { maxCallWaitMs: VERIFY_MAX_CALL_WAIT_MS, ...(opts.sleep ? { sleep: opts.sleep } : {}), ...(opts.now ? { now: opts.now } : {}) });
  const rpc = mk(urls);
  const txRpc = opts.rpc || record.network !== "testnet" ? rpc : mk(TESTNET_ARCHIVAL);
  const r = await verifyRecord(record, {
    rpc, txRpc, txs: opts.txs ?? false,
    localWeirCodeHash: opts.localWeirCodeHash !== undefined ? opts.localWeirCodeHash : localWeirCodeHash(),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
  });
  say(opts.json ? JSON.stringify({ file, ...r }, null, 2) : renderVerify(r, file));
  return EXIT[r.outcome];
}
