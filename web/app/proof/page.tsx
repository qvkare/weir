import type { Metadata } from "next";
import { Suspense } from "react";
import type { WireParams } from "@weir/engine";
import { BundleVerifier } from "@/components/bundle-verifier.tsx";
import { ExtLink } from "@/components/ext-link.tsx";
import { CheckIcon, CrossIcon } from "@/components/icons.tsx";
import { Empty, NotDeployed, RpcError, Skeleton } from "@/components/state.tsx";
import { buildData, deployments, sourceKind } from "@/lib/build.ts";
import { valueOf } from "@/lib/cache.ts";
import { accountUrl, marketFromParam, MARKET_IDS, MARKET_INFO, mq, txUrl, type MarketId } from "@/lib/config.ts";
import { groupTxs } from "@/lib/evidence.ts";
import { fmtBps, fmtGpuH, fmtInt, fmtPrice, fmtSpan, fmtUsd, fmtUsdOrNone, fmtUtc, shortHash } from "@/lib/format.ts";
import { loadCore, recordedBundle } from "@/lib/load.ts";
import { modelContract } from "@/lib/model.ts";
import { readAccount, readKeys, readTokenBalance } from "@/lib/source.ts";
import { totalsSum } from "@/lib/views.ts";
import { AUDIT_FINDINGS, AUDIT_TEST_FILE, specHref } from "@/lib/audit.ts";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Proof", description: "Contracts and their remaining keys, parameters, recorded transactions, bundle hashes re-checked in your browser, and a live solvency check." };

type Search = Promise<Record<string, string | string[] | undefined>>;

export default async function ProofPage({ searchParams }: { searchParams: Search }) {
  const market = marketFromParam((await searchParams).m);
  const d = deployments();
  return (
    <main id="main">
      <div className="wrap">
        <header className="page-head">
          <span className="eyebrow">Proof · NEAR {d.network}</span>
          <h1>Check every print yourself</h1>
          <p className="sub">Each report carries the hash of the data behind it. This page fetches the data and hashes it in your browser.</p>
        </header>

        <section className="section" id="contracts" aria-labelledby="contracts-h">
          <div className="section-head">
            <h2 id="contracts-h">Contracts</h2>
            <span className="note">Keys and code hash read live. A contract account with no keys cannot change its code.</span>
          </div>
          <Suspense fallback={<Skeleton lines={3} label="Reading accounts" />}>
            <Contracts />
          </Suspense>
        </section>

        <section className="section" id="audited" aria-labelledby="audited-h">
          <div className="section-head">
            <h2 id="audited-h">Audited</h2>
            <span className="note">Reviewed by an AI reviewer, not an audit firm</span>
          </div>
          <Audited />
        </section>

        <section className="section" id="solvency" aria-labelledby="solvency-h">
          <div className="section-head">
            <h2 id="solvency-h">Solvency, {MARKET_INFO[market].name} market</h2>
            <span className="note">get_totals against the contract&rsquo;s USDC balance, read on each visit</span>
          </div>
          <Suspense fallback={<Skeleton lines={5} label="Reading totals" />}>
            <Solvency market={market} />
          </Suspense>
        </section>

        <section className="section" id="verifier" aria-labelledby="verifier-h">
          <div className="section-head">
            <h2 id="verifier-h">Bundle verifier</h2>
            <span className="note">SHA-256 by SubtleCrypto in this browser</span>
          </div>
          <Suspense fallback={<Skeleton lines={4} label="Reading prints" />}>
            <Verifier market={market} />
          </Suspense>
        </section>

        <section className="section" id="params" aria-labelledby="params-h">
          <div className="section-head">
            <h2 id="params-h">Parameters, {MARKET_INFO[market].name} market</h2>
            <span className="note">get_params. Set once at deployment; there is no method to change them.</span>
          </div>
          <Suspense fallback={<Skeleton lines={6} label="Reading parameters" />}>
            <Params market={market} />
          </Suspense>
        </section>

        <section className="section" id="transactions" aria-labelledby="tx-h">
          <div className="section-head">
            <h2 id="tx-h">Transactions on record</h2>
            <span className="note">From evidence/ at build time. Failed ones stay on the list.</span>
          </div>
          <Transactions />
        </section>
      </div>
    </main>
  );
}

function Audited() {
  return (
    <div className="stack">
      <p className="lead" style={{ marginBottom: 0 }}>
        An independent review of the contract found the dollar accounting sound and eight weaknesses in the rules around it. Specification 0.4 closes each one, and each of the reviewer&rsquo;s demonstrations is kept as a test in <code>{AUDIT_TEST_FILE}</code> that now asserts the attack fails.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col" className="num">#</th>
              <th scope="col">Weakness found</th>
              <th scope="col">Rule that now closes it</th>
              <th scope="col" className="collapse-sm">Spec</th>
              <th scope="col" className="collapse-sm">Test that asserts it</th>
            </tr>
          </thead>
          <tbody>
            {AUDIT_FINDINGS.map((f) => (
              <tr key={f.n}>
                <td className="num">{f.n}</td>
                <td>{f.finding}</td>
                <td>
                  {f.rule}
                  <div className="only-sm tiny muted">
                    {f.sections.map((s, i) => (
                      <span key={s}>{i ? ", " : "SPEC "}<a href={specHref(s)}>{s}</a></span>
                    ))}{" "}
                    · <code>{f.test}</code>
                  </div>
                </td>
                <td className="collapse-sm mono">
                  {f.sections.map((s, i) => (
                    <span key={s}>
                      {i ? ", " : ""}
                      <a href={specHref(s)}>{s}</a>
                    </span>
                  ))}
                </td>
                <td className="collapse-sm mono tiny" style={{ overflowWrap: "anywhere" }}>{f.test}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="board">
        <b className="eyebrow">Who reviewed it, and what it did not cover</b>
        <ul>
          <li><span aria-hidden="true">·</span><span>The review was done by an AI reviewer that did not write the contract. It is not an audit by a security firm, and this page makes no claim that the contract is secure.</span></li>
          <li><span aria-hidden="true">·</span><span>It read the contract in <code>contracts/weir</code> against the specification. Outside it: the NEAR protocol and near-sdk, the USDC token contract, the reporters&rsquo; honesty and their index code, this site, the agents and the keeper.</span></li>
          <li><span aria-hidden="true">·</span><span>No market is deployed, so nothing was reviewed on a live chain; the eight demonstrations run in near-sdk&rsquo;s mocked VM.</span></li>
          <li><span aria-hidden="true">·</span><span>What the rules still allow is written in <a href="/spec#s15">SPEC 15, Trust</a>: a majority of reporters can set a fixing, and a bidder with capital can still block a round, at <code>commit_fee</code> per slot.</span></li>
        </ul>
      </div>
    </div>
  );
}

async function Contracts() {
  const d = deployments();
  const rows: { market: MarketId; account: string; role: string }[] = [];
  for (const id of MARKET_IDS) {
    const kind = sourceKind(id);
    if (kind === "model") rows.push({ market: id, account: modelContract(id), role: "Weir contract (model)" });
    if (kind === "chain") {
      const m = d.markets.find((x) => x.id === id)!;
      rows.push({ market: id, account: m.contract, role: "Weir contract" });
      for (const a of m.accounts) rows.push({ market: id, account: a.account, role: a.role });
    }
  }
  if (rows.length === 0) return <Empty>No market is deployed yet, so there are no contracts to list. deployments.json has an empty markets list.</Empty>;
  const data = await Promise.all(
    rows.map(async (r) => {
      const [keys, acct] = await Promise.all([readKeys(r.market, r.account), readAccount(r.market, r.account)]);
      return { ...r, keys, acct };
    }),
  );
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Market</th>
            <th scope="col">Account</th>
            <th scope="col" className="collapse-sm">Role</th>
            <th scope="col">Code hash</th>
            <th scope="col" className="num">Keys remaining</th>
          </tr>
        </thead>
        <tbody>
          {data.map((r) => {
            const keys = valueOf(r.keys);
            const full = keys?.filter((k) => k.permission === "FullAccess").length ?? 0;
            const url = sourceKind(r.market) === "chain" ? accountUrl(d.explorer, r.account) : null;
            const model = sourceKind(r.market) === "model";
            return (
              <tr key={`${r.market}-${r.account}`}>
                <td>{MARKET_INFO[r.market].name}</td>
                <td className="mono">{url ? <ExtLink href={url}>{r.account}</ExtLink> : r.account}</td>
                <td className="collapse-sm">{r.role}</td>
                <td className="mono">{model ? <span className="muted">model, no chain account</span> : valueOf(r.acct) ? shortHash(valueOf(r.acct)!.codeHash, 6, 4) : <span className="bad">read failed</span>}</td>
                <td className="num">
                  {model ? (
                    <span className="muted">model</span>
                  ) : keys ? (
                    keys.length === 0 ? (
                      <span className="ok"><CheckIcon /> 0, locked</span>
                    ) : (
                      <span className={r.role.startsWith("Weir") ? "flag" : undefined}>
                        {keys.length} ({full} full access)
                      </span>
                    )
                  ) : (
                    <span className="bad">read failed</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

async function Solvency({ market }: { market: MarketId }) {
  const core = await loadCore(market);
  if (core.src.kind === "none") return <NotDeployed market={market} what="balance" />;
  const params = valueOf(core.params);
  const totalsR = await core.src.view("get_totals", {});
  const totals = valueOf(totalsR);
  if (!params || !totals) return <RpcError read={!core.params.ok ? core.params : totalsR} href={`/proof${mq(market)}#solvency`} model={core.src.kind === "model"} />;
  const balanceR = await readTokenBalance(market, params.usdc, core.src.contract!);
  const balance = valueOf(balanceR);
  const sum = totalsSum(totals);
  const bal = balance !== null && /^\d+$/.test(balance) ? BigInt(balance) : null;
  // Burned dollars stay in the contract's token balance and belong to nobody, so the balance
  // must equal all five terms (SPEC 11, invariant 1); a surplus would be an unexplained deposit.
  const ok = sum !== null && bal !== null && bal >= sum;
  const model = core.src.kind === "model";
  const terms: [string, string, string][] = [
    ["Free balances", totals.free, "free"],
    ["Commit locks", totals.locked, "locked"],
    ["Open sets x band", totals.sets_backing, "sets_backing"],
    ["Not yet redeemed", totals.unredeemed, "unredeemed"],
    ["Burned: forfeits and commit fees, owned by nobody", totals.burned, "burned"],
  ];
  return (
    <div className="grid-2">
      <div className="table-wrap">
        <table>
          <caption>SPEC 11, invariant 1: the USDC held must cover these five terms. Burned dollars stay in the contract and are counted, so nobody can claim them.</caption>
          <tbody>
            {terms.map(([label, v, key]) => (
              <tr key={key}>
                <th scope="row">
                  {label} <code className="tiny muted">{key}</code>
                </th>
                <td className="num">{fmtUsdOrNone(v)}</td>
              </tr>
            ))}
            <tr className="ink">
              <th scope="row">Owed, total</th>
              <td className="num">{fmtUsd(sum)}</td>
            </tr>
            <tr>
              <th scope="row">{model ? "USDC deposited (model ledger)" : `USDC held (ft_balance_of on ${params.usdc})`}</th>
              <td className="num">{bal === null ? <span className="bad">read failed</span> : fmtUsd(bal)}</td>
            </tr>
            <tr>
              <th scope="row">Surplus</th>
              <td className="num">{bal !== null && sum !== null ? fmtUsdOrNone(bal - sum) : "no data"}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="stack">
        <p style={{ fontSize: "var(--t21)" }}>
          {bal === null || sum === null ? (
            <span className="flag">Unverified: the balance could not be read.</span>
          ) : ok ? (
            <span className="ok"><CheckIcon /> Covered.</span>
          ) : (
            <span className="bad"><CrossIcon /> Not covered.</span>
          )}
        </p>
        <p className="small muted">
          Read {fmtUtc(Math.floor((totalsR.ok ? totalsR.at : Date.now()) / 1000))}. {model ? "Model figures: the balance is the model's own count of deposits, not a token contract." : "Both reads come from the same RPC within a few seconds; a deposit landing between them can show as surplus."}
        </p>
        {!balanceR.ok ? <p className="tiny bad">{balanceR.error}</p> : null}
      </div>
    </div>
  );
}

async function Verifier({ market }: { market: MarketId }) {
  const core = await loadCore(market);
  const params = valueOf(core.params);
  const d = deployments();
  const rec = recordedBundle(MARKET_INFO[market].chip);
  const recorded = rec && rec.origin.kind === "recorded" ? { file: rec.origin.file, text: rec.text, bucket: rec.bundle.bucket } : null;
  if (core.src.kind === "none" || !params) {
    return (
      <>
        {core.src.kind === "none" ? <NotDeployed market={market} what="print to check" /> : <RpcError read={core.params} href="/proof#verifier" model={core.src.kind === "model"} />}
        <RecordedNote recorded={recorded} />
        {recorded ? (
          <div style={{ marginTop: 24 }}>
            <BundleVerifier prints={[]} bundlesBase={null} recorded={recorded} tick={0} model={false} />
          </div>
        ) : null}
      </>
    );
  }
  const last = valueOf(core.last);
  const from = last ? last.bucket - 4 * params.print_interval_secs : 0;
  const prints = last ? (valueOf(await core.src.view("get_prints", { from_bucket: from, limit: 5 })) ?? []) : [];
  const items = prints
    .filter((p) => p.price !== null)
    .reverse()
    .map((p) => ({ bucket: p.bucket, price: p.price!, reports: p.reports }));
  return (
    <>
      <RecordedNote recorded={recorded} />
      <BundleVerifier prints={items} bundlesBase={d.bundlesBase} recorded={recorded} tick={params.tick} model={core.src.kind === "model"} />
    </>
  );
}

async function Params({ market }: { market: MarketId }) {
  const core = await loadCore(market);
  if (core.src.kind === "none") return <NotDeployed market={market} what="parameter" />;
  const p = valueOf(core.params);
  if (!p) return <RpcError read={core.params} href="/proof#params" model={core.src.kind === "model"} />;
  return <ParamsTable p={p} />;
}

function ParamsTable({ p }: { p: WireParams }) {
  const rows: [keyof WireParams, string][] = [
    ["usdc", p.usdc],
    ["underlying", p.underlying],
    ["t0", `${fmtInt(p.t0)} (${fmtUtc(p.t0)})`],
    ["period_secs", fmtSpan(p.period_secs)],
    ["lead_secs", fmtSpan(p.lead_secs)],
    ["cutoff_secs", fmtSpan(p.cutoff_secs)],
    ["commit_secs", fmtSpan(p.commit_secs)],
    ["reveal_secs", fmtSpan(p.reveal_secs)],
    ["band_bps", `${fmtInt(p.band_bps)} (${fmtBps(p.band_bps)} each way)`],
    ["tick", fmtPrice(p.tick, p.tick)],
    ["print_interval_secs", fmtSpan(p.print_interval_secs)],
    ["report_grace_secs", fmtSpan(p.report_grace_secs)],
    ["max_spread_bps", `${fmtInt(p.max_spread_bps)} (${fmtBps(p.max_spread_bps)})`],
    ["min_prints", fmtInt(p.min_prints)],
    ["void_after_secs", fmtSpan(p.void_after_secs)],
    ["max_anchor_age_secs", fmtSpan(p.max_anchor_age_secs)],
    ["forfeit_bps", `${fmtInt(p.forfeit_bps)} (${fmtBps(p.forfeit_bps)})`],
    ["min_lock", fmtUsd(p.min_lock)],
    ["commit_fee", `${fmtUsd(p.commit_fee)}, burned per commit`],
    ["max_commits", fmtInt(p.max_commits)],
    ["max_order_size", fmtGpuH(p.max_order_size)],
    ["reporters", p.reporters.join(", ")],
    ["quorum", `${p.quorum} of ${p.reporters.length}`],
  ];
  return (
    <div className="table-wrap">
      <table>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <th scope="row" className="mono" style={{ fontWeight: 400 }}>
                {k}
              </th>
              <td style={{ overflowWrap: "anywhere" }}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Transactions() {
  const d = deployments();
  const groups = groupTxs(buildData().txs);
  if (groups.length === 0) return <Empty>No transactions are recorded in evidence/ yet. When a run is recorded there, each one is listed here by method, with failures kept.</Empty>;
  return (
    <div className="stack">
      {groups.map((g) => (
        <div className="table-wrap" key={g.group}>
          <table>
            <caption>
              {g.group} ({g.txs.length})
            </caption>
            <thead>
              <tr>
                <th scope="col">Transaction</th>
                <th scope="col">Method</th>
                <th scope="col" className="collapse-sm">Signer</th>
                <th scope="col">Time</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {g.txs.map((t) => {
                const url = txUrl(d.explorer, t.hash);
                return (
                  <tr key={t.hash}>
                    <td className="mono">{url ? <ExtLink href={url}>{shortHash(t.hash, 6, 4)}</ExtLink> : shortHash(t.hash, 6, 4)}</td>
                    <td>
                      {t.method}
                      {t.note ? <div className="tiny muted">{t.note}</div> : null}
                    </td>
                    <td className="mono collapse-sm">{t.signer ?? "no data"}</td>
                    <td>{fmtUtc(t.at)}</td>
                    <td>{t.ok === true ? <span className="ok">landed</span> : t.ok === false ? <span className="bad">failed</span> : <span className="flag">unknown</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function RecordedNote({ recorded }: { recorded: { file: string; bucket: number | null } | null }) {
  if (!recorded) return <p className="small muted">No bundle is recorded in evidence/bundles yet.</p>;
  return (
    <p className="small" style={{ marginBottom: 12 }}>
      Recorded sample <code>{recorded.file}</code>
      {recorded.bucket ? `, bucket ${fmtUtc(recorded.bucket)}` : ""}: its name carries the start of its hash, which this browser recomputes below with the index method&rsquo;s checks. It is not tied to a print on chain.
    </p>
  );
}
