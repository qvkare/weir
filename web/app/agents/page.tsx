import type { Metadata } from "next";
import { headers } from "next/headers";
import { Suspense } from "react";
import { CopyBlock } from "@/components/copy-block.tsx";
import { CheckIcon, CrossIcon, EyeIcon, LockIcon } from "@/components/icons.tsx";
import { Empty, NotDeployed, RpcError, Skeleton } from "@/components/state.tsx";
import { deployments } from "@/lib/build.ts";
import { valueOf } from "@/lib/cache.ts";
import { marketFromParam, MARKET_INFO, type MarketId } from "@/lib/config.ts";
import { fmtGpuH, fmtInt, fmtUsd, shortAccount } from "@/lib/format.ts";
import { latestRound, loadCore, loadResults } from "@/lib/load.ts";
import { functionCallOnly } from "@/lib/near.ts";
import { readKeys } from "@/lib/source.ts";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Agents", description: "Give an agent a NEAR function-call key that can commit, reveal, clear and redeem on Weir, and cannot withdraw. The commit string, a minimal loop, and the agents on the book." };

type Search = Promise<Record<string, string | string[] | undefined>>;

const METHODS = ["commit", "reveal", "clear", "mint", "merge", "redeem"];

export default async function AgentsPage({ searchParams }: { searchParams: Search }) {
  const market = marketFromParam((await searchParams).m);
  const d = deployments();
  const contract = d.markets.find((m) => m.id === market)?.contract ?? null;
  const c = contract ?? "<weir contract>";
  const net = d.network;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const site = host ? `${h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https")}://${host}` : "<this site>";

  const addKey = `# 1. On the account that will hold the deposit, add a key for the agent.
#    It may call only these methods on Weir, and its allowance caps the gas it can burn.
near account add-key AGENT_ACCOUNT \\
  grant-function-call-access --allowance '0.5 NEAR' \\
  --contract-account-id ${c} \\
  --function-names ${METHODS.join(",")} \\
  autogenerate-new-keypair save-to-keychain \\
  network-config ${net} sign-with-keychain send

# 2. Deposit the dollars the agent may trade with (this needs your full-access key).
near contract call-function as-transaction USDC_TOKEN ft_transfer_call \\
  json-args '{"receiver_id":"${c}","amount":"100000000","msg":"AGENT_ACCOUNT"}' \\
  prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' \\
  sign-as YOUR_ACCOUNT network-config ${net} sign-with-keychain send`;

  const loop = `// A minimal agent: one sealed LONG per round, revealed on time, round cleared after.
// Node 22+. Reads ${site}/api/status; signs with the near CLI and the key added above.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const SITE = "${site}", WEIR = "${c}", ME = "AGENT_ACCOUNT", NET = "${net}";
const call = (method, args) => execFileSync("near", ["contract", "call-function", "as-transaction", WEIR, method,
  "json-args", JSON.stringify(args), "prepaid-gas", "100 Tgas", "attached-deposit", "0 NEAR",
  "sign-as", ME, "network-config", NET, "sign-with-keychain", "send"], { encoding: "utf8" });
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const open = new Map(); // "series|round" -> order, kept until revealed

for (;;) {
  const { status, params } = await (await fetch(\`\${SITE}/api/status?m=${market}\`)).json();
  for (const l of status.live) {
    const key = \`\${l.series}|\${l.round}\`;
    if (l.phase === "Commit" && !open.has(key)) {
      const o = { side: "Long", size: 8, price: 30 * params.tick, salt: randomBytes(16).toString("hex") };
      const s = o.side === "Long" ? "L" : "S";
      const hash = sha(\`weir:v1|\${l.series}|\${l.round}|\${ME}|\${s}|\${o.size}|\${o.price}|\${o.salt}\`);
      const lock = String(o.size * o.price); // covers a LONG: size * price
      const seq = Number(call("commit", { series: l.series, hash, lock }).trim()); // the CLI prints the return value to stdout
      open.set(key, { ...o, seq, series: l.series, round: l.round }); // keep the salt: no salt, no reveal
    }
    if (l.phase === "Reveal" && open.has(key)) {
      const o = open.get(key);
      call("reveal", { series: o.series, round: o.round, seq: o.seq, side: o.side, size: o.size, price: o.price, salt: o.salt });
      open.delete(key);
      setTimeout(() => { try { call("clear", { series: o.series, round: o.round }); } catch {} }, (l.phase_ends_at - status.now + 5) * 1000);
    }
  }
  await new Promise((r) => setTimeout(r, 10_000));
}`;

  return (
    <main id="main">
      <div className="wrap">
        <header className="page-head">
          <span className="eyebrow">Agents · {MARKET_INFO[market].label} market</span>
          <h1>A key that bids and stops there</h1>
          <p className="sub">A function-call key can commit, reveal, clear and redeem. Withdrawing needs 1 yoctoNEAR, which that key cannot attach.</p>
        </header>

        <section className="section" aria-labelledby="who-h">
          <h2 id="who-h">Who can do what</h2>
          <div className="boards">
            <Board
              title="Full-access key"
              note="Yours. Keep it off the agent's machine."
              can={["Deposit USDC (ft_transfer_call on the token)", "Withdraw the free balance", "Set or clear the guard", "Move positions to another account", "Everything a function-call key can do"]}
              cannot={["Change Weir's code or parameters: there is no method for it"]}
            />
            <Board
              title="Function-call key on Weir"
              note={`Limited to ${METHODS.join(", ")}.`}
              can={["Commit and reveal sealed orders with the dollars already deposited", "Clear a finished round, settle and redeem", "Mint and merge sets", "Burn gas up to the key's allowance"]}
              cannot={["Withdraw: needs 1 yoctoNEAR attached", "Change the guard: needs 1 yoctoNEAR", "Move positions: needs 1 yoctoNEAR", "Call any other contract, or the token"]}
            />
          </div>
          <p className="small muted" style={{ marginTop: 16 }}>
            The budget is what you deposit: an agent can lock at most the account&rsquo;s free balance, and loses at most what it locked or paid (SPEC 11, invariant 5). The guard you set with your own key voids any of its orders priced too far from the index.
          </p>
        </section>

        <section className="section" aria-labelledby="steps-h">
          <h2 id="steps-h">Add the key</h2>
          <p className="lead">
            With near-cli-rs. {contract ? `The ${MARKET_INFO[market].label.toLowerCase()} market's contract is ${contract}.` : "The contract account goes where it says <weir contract> once a market is deployed."} Replace the upper-case names.
          </p>
          <CopyBlock text={addKey} label="Commands to add an agent key and deposit" />
        </section>

        <section className="section" aria-labelledby="hash-h">
          <h2 id="hash-h">The commit hash</h2>
          <p className="lead">sha256 of this UTF-8 string, as 64 lowercase hex characters. Numbers in decimal with no padding; side is L or S; price is always a LONG price in micro-USD per GPU-hour; the salt is 32 to 64 lowercase hex characters you keep until the reveal.</p>
          <p className="preimage">weir:v1|&lt;series&gt;|&lt;round&gt;|&lt;account_id&gt;|&lt;side&gt;|&lt;size&gt;|&lt;price&gt;|&lt;salt&gt;</p>
          <p className="small" style={{ marginTop: 12 }}>
            Check yours with the free view <code>commit_hash(series, round, account_id, side, size, price, salt)</code>. Lock at least <code>size * price</code> for LONG or <code>size * (band - price)</code> for SHORT, or the reveal fails.
          </p>
        </section>

        <section className="section" aria-labelledby="loop-h">
          <h2 id="loop-h">A minimal agent loop</h2>
          <p className="lead">About 30 lines of Node. It reads this site&rsquo;s status endpoint and signs with the key above through the near CLI. It is a sketch to start from: it bids a fixed price and does not handle a full round or a failed reveal.</p>
          <CopyBlock text={loop} label="Minimal agent loop in JavaScript" />
        </section>

        <section className="section" aria-labelledby="book-h">
          <div className="section-head">
            <h2 id="book-h">Agents on the book</h2>
            <span className="note">The last 20 commits from accounts that hold only function-call keys</span>
          </div>
          <Suspense fallback={<Skeleton lines={4} label="Reading the book" />}>
            <AgentsOnBook market={market} />
          </Suspense>
        </section>
      </div>
    </main>
  );
}

function Board({ title, note, can, cannot }: { title: string; note: string; can: string[]; cannot: string[] }) {
  return (
    <div className="board">
      <h3>{title}</h3>
      <p className="small muted">{note}</p>
      <h4 style={{ marginTop: 16 }}>Can</h4>
      <ul>
        {can.map((x) => (
          <li key={x}>
            <span className="ok"><CheckIcon /></span>
            <span>{x}</span>
          </li>
        ))}
      </ul>
      <h4 style={{ marginTop: 16 }}>Cannot</h4>
      <ul>
        {cannot.map((x) => (
          <li key={x}>
            <span className="bad"><CrossIcon /></span>
            <span>{x}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface BookEntry {
  owner: string;
  series: number;
  round: number;
  seq: number;
  state: string;
  side: string | null;
  size: number | null;
  lock: string | null;
  filled: number | null;
}

async function AgentsOnBook({ market }: { market: MarketId }) {
  const core = await loadCore(market);
  if (core.src.kind === "none") return <NotDeployed market={market} what="book" />;
  const params = valueOf(core.params);
  const status = valueOf(core.status);
  if (!params || !status) return <RpcError read={!core.params.ok ? core.params : core.status} href="/agents" model={core.src.kind === "model"} />;
  const entries: BookEntry[] = [];
  for (const l of status.live) {
    if (l.round !== null) {
      const r = valueOf(await core.src.view("get_round", { series: l.series, round: l.round }));
      for (const c of [...(r?.commits ?? [])].reverse()) entries.push({ owner: c.owner, series: l.series, round: l.round, seq: c.seq, state: c.state, side: c.order?.side ?? null, size: c.order?.size ?? null, lock: c.lock, filled: null });
    }
    const results = valueOf(await loadResults(core.src, l.series, latestRound(params, l.series, core.now), 10)) ?? [];
    for (const [round, res] of [...results].reverse()) for (const f of [...res.fills].reverse()) entries.push({ owner: f.owner, series: l.series, round, seq: f.seq, state: "Cleared", side: f.side, size: f.size, lock: null, filled: f.filled });
  }
  const owners = [...new Set(entries.map((e) => e.owner))];
  const keyReads = await Promise.all(owners.map(async (o) => [o, await readKeys(market, o)] as const));
  const fc = new Set(keyReads.filter(([, r]) => { const k = valueOf(r); return k !== null && functionCallOnly(k); }).map(([o]) => o));
  const unknown = keyReads.filter(([, r]) => valueOf(r) === null).length;
  const list = entries.filter((e) => fc.has(e.owner)).slice(0, 20);
  if (list.length === 0) return <Empty>No commit in the live and last ten cleared rounds came from an account that holds only function-call keys.{unknown ? ` The keys of ${unknown} account${unknown === 1 ? "" : "s"} could not be read.` : ""}</Empty>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Account</th>
            <th scope="col">Series, round, seq</th>
            <th scope="col">Side</th>
            <th scope="col" className="num">Size</th>
            <th scope="col" className="num collapse-sm">Lock</th>
            <th scope="col">State</th>
          </tr>
        </thead>
        <tbody>
          {list.map((e) => (
            <tr key={`${e.series}-${e.round}-${e.seq}-${e.state}`}>
              <td className="mono" title={e.owner}>{shortAccount(e.owner)}</td>
              <td>
                {e.series}, {e.round}, {e.seq}
              </td>
              <td>{e.side ? <span className={e.side === "Long" ? "side-long" : "side-short"}>{e.side === "Long" ? "LONG" : "SHORT"}</span> : <span className="lock-cell"><LockIcon /> sealed</span>}</td>
              <td className="num">{e.size !== null ? fmtGpuH(e.size) : <span className="lock-cell"><LockIcon /></span>}</td>
              <td className="num collapse-sm">{e.lock ? fmtUsd(e.lock) : <span className="muted">cleared</span>}</td>
              <td>{e.state === "Cleared" ? `filled ${fmtInt(e.filled ?? 0)}` : e.state === "Revealed" ? <><EyeIcon /> revealed</> : e.state === "Void" ? <span className="flag">void</span> : "sealed"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {core.src.kind === "model" ? <p className="tiny flag" style={{ marginTop: 8 }}>Model: which accounts hold only function-call keys is set by the script, not read from the chain.</p> : null}
    </div>
  );
}
