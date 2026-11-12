import { CopyBlock } from "@/components/copy-block.tsx";
import { CheckIcon, CrossIcon } from "@/components/icons.tsx";
import { AgentsBook } from "./agents-book.tsx";
import { deployments } from "@/lib/build.ts";
import { MARKET_INFO, type MarketId } from "@/lib/config.ts";
import { loadAgents } from "@/lib/data/agents.ts";
import { siteCfg } from "@/lib/site.ts";
import { serverReader } from "@/lib/source.ts";

const METHODS = ["commit", "reveal", "clear", "mint", "merge", "settle", "redeem"];

/** The agents view's guide: who can do what, the key, the commit hash, a loop, and the book. */
export async function AgentsGuide({ market }: { market: MarketId }) {
  const d = deployments();
  const cfg = siteCfg();
  const initial = await loadAgents(serverReader(market));
  const contract = d.markets.find((m) => m.id === market)?.contract ?? null;
  const c = contract ?? "<weir contract>";
  const net = d.network;
  const site = cfg.siteUrl;

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
  sign-as YOUR_ACCOUNT network-config ${net} sign-with-keychain send

# 3. Bound the agent with your full-access key: a guard (how far from the index, in micro-USD,
#    its prices may be) and a round lock limit (the most its commits may lock in one round).
near contract call-function as-transaction ${c} set_guard \
  json-args '{"guard":150000,"max_round_lock":"20000000"}' \
  prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' \
  sign-as AGENT_ACCOUNT network-config ${net} sign-with-keychain send`;

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
    <div className="px-4 pb-8 md:px-6">
        <div className="pt-6">
          <h2 className="font-display m-0 text-2xl text-foreground">A key that bids and stops there</h2>
          <p className="m-0 mt-2 max-w-2xl text-base text-muted-foreground">A function-call key can commit, reveal, clear and redeem. Withdrawing needs 1 yoctoNEAR, which that key cannot attach.</p>
        </div>

        <section className="section" aria-labelledby="who-h">
          <h2 id="who-h">Who can do what</h2>
          <div className="boards">
            <Board
              title="Full-access key"
              note="Yours. Keep it off the agent's machine."
              can={["Deposit USDC (ft_transfer_call on the token)", "Withdraw the free balance", "Set or clear the guard and the round lock limit", "Move positions to another account", "Everything a function-call key can do"]}
              cannot={["Change Weir's code or parameters: there is no method for it"]}
            />
            <Board
              title="Function-call key on Weir"
              note={`Limited to ${METHODS.join(", ")}.`}
              can={["Commit and reveal sealed orders with the dollars already deposited", "Clear a finished round, settle and redeem", "Mint and merge sets", "Burn gas up to the key's allowance"]}
              cannot={["Withdraw: needs 1 yoctoNEAR attached", "Change the guard or the round lock limit: needs 1 yoctoNEAR", "Move positions: needs 1 yoctoNEAR", "Call any other contract, or the token"]}
            />
          </div>
          <p className="small muted" style={{ marginTop: 16 }}>
            Three things bound an agent, and it can change none of them. First, the deposit: it can lock at most the account&rsquo;s free balance and loses at most what it locked or paid (SPEC 11, invariant 5). Second, the round lock limit (<code>max_round_lock</code>): its commits in one round may lock no more than you allow, so a faulty or hijacked agent can put at most that much at risk of forfeit per round. Third, the guard: an order priced further than the guard from the reference is void at reveal. The commit records the guard and the reference when it is made, so changing the guard later cannot cancel a bid. Each commit also pays a small fee, burned when the round clears (<a href="/spec#s15">SPEC 15</a>).
          </p>
        </section>

        <section className="section" aria-labelledby="steps-h">
          <h2 id="steps-h">Add the key</h2>
          <p className="lead">
            With near-cli-rs. {contract ? `The ${MARKET_INFO[market].name} market's contract is ${contract}.` : "The contract account goes where it says <weir contract> once a market is deployed."} Replace the upper-case names.
          </p>
          <CopyBlock text={addKey} label="Commands to add an agent key and deposit" title={`Shell · near-cli-rs · ${net}`} />
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
          <CopyBlock text={loop} label="Minimal agent loop in JavaScript" title="agent.mjs · Node 22" />
        </section>

        <section className="section" aria-labelledby="book-h">
          <div className="section-head">
            <h2 id="book-h">Agents on the book</h2>
            <span className="note">The last 20 commits from accounts that hold only function-call keys</span>
          </div>
          <AgentsBook cfg={cfg} initial={initial} market={market} />
        </section>
    </div>
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

