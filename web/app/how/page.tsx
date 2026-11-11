import type { Metadata } from "next";
import Link from "next/link";
import { clearRound, commitHash, commitPreimage, type Order } from "@weir/engine";
import type { WireParams } from "@weir/engine";
import { LimitsList } from "@/components/home-blocks.tsx";
import { QuoteWidget } from "@/components/quote-widget.tsx";
import { SeriesStrip } from "@/components/series-strip.tsx";
import { StepChart } from "@/components/step-chart.tsx";
import { buildData, deployments, funding } from "@/lib/build.ts";
import { valueOf } from "@/lib/cache.ts";
import { marketFromParam, MARKET_INFO } from "@/lib/config.ts";
import { fmtBps, fmtGpuH, fmtInt, fmtPrice, fmtSpan, fmtUsd, fmtUtc, shortHash } from "@/lib/format.ts";
import { loadCore } from "@/lib/load.ts";
import { MODEL_PARAMS } from "@/lib/model.ts";
import { longPayout, payoffAt } from "@/lib/payoff.ts";
import { stepSummary } from "@/lib/step.ts";
import { timesOf } from "@/lib/views.ts";
import { callView, Market } from "@weir/engine";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "How it works", description: "Series and rounds, commit and reveal, the clearing rule, settlement, funding through NEAR Intents, and every limit." };

type Search = Promise<Record<string, string | string[] | undefined>>;

/** Example parameters for the drawings when no market is deployed: the fast model's, labelled as such. */
function exampleParams(): WireParams {
  return callView(new Market(MODEL_PARAMS.fast, MODEL_PARAMS.fast.t0), "get_params", {});
}

export default async function HowPage({ searchParams }: { searchParams: Search }) {
  const market = marketFromParam((await searchParams).m);
  const core = await loadCore(market);
  const live = valueOf(core.params);
  const params = live ?? exampleParams();
  // Worked examples in round dollars, put on the tick grid.
  const snap = (micro: number) => Math.max(params.tick, Math.round(micro / params.tick) * params.tick);
  const paramsNote = live ? `${MARKET_INFO[market].label} market parameters, read from get_params${core.src.kind === "model" ? " of the model" : ""}.` : "Example parameters (the fast model's), because no market is deployed yet.";
  const f = funding();
  const intents = buildData().modules.intents;

  // Series clock: the series whose auctions are open now, or the next one.
  const now = core.now;
  const s = Math.max(0, Math.floor((now + params.lead_secs - params.t0) / params.period_secs));
  const times = timesOf(live ? s : 1, params);
  const clockNow = live ? now : times.auctionOpen + (times.commitSecs + times.revealSecs) * 2 + times.commitSecs / 2;

  // Commit and reveal: a worked hash, computed here by the engine.
  const salt = "5a17c0de".repeat(4);
  const example = { series: times.series, round: 3, accountId: "you.testnet", side: "Long" as const, size: 1344, price: snap(300_000), salt };
  const preimage = commitPreimage(example);
  const hash = commitHash(example);

  // Clearing: three orders, cleared by the engine's clearRound.
  const band = snap(1_000_000);
  const orders: (Order & { owner: string })[] = [
    { seq: 0, owner: "A", side: "Long", size: 10, price: snap(600_000) },
    { seq: 1, owner: "B", side: "Long", size: 10, price: snap(400_000) },
    { seq: 2, owner: "C", side: "Short", size: 15, price: snap(300_000) },
  ];
  const cleared = clearRound(orders, params.tick);
  const filled = orders.map((o, i) => ({ ...o, filled: cleared.fills[i]! }));

  // Settlement: one series, one fixing.
  const floor = snap(2_000_000);
  const sBand = snap(800_000);
  const p = snap(300_000);
  const fixing = snap(2_550_000);
  const lp = longPayout(fixing, floor, sBand);
  const buyer = payoffAt("Long", fixing, floor, sBand, p);
  const units = 1344;

  return (
    <main id="main">
      <div className="wrap">
        <header className="page-head">
          <span className="eyebrow">How it works</span>
          <h1>A week-ahead price, set in sealed rounds</h1>
          <p className="sub">Five steps from a sealed order to a payout, then every limit. Figures in the drawings use {live ? "the live parameters" : "example parameters"}; worked examples are computed by the Weir engine on this page.</p>
        </header>

        <section className="how-section" id="series">
          <div className="text">
            <h2>1. The series clock</h2>
            <p>
              A series is one delivery window of {fmtSpan(params.period_secs)}. Its auctions open {fmtSpan(params.lead_secs)} before delivery starts and run as back-to-back rounds of {fmtSpan(params.commit_secs)} commit and {fmtSpan(params.reveal_secs)} reveal. Auctions close {fmtSpan(params.cutoff_secs)} before delivery starts, so the price is set before the first hour is used, and only one series is in auction at a time. Phases come from the clock alone; nobody starts or stops a round.
            </p>
            <p>The series settles on the average of the index prints inside its delivery window, once the last bucket&rsquo;s report window ({fmtSpan(params.report_grace_secs)}) has closed.</p>
            <p className="tiny muted">{paramsNote}</p>
          </div>
          <div>
            <SeriesStrip times={times} now={clockNow} round={null} summary={`Series ${times.series}: auctions from ${fmtUtc(times.auctionOpen)} to ${fmtUtc(times.auctionClose)}, delivery from ${fmtUtc(times.deliveryStart)} to ${fmtUtc(times.deliveryEnd)}, settlement from ${fmtUtc(times.settleAt)}.`} />
            <div className="legend" aria-hidden="true">
              <span className="key"><span className="swatch box" style={{ color: "var(--ink)" }} /> Commit phase</span>
              <span className="key"><span className="swatch box" style={{ color: "var(--ink-3)" }} /> Reveal phase (hatched)</span>
              <span className="key"><span className="swatch box" style={{ color: "var(--panel)" }} /> Delivery window</span>
            </div>
          </div>
        </section>

        <section className="how-section" id="commit">
          <div className="text">
            <h2>2. Commit and reveal</h2>
            <p>
              During the commit phase an order is only a hash and a lock. The lock is dollars moved from your free balance; at least {fmtUsd(params.min_lock)} (min_lock). Because both sides lock dollars, a commit shows neither side, size nor price, only an upper bound on what the order can cost.
            </p>
            <p>
              During the reveal phase you send the order and the salt. The contract hashes them again and compares. A commit not revealed in time forfeits {fmtBps(params.forfeit_bps)} of its lock to the series&rsquo; bonus pool; the rest comes back.
            </p>
          </div>
          <div className="stack">
            <p className="small muted">The string that is hashed (SPEC 6.2), for one example order:</p>
            <p className="preimage" aria-label={`Preimage: ${preimage}`}>
              {preimage.split("|").map((part, i, all) => (
                <span key={i}>
                  <span className="part">{part}</span>
                  {i < all.length - 1 ? "|" : ""}
                </span>
              ))}
            </p>
            <dl className="kv">
              <dt>Fields</dt>
              <dd>version, series, round, account, side (L or S), size in GPU-hours, LONG price in micro-USD, salt (32 to 64 hex)</dd>
              <dt>sha256</dt>
              <dd className="mono" style={{ overflowWrap: "anywhere" }}>{hash}</dd>
              <dt>Check yours</dt>
              <dd>
                The view <code>commit_hash</code> returns the same hash for the same fields. See <Link href="/agents">Agents</Link>.
              </dd>
            </dl>
            <p className="small flag">Save your salt. Without it you cannot reveal, and {fmtBps(params.forfeit_bps)} of the lock is forfeit.</p>
          </div>
        </section>

        <section className="how-section" id="clearing">
          <div className="text">
            <h2>3. Clearing</h2>
            <p>
              After the reveal phase anyone may call <code>clear</code>. The contract stacks LONG orders from the highest price down and SHORT orders from the lowest up, and takes the price that trades the most. Ties go to the smallest imbalance, then to the middle of what is left, rounded down to the tick.
            </p>
            <p>Every filled LONG pays that one price per GPU-hour, and every filled SHORT pays the band minus it. A LONG and a SHORT unit together paid exactly the band, so each new pair is fully backed.</p>
            <p>
              In this worked example (band {fmtPrice(band, params.tick)}): {stepSummary({ orders, price: cleared.price, volume: cleared.volume, cleared: true, floor: null, tick: params.tick })} B is filled in part, {fmtInt(cleared.fills[1]!)} of {fmtInt(orders[1]!.size)}.
            </p>
          </div>
          <div>
            <StepChart orders={filled} band={band} floor={null} tick={params.tick} price={cleared.price} volume={cleared.volume} cleared height={320} />
          </div>
        </section>

        <section className="how-section" id="settlement">
          <div className="text">
            <h2>4. Settlement</h2>
            <p>
              After delivery, <code>settle</code> takes the average of the series&rsquo; prints as the fixing. A LONG unit pays the fixing minus the floor, between zero and the band. A SHORT unit pays the band minus that. Then anyone may call <code>redeem</code> for any holder.
            </p>
            <p>
              If fewer than {fmtInt(params.min_prints)} prints (min_prints) arrived, the series waits; after {fmtSpan(params.void_after_secs)} (void_after_secs) it settles on what it has, or on the middle of the band if it has none, and is marked void.
            </p>
          </div>
          <div className="table-wrap">
            <table>
              <caption>Worked example: a buyer hedges {fmtGpuH(units)} with LONG.</caption>
              <tbody>
                <tr><th scope="row">Floor, band</th><td className="num">{fmtPrice(floor, params.tick)}, {fmtPrice(sBand, params.tick)}</td></tr>
                <tr><th scope="row">LONG price paid at the auction, p</th><td className="num">{fmtPrice(p, params.tick)}</td></tr>
                <tr><th scope="row">Locked at the open, {fmtInt(units)} x p</th><td className="num">{fmtUsd(BigInt(units) * BigInt(p))}</td></tr>
                <tr><th scope="row">Fixing: the week&rsquo;s average</th><td className="num">{fmtPrice(fixing, params.tick)}</td></tr>
                <tr><th scope="row">LONG payout, fixing - floor</th><td className="num">{fmtPrice(lp, params.tick)}</td></tr>
                <tr><th scope="row">SHORT payout, band - LONG payout</th><td className="num">{fmtPrice(sBand - lp, params.tick)}</td></tr>
                <tr><th scope="row">Buyer pays for compute</th><td className="num">{fmtPrice(buyer.unhedged, params.tick)}</td></tr>
                <tr className="ink"><th scope="row">Net: compute - payout + p = floor + p</th><td className="num">{fmtPrice(buyer.hedged, params.tick)}</td></tr>
                <tr><th scope="row">Paid out for {fmtInt(units)} units</th><td className="num">{fmtUsd(BigInt(units) * BigInt(lp))}</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className="how-section" id="funding">
          <div className="text">
            <h2>
              5. Funding from another chain <span className="tag flag">{f.tag === "recorded" ? "recorded" : "quotes only"}</span>
            </h2>
            <p>Weir holds USDC on NEAR. USDC on Base, Arbitrum, Ethereum or Solana can be moved to a NEAR account through NEAR Intents, where solvers quote a price and deliver the token. From there one <code>ft_transfer_call</code> deposits it into Weir, crediting the account named in its message.</p>
            <p>
              {f.tag === "recorded" ? (
                <>One such transfer is on record: <span className="mono">{shortHash(f.tx.hash, 6, 4)}</span>.</>
              ) : (
                <>Status: quotes only. No cross-chain transfer into Weir is on record in <code>evidence/</code> yet, so this path is described, not shown working.</>
              )}
            </p>
          </div>
          <div className="stack">
            <FundingDrawing recorded={f.tag === "recorded"} />
            {intents ? <QuoteWidget /> : <p className="small muted">Live quotes are not wired in this build: the quote module (chain/src/intents.ts) is not in the repository yet.</p>}
          </div>
        </section>

        <section className="section" id="limits" aria-labelledby="limits-h">
          <h2 id="limits-h">Limits</h2>
          <p className="lead">One fact per line, with the parameter that sets it. {paramsNote}</p>
          <LimitsList params={params} network={deployments().network} />
          <ul className="limits">
            <li><span>Prices move in steps of {fmtPrice(params.tick, params.tick)}.</span><code>tick</code></li>
            <li><span>A series can only open on a print at most {fmtSpan(params.max_anchor_age_secs)} old.</span><code>max_anchor_age_secs</code></li>
            <li><span>A print more than {fmtBps(params.max_move_bps)} from the last one needs every reporter.</span><code>max_move_bps</code></li>
            <li><span>A round holds at most {fmtInt(params.max_commits)} commits; when full, a larger lock evicts the smallest.</span><code>max_commits</code></li>
            <li><span>One order is at most {fmtGpuH(params.max_order_size)}.</span><code>max_order_size</code></li>
            <li><span>A commit locks at least {fmtUsd(params.min_lock)}.</span><code>min_lock</code></li>
            <li><span>A normal settlement needs {fmtInt(params.min_prints)} prints; after {fmtSpan(params.void_after_secs)} it settles void without them.</span><code>min_prints, void_after_secs</code></li>
            <li><span>A function-call key cannot set a guard, withdraw or move positions: those need 1 yoctoNEAR.</span><code>set_guard, withdraw</code></li>
          </ul>
        </section>

        <section className="section" id="trust" aria-labelledby="trust-h">
          <h2 id="trust-h">Trust</h2>
          <ul className="limits">
            <li><span>Reporters set the index: a print is the median of their reports. They cannot take funds; they can move the fixing. Every report carries the hash of its data, so anyone can recompute it on <Link href="/proof#verifier">Proof</Link>.</span><code>reporters</code></li>
            <li><span>The contract trusts the USDC token contract named in its parameters{live ? `: ${live.usdc}` : ""}.</span><code>usdc</code></li>
            <li><span>There is no owner, pause, fee switch or upgrade method. Once the contract account has no keys, its code cannot change. Proof reads the key count live.</span><code>no admin</code></li>
            <li><span>An agent with a function-call key limited to commit, reveal, clear, mint, merge and redeem trades only with dollars already deposited for it.</span><code>agents</code></li>
          </ul>
        </section>
      </div>
    </main>
  );
}

function FundingDrawing({ recorded }: { recorded: boolean }) {
  const chains = ["Base", "Arbitrum", "Ethereum", "Solana"];
  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox="0 0 560 200" width="100%" role="img" aria-labelledby="funding-title" style={{ maxWidth: 560, display: "block" }}>
        <title id="funding-title">USDC on Base, Arbitrum, Ethereum or Solana goes through NEAR Intents to USDC on a NEAR account, then ft_transfer_call deposits it into Weir.</title>
        {chains.map((c, i) => (
          <g key={c}>
            <rect x={4} y={8 + i * 46} width={112} height={34} rx={4} fill="var(--panel)" stroke="var(--rule)" />
            <text x={60} y={30 + i * 46} textAnchor="middle" style={{ fontSize: 13, fill: "var(--ink)" }}>USDC, {c}</text>
            <path d={`M116,${25 + i * 46} C150,${25 + i * 46} 150,100 182,100`} fill="none" stroke="var(--ink-3)" />
          </g>
        ))}
        <rect x={182} y={78} width={112} height={44} rx={4} fill="none" stroke="var(--ink)" strokeDasharray={recorded ? undefined : "4 3"} />
        <text x={238} y={98} textAnchor="middle" style={{ fontSize: 13, fill: "var(--ink)", fontWeight: 650 }}>NEAR Intents</text>
        <text x={238} y={114} textAnchor="middle" style={{ fontSize: 11, fill: "var(--ink-2)" }}>solver quote</text>
        <path d="M294,100 H330" stroke="var(--ink)" markerEnd="url(#arr)" />
        <rect x={330} y={78} width={104} height={44} rx={4} fill="var(--panel)" stroke="var(--ink)" />
        <text x={382} y={98} textAnchor="middle" style={{ fontSize: 13, fill: "var(--ink)" }}>USDC on NEAR</text>
        <text x={382} y={114} textAnchor="middle" style={{ fontSize: 11, fill: "var(--ink-2)" }}>your account</text>
        <path d="M434,100 H462" stroke="var(--ink)" markerEnd="url(#arr)" />
        <rect x={462} y={78} width={94} height={44} rx={4} fill="var(--ink)" />
        <text x={509} y={98} textAnchor="middle" style={{ fontSize: 13, fill: "var(--paper)", fontWeight: 650 }}>Weir</text>
        <text x={509} y={114} textAnchor="middle" style={{ fontSize: 11, fill: "var(--paper)" }}>free balance</text>
        <text x={448} y={146} textAnchor="middle" style={{ fontSize: 11, fill: "var(--ink-2)" }}>ft_transfer_call</text>
        <defs>
          <marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto">
            <path d="M0,0 L8,4 L0,8 Z" fill="var(--ink)" />
          </marker>
        </defs>
      </svg>
      <figcaption className="tiny muted">{recorded ? "A transfer along this path is on record." : "Dashed: the step with no recorded transfer yet."}</figcaption>
    </figure>
  );
}
