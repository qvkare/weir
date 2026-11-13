import type { Metadata } from "next";
import { BacktestChart } from "@/components/backtest-chart.tsx";
import { buildData } from "@/lib/build.ts";
import { caveatsFromMarkdown, coverage, readBacktest, type BacktestWeek } from "@/lib/backtest.ts";
import { fmtBps, fmtInt, fmtUtc } from "@/lib/format.ts";

export const dynamic = "force-static";
export const metadata: Metadata = { title: "Backtest", description: "Hedged against unhedged H100 cost over real price history, week by week, with band coverage and what the backtest does not show." };

function usd(v: number | null | undefined, d = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "no data";
  const r = Number(v.toFixed(d));
  if (r === 0) return "none";
  return `${r < 0 ? "-" : ""}$${Math.abs(r).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}
const pct = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "no data");
const get = (o: unknown, ...path: string[]): unknown => path.reduce<unknown>((a, k) => (a && typeof a === "object" ? (a as Record<string, unknown>)[k] : undefined), o);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export default function BacktestPage() {
  const raw = buildData().backtest;
  const bt = readBacktest(raw.site, raw.summary);
  if (!bt || bt.weeks.length === 0) {
    return (
      <main id="main" className="doc">
        <div className="wrap">
          <header className="page-head">
            <span className="eyebrow">Backtest</span>
            <h1>What a hedge would have done</h1>
          </header>
          <section className="section">
            <div className="state error" role="alert">
              <p>
                <b>Backtest results missing.</b> {raw.siteMissing ? "The backtest's results were not available when this page was published." : `The backtest's results held no usable week${bt ? ` (${bt.dropped} rows without every figure were left out)` : ""}.`} Nothing is drawn rather than an empty chart.
              </p>
            </div>
          </section>
        </div>
      </main>
    );
  }
  const s = bt.summary;
  const cov = coverage(bt.weeks);
  const bandBps = num(bt.meta.band_bps) ?? num(get(s, "recommendation", "band_bps"));
  const hours = num(bt.meta.hours_per_week) ?? num(get(s, "parameters", "hoursPerWeek"));
  const first = bt.weeks[0]!;
  const last = bt.weeks[bt.weeks.length - 1]!;
  const neutral = get(s, "hedge_neutral", "buyer");
  const covRows = Array.isArray(get(s, "coverage")) ? (get(s, "coverage") as Record<string, unknown>[]) : [];
  const sens = Array.isArray(get(s, "sensitivity")) ? (get(s, "sensitivity") as Record<string, unknown>[]) : [];
  const excluded = Array.isArray(get(s, "weeks", "excluded")) ? (get(s, "weeks", "excluded") as { week: string; reason: string }[]) : [];
  const caveats = caveatsFromMarkdown(raw.summaryMd);
  const outside = bt.weeks.filter((w) => !w.inside);
  const summary = `${cov.weeks} delivery weeks from ${first.label} to ${last.label}. The week's average stayed inside the band in ${cov.inside} of ${cov.weeks}. Across all weeks, hedged minus unhedged sums to ${usd(cov.totalDiff, 3)} per GPU-hour.`;

  return (
    <main id="main" className="doc">
      <div className="wrap">
        <header className="page-head">
          <span className="eyebrow">Backtest · modelled clearing prices</span>
          <h1>What a hedge would have done</h1>
          <p className="sub">{cov.weeks} weeks of H100 prices, hedged and unhedged. Clearing prices are modelled; the rule is set out below the chart.</p>
        </header>

        <section className="section" aria-label="The figures that matter">
          <div className="figures">
            <Fig label="Weeks whose average stayed inside the band" value={`${cov.inside} of ${cov.weeks}`} />
            <Fig label="Surprise per week, unhedged → hedged (std dev)" value={`${usd(num(get(neutral, "sd_of_surprise", "unhedged")))} → ${usd(num(get(neutral, "sd_of_surprise", "hedged")))}`} />
            <Fig label="Surprise variance removed" value={pct(get(neutral, "surprise_variance_removed"))} />
          </div>
          <p className="small muted">A buyer of {hours ? fmtInt(hours) : "no data"} GPU-hours a week, {first.label} to {last.label}, at a clearing price equal to the anchor (modelled; nobody traded these weeks).</p>
        </section>

        <section className="section" aria-labelledby="chart-h">
          <div className="section-head">
            <h2 id="chart-h">Hedged and unhedged, per GPU-hour, week by week</h2>
            <span className="note">band_bps {bandBps ?? "no data"}, clearing at the anchor (modelled)</span>
          </div>
          <BacktestChart weeks={bt.weeks} summary={summary} />
          <div className="legend" aria-hidden="true">
            <span className="key">
              <span className="swatch box" style={{ color: "var(--panel)" }} /> Band, floor to cap
            </span>
            <span className="key">
              <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: 4, background: "var(--ink)" }} /> Unhedged: the week&rsquo;s average
            </span>
            <span className="key long">
              <span className="swatch" /> Hedged: fixing - LONG payout + p
            </span>
            <span className="key flag">
              <span style={{ display: "inline-block", width: 0, height: 0, borderLeft: "5px solid transparent", borderRight: "5px solid transparent", borderBottom: "8px solid currentColor" }} /> Average outside the band
            </span>
          </div>
          <CoverageStrip weeks={bt.weeks} />
        </section>

        <section className="section" aria-labelledby="effect-h">
          <h2 id="effect-h" style={{ fontSize: "var(--t24)", marginBottom: 16 }}>
            What hedging changed, for a buyer of {hours ? fmtInt(hours) : "no data"} GPU-hours a week
          </h2>
          <div className="figures">
            <Fig label="Std dev of the surprise, unhedged" value={usd(num(get(neutral, "sd_of_surprise", "unhedged")))} unit="/week" />
            <Fig label="Std dev of the surprise, hedged" value={usd(num(get(neutral, "sd_of_surprise", "hedged")))} unit="/week" />
            <Fig label="Surprise variance removed" value={pct(get(neutral, "surprise_variance_removed"))} />
            <Fig label="Hedged minus unhedged, whole sample" value={usd(num(get(neutral, "hedge_cost_total")))} />
            <Fig label="Dollars locked per week, mean" value={usd(num(get(neutral, "locked_per_week", "mean")))} />
          </div>
          <p className="small muted">The surprise is the part of a week&rsquo;s bill not known when the auction opened. All figures are modelled at a clearing price equal to the anchor; the sensitivity table below moves it.</p>
          {outside.length ? (
            <p className="small" style={{ marginTop: 12 }}>
              <span className="flag">Not covered:</span> {outside.map((w) => `${w.label} (average ${usd(w.fixing, 3)}, band ${usd(w.floor, 3)} to ${usd(w.cap, 3)})`).join("; ")}. Above the cap the buyer paid the market again.
            </p>
          ) : null}
        </section>

        <section className="section" aria-labelledby="rule-h">
          <h2 id="rule-h" style={{ fontSize: "var(--t24)", marginBottom: 16 }}>
            The rule
          </h2>
          <dl className="kv">
            <dt>Index</dt>
            <dd>{str(bt.meta.underlying) ?? "no data"}</dd>
            <dt>Data</dt>
            <dd>
              {str(get(s, "data", "first_index_day")) ?? "no data"} to {str(get(s, "data", "last_index_day")) ?? "no data"}; {fmtInt(num(get(s, "data", "days_with_index")))} days with an index value, {fmtInt(num(get(s, "data", "days_without_index")))} without (never filled)
            </dd>
            <dt>Weeks</dt>
            <dd>
              {fmtInt(num(get(s, "weeks", "kept")) ?? cov.weeks)} kept of {fmtInt(num(get(s, "weeks", "candidate_mondays")))} candidate Mondays; {excluded.length} dropped ({countBy(excluded.map((e) => e.reason.replace("_", " ")))})
            </dd>
            <dt>Band</dt>
            <dd>
              band_bps {bandBps ?? "no data"}{bandBps ? ` (${fmtBps(bandBps)} of the anchor each way)` : ""}. {str(get(s, "parameters", "band_rule"))}
            </dd>
            <dt>LONG price p</dt>
            <dd>{str(get(s, "parameters", "neutral_price")) ?? str(bt.meta.note) ?? "no data"}. This is modelled: nobody traded these weeks.</dd>
            <dt>Cost</dt>
            <dd>
              {str(get(s, "parameters", "cost_rule"))}
              {hours ? ` Usage: ${fmtInt(hours)} GPU-hours a week.` : ""}
            </dd>
            <dt>Not modelled</dt>
            <dd>
              {caveats.length ? caveats.map((c) => c.title.toLowerCase()).join("; ") : "see the caveats below"}. <a href="#caveats">Caveats in full</a>
            </dd>
          </dl>
        </section>


        {covRows.length ? (
          <section className="section" aria-labelledby="cov-h">
            <h2 id="cov-h" style={{ fontSize: "var(--t24)", marginBottom: 16 }}>
              Coverage by band width
            </h2>
            <div className="table-wrap">
              <table>
                <caption>Share of weeks whose average stayed inside the band, with a 95% Wilson interval</caption>
                <thead>
                  <tr>
                    <th scope="col">band_bps</th>
                    <th scope="col" className="num">Inside</th>
                    <th scope="col" className="num">Above cap</th>
                    <th scope="col" className="num">Below floor</th>
                    <th scope="col" className="num">Share</th>
                    <th scope="col" className="num collapse-sm">95% interval</th>
                  </tr>
                </thead>
                <tbody>
                  {covRows.map((r) => {
                    const w = get(r, "share_inside_wilson95");
                    return (
                      <tr key={String(r.band_bps)} className={r.band_bps === bandBps ? "ink" : undefined}>
                        <td>
                          {String(r.band_bps)} ({fmtBps(num(r.band_bps))})
                        </td>
                        <td className="num">
                          {fmtInt(num(r.inside))} of {fmtInt(num(r.weeks))}
                        </td>
                        <td className="num">{fmtInt(num(r.above_cap))}</td>
                        <td className="num">{fmtInt(num(r.below_floor))}</td>
                        <td className="num">{pct(r.share_inside)}</td>
                        <td className="num collapse-sm">{Array.isArray(w) ? `${pct(w[0])} to ${pct(w[1])}` : "no data"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        {sens.length ? (
          <section className="section" aria-labelledby="sens-h">
            <h2 id="sens-h" style={{ fontSize: "var(--t24)", marginBottom: 16 }}>
              If the auction had cleared elsewhere
            </h2>
            <div className="table-wrap">
              <table>
                <caption>Forward price set at the anchor times (1 + shift). Positive: buyers paid up to hedge.</caption>
                <thead>
                  <tr>
                    <th scope="col">Forward vs anchor</th>
                    <th scope="col" className="num">Buyer hedged total</th>
                    <th scope="col" className="num">Hedged minus unhedged</th>
                    <th scope="col" className="num collapse-sm">Surprise sd, hedged</th>
                  </tr>
                </thead>
                <tbody>
                  {sens.map((r) => {
                    const shift = num(r.forward_shift);
                    const hedgedTotal = num(get(r, "buyer", "hedged_weekly_cost", "total"));
                    const unhedgedTotal = num(get(r, "buyer", "unhedged_weekly_cost", "total"));
                    return (
                      <tr key={String(shift)}>
                        <td>{shift === null ? "no data" : `${shift > 0 ? "+" : ""}${(shift * 100).toFixed(1)}%`}</td>
                        <td className="num">{usd(hedgedTotal)}</td>
                        <td className="num">{hedgedTotal !== null && unhedgedTotal !== null ? usd(hedgedTotal - unhedgedTotal) : "no data"}</td>
                        <td className="num collapse-sm">{usd(num(get(r, "buyer", "sd_of_surprise", "hedged")))}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        <section className="section" aria-labelledby="weeks-h">
          <h2 id="weeks-h" style={{ fontSize: "var(--t24)", marginBottom: 16 }}>
            Every week
          </h2>
          <BacktestTable weeks={bt.weeks} />
        </section>

        <section className="section" id="caveats" aria-labelledby="cav-h">
          <h2 id="cav-h" style={{ fontSize: "var(--t24)", marginBottom: 16 }}>
            What this does not show
          </h2>
          {caveats.length ? (
            <ul className="limits">
              {caveats.map((c) => (
                <li key={c.title} style={{ display: "block" }}>
                  <b>{c.title}.</b> {c.text}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">The backtest's own list of caveats was not available when this page was published. The clearing prices above are modelled.</p>
          )}
          <p className="tiny muted" style={{ marginTop: 16 }}>
            Figures from Weir&rsquo;s backtest of its own index on public provider prices, as of {fmtUtc(buildData().builtAt)}, when this page was published; the rule is set out above. {bt.dropped ? `${bt.dropped} rows without every figure were left out.` : ""}
          </p>
        </section>
      </div>
    </main>
  );
}

function Fig({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="figure">
      <span className="label">{label}</span>
      <span className="value">
        {value}
        {unit && value !== "no data" ? <span className="unit">{unit}</span> : null}
      </span>
      <span className="source">Modelled</span>
    </div>
  );
}

function countBy(list: string[]): string {
  const m = new Map<string, number>();
  for (const x of list) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m].map(([k, v]) => `${v} ${k}`).join(", ") || "none";
}

function CoverageStrip({ weeks }: { weeks: BacktestWeek[] }) {
  const inside = weeks.filter((w) => w.inside).length;
  return (
    <div style={{ marginTop: 24 }}>
      <p style={{ fontWeight: 650 }}>
        Average stayed inside the band in {inside} of {weeks.length} weeks
      </p>
      <div role="img" aria-label={`Coverage strip: ${inside} weeks inside the band, ${weeks.length - inside} outside.`} style={{ display: "flex", gap: 2, marginTop: 8, flexWrap: "wrap" }}>
        {weeks.map((w) => (
          <span key={w.start} title={`${w.label}: ${w.inside ? "inside" : "outside"}`} style={{ width: 10, height: 18, background: w.inside ? "var(--ink-3)" : "var(--flag)", borderRadius: 1 }} />
        ))}
      </div>
    </div>
  );
}

function BacktestTable({ weeks }: { weeks: BacktestWeek[] }) {
  return (
    <details className="data" open={false}>
      <summary>Table of {weeks.length} weeks</summary>
      <div className="table-wrap">
        <table>
          <caption>USD per GPU-hour. Hedged is modelled at a clearing price equal to the anchor.</caption>
          <thead>
            <tr>
              <th scope="col">Week</th>
              <th scope="col" className="num collapse-sm">Anchor</th>
              <th scope="col" className="num collapse-sm">Floor</th>
              <th scope="col" className="num collapse-sm">Cap</th>
              <th scope="col" className="num">Average</th>
              <th scope="col" className="num">Hedged</th>
              <th scope="col" className="num">Diff</th>
              <th scope="col">Band</th>
            </tr>
          </thead>
          <tbody>
            {weeks.map((w) => (
              <tr key={w.start}>
                <td>{w.label}</td>
                <td className="num collapse-sm">{usd(w.anchor, 3)}</td>
                <td className="num collapse-sm">{usd(w.floor, 3)}</td>
                <td className="num collapse-sm">{usd(w.cap, 3)}</td>
                <td className="num">{usd(w.unhedged, 3)}</td>
                <td className="num">{usd(w.hedged, 3)}</td>
                <td className="num">{usd(w.hedged - w.unhedged, 3)}</td>
                <td>{w.inside ? "inside" : <span className="flag">outside</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
