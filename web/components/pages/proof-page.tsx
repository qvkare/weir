import type { WireParams } from "@weir/engine";
import { ExtLink } from "@/components/ext-link.tsx";
import { Empty, Stale } from "@/components/state.tsx";
import { In } from "@/components/markdown-doc.tsx";
import { integrationFigures, residualRisks, type RiskItem } from "@/lib/audit.ts";
import { auditHref, CLOSED, HISTORY, OPEN, PASSES, SOUND_TESTS, specHref, STATED, VERDICT, type Finding } from "@/lib/audit.ts";
import { buildData, deployments, sourceKind } from "@/lib/build.ts";
import { MARKET_IDS, txUrl, type MarketId } from "@/lib/config.ts";
import { type ContractRow } from "@/lib/data/proof.ts";
import { stepGroups } from "@/lib/evidence.ts";
import { fmtBps, fmtGpuH, fmtInt, fmtPrice, fmtSpan, fmtUsd, fmtUtc, shortHash } from "@/lib/format.ts";
import { roundsOf } from "@/lib/load.ts";
import { inline } from "@/lib/markdown.ts";
import { MODEL_WIRE, modelContract } from "@/lib/model.ts";
import type { SourceKind } from "@/lib/source-types.ts";

export function contractRows(): ContractRow[] {
  const d = deployments();
  const rows: ContractRow[] = [];
  for (const id of MARKET_IDS) {
    const kind = sourceKind(id);
    if (kind === "model") rows.push({ market: id, account: modelContract(id), role: "Weir contract (model)", kind });
    if (kind === "chain") {
      const m = d.markets.find((x) => x.id === id)!;
      rows.push({ market: id, account: m.contract, role: "Weir contract", kind });
      for (const a of m.accounts) rows.push({ market: id, account: a.account, role: a.role, kind });
    }
  }
  return rows;
}

export function Audited({ market, params, kind }: { market: MarketId; params: WireParams | null; kind: SourceKind }) {
  const p = params ?? MODEL_WIRE[market];
  const live = !!params;
  const perRound = BigInt(p.max_commits) * BigInt(p.commit_fee);
  const rounds = roundsOf(p, 1);
  // The record's numbers are at the weekly preset; this line recomputes the blocking cost from
  // the parameters of the market on screen (get_params, or the preset when none answers).
  const here: Record<string, string> = {
    "2.3": `At ${live ? `this market's parameters${kind === "model" ? " (model)" : ""}` : "the preset's parameters"}: ${fmtInt(p.max_commits)} slots × ${fmtUsd(p.commit_fee)} = ${fmtUsd(perRound)} a round, ${fmtUsd(perRound * BigInt(rounds))} for all ${fmtInt(rounds)} rounds of a series.`,
  };
  const Sections = ({ list }: { list: string[] }) => (
    <>
      {list.map((s, i) => (
        <span key={s}>
          {i ? ", " : ""}
          <a href={specHref(s)}>{s}</a>
        </span>
      ))}
    </>
  );
  const Tests = ({ f }: { f: Finding }) => (f.tests.length ? <>{f.tests.map((t) => <code key={t} style={{ display: "block", overflowWrap: "anywhere" }}>{t}</code>)}</> : <span className="muted">{f.byReading ? "none: found by reading, not tested" : "none"}</span>);
  const table = (rows: Finding[], caption: string, statusHead: string) => (
    <div className="table-wrap">
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Finding</th>
            <th scope="col">{statusHead}</th>
            <th scope="col" className="collapse-sm">Spec</th>
            <th scope="col" className="collapse-sm">Test</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => (
            <tr key={`${f.id}-${f.finding}`}>
              <td className="mono">
                {f.id}
                <div className={`tiny ${f.state === "Closed" ? "muted" : "flag"}`}>{f.severity}</div>
              </td>
              <td>{f.finding}</td>
              <td>
                {f.state === "Partly closed" ? <span className="tag flag">Partly closed</span> : null} {f.status}
                {f.shows ? <div className="tiny muted">The test shows {f.shows}.</div> : null}
                {here[f.id] ? <div className="tiny"><b>{here[f.id]}</b></div> : null}
                <div className="only-sm tiny muted">
                  SPEC <Sections list={f.sections} /> · <Tests f={f} />
                </div>
              </td>
              <td className="collapse-sm mono"><Sections list={f.sections} /></td>
              <td className="collapse-sm mono tiny"><Tests f={f} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  return (
    <div className="stack">
      <p className="lead" style={{ marginBottom: 0 }}>
        An AI reviewer reviewed the contract in {PASSES} passes, against specifications 0.3, 0.4, 0.5 and 0.6. Every pass found the dollar accounting exact. Below are its findings as the final record states them (the review record, &ldquo;Every finding, status under 0.6&rdquo;): closed by a rule, open, and open but stated by the specification as limits it accepts. Numbers are at the deployed weekly preset. The full record is <a href={auditHref()}>here</a>.
      </p>
      <div className="board">
        <b className="eyebrow">Verdict, from the record</b>
        <ul>
          <li><span aria-hidden="true">·</span><span>{VERDICT.testnet}</span></li>
          <li><span aria-hidden="true">·</span><span className="flag">{VERDICT.real}</span></li>
          <li><span aria-hidden="true">·</span><span>{VERDICT.history}</span></li>
        </ul>
      </div>

      <Residual />

      <div data-findings="open" className="stack">
        <h3>Open</h3>
        {table(OPEN, "The weakness exists in the deployed contract today. A limit_ test passing means the weakness happens.", "What remains, with its number")}
      </div>

      <div data-findings="stated" className="stack">
        <h3>Open, stated as limits in the specification</h3>
        {table(STATED, "The specification states these and accepts them. Each test shows what is possible.", "What remains, with its number")}
      </div>

      <div data-findings="closed" className="stack">
        <h3>Closed by a rule</h3>
        {table(CLOSED, "Each audit test keeps the reviewer's attack and asserts that it now fails.", "Rule that closes it")}
      </div>
      <p className="small muted">
        Also examined and found sound, by reading: the dollar accounting on every path in all four passes, including the 0.6 void path; clearing; the commit hash; access controls; and that a pruned bucket cannot come back (<code>{SOUND_TESTS.join(", ")}</code>). The list is in the record.
      </p>

      <h3>A fix that was itself found faulty</h3>
      <div className="table-wrap">
        <table>
          <caption>The record&rsquo;s history, one pass at a time.</caption>
          <thead>
            <tr>
              <th scope="col">Pass</th>
              <th scope="col">Spec</th>
              <th scope="col">What it found</th>
            </tr>
          </thead>
          <tbody>
            {HISTORY.map((h) => (
              <tr key={h.pass}>
                <td className="mono">{h.pass}</td>
                <td className="mono">{h.spec}</td>
                <td>{h.found}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="board">
        <b className="eyebrow">Who reviewed it, and what it was not</b>
        <ul>
          <li><span aria-hidden="true">·</span><span>An AI reviewer (Claude, an Anthropic model) that did not write the contract. It is not an audit by a security firm and not a formal verification; no person has signed it off. This page makes no claim that the contract is secure.</span></li>
          <li><span aria-hidden="true">·</span><span>In scope: the Weir contract, against the specification. Out of scope: the TypeScript packages and this site, the reporters&rsquo; code and data sources, any real token, NEAR beyond what near-sdk 5.30.1 documents, the behaviour of real participants, deployment and key management.</span></li>
          <li><span aria-hidden="true">·</span><span>The reviewer&rsquo;s tests run in near-sdk&rsquo;s mocked VM; the real wasm was not run for the review, and gas was measured only for <code>clear</code>. A finding that is absent means only that it was not found.</span></li>
        </ul>
      </div>
    </div>
  );
}

/** The record's residual risks, read from docs/AUDIT.md at build and shown in its own words. */
export function Residual() {
  const r = residualRisks(buildData().audit);
  if (!r) return <Stale>The record&rsquo;s list of residual risks is not available in this version of the page. Read it in the <a href="/audit">review record</a>.</Stale>;
  const Item = ({ it }: { it: RiskItem }) => (
    <li>
      <In v={inline(it.text)} />
      {it.children.length ? (
        <ul>
          {it.children.map((c, i) => (
            <Item key={i} it={c} />
          ))}
        </ul>
      ) : null}
    </li>
  );
  return (
    <div className="risks" role="note" aria-labelledby="risks-h">
      <h3 id="risks-h">What you are trusting today</h3>
      <p className="small">
        The record&rsquo;s &ldquo;{r.heading}&rdquo;, as written in the <a href={auditHref()}>review record</a>. Its verdict makes this testnet fit only with these stated where users read them.
      </p>
      <ul className="risk-list">
        {r.items.map((it, i) => (
          <Item key={i} it={it} />
        ))}
      </ul>
    </div>
  );
}

/** The authors' sandbox comparison of the contract and the engine, figures read from integration/RESULTS.md. */
export function SandboxLine() {
  const f = integrationFigures(buildData().integration);
  if (!f || !f.checks || !f.stateChanges || !f.views || !f.refusals) return <p className="small muted">The sandbox comparison is not available in this version of the page.</p>;
  return (
    <p className="small">
      {f.run ? `${f.run} run` : "Latest run"}{f.spec ? `, on specification ${f.spec}` : ""}{f.date ? `, ${f.date}` : ""}: {f.checks} checks passed. The contract&rsquo;s wasm and the TypeScript model agreed on {f.stateChanges} state changes, {f.views} views and {f.refusals} refusals. It ran on one local near-sandbox node{f.node ? ` (${f.node})` : ""}, not on a public network, so it says nothing about latency, RPC limits, the real USDC or live index sources. The authors ran it, not the reviewer.
    </p>
  );
}

export function ParamsTable({ p }: { p: WireParams }) {
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
    ["quorum", `${p.quorum} of ${p.reporters.length} (must be a majority)`],
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

export function Transactions() {
  const d = deployments();
  const all = buildData().txs;
  const groups = stepGroups(all);
  if (groups.length === 0) return <Empty>No transactions are recorded yet. When a run is recorded, each one is listed here by what it did, with failures kept.</Empty>;
  const total = groups.reduce((n, g) => n + g.txs.length, 0);
  const checked = all.some((t) => t.ok !== null);
  return (
    <div className="stack">
      <p className="small">
        {fmtInt(total)} transactions in the deployment record, grouped by what they did. Recorded by the deploy tool; not re-checked here. Each hash opens in the explorer, which shows whether it landed.
      </p>
      <div className="tx-groups">
        {groups.map((g) => (
          <details key={g.kind} className="tx-group">
            <summary>
              <span>{g.label}</span> <span className="tx-count mono muted">{fmtInt(g.txs.length)}</span>
            </summary>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Transaction</th>
                    <th scope="col">What it did</th>
                    <th scope="col" className="collapse-sm">Time</th>
                    {checked ? <th scope="col">Result</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {g.txs.map((t) => {
                    const url = t.explorer ?? txUrl(d.explorer, t.hash);
                    return (
                      <tr key={t.hash}>
                        <td className="mono">{url ? <ExtLink href={url}>{shortHash(t.hash, 6, 4)}</ExtLink> : shortHash(t.hash, 6, 4)}</td>
                        <td style={{ overflowWrap: "anywhere" }}>{t.note ?? t.method}</td>
                        <td className="collapse-sm">{t.at ? fmtUtc(t.at) : "no time recorded"}</td>
                        {checked ? <td>{t.ok === true ? <span className="ok">landed</span> : t.ok === false ? <span className="bad">failed</span> : <span className="muted">not recorded</span>}</td> : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}

export function RecordedNote({ recorded }: { recorded: { file: string; bucket: number | null } | null }) {
  if (!recorded) return <p className="small muted">No sample bundle is recorded yet.</p>;
  return (
    <p className="small" style={{ marginBottom: 12 }}>
      Recorded sample <code>{recorded.file}</code>
      {recorded.bucket ? `, bucket ${fmtUtc(recorded.bucket)}` : ""}: its name carries the start of its hash, which this browser recomputes below with the index method&rsquo;s checks. It is not tied to a print on chain.
    </p>
  );
}
