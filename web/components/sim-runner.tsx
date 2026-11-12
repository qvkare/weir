"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MarketId } from "@/lib/config.ts";
import { fmtCountdown, fmtGpuH, fmtInt, fmtPrice, fmtUsd, fmtUsdOrNone, fmtUtc, fmtUtcTime, shortHash } from "@/lib/format.ts";
import type { LogLine, SimSnapshot } from "@/lib/sim-snapshot.ts";
import type { SimRequest } from "@/lib/sim-worker.ts";
import { bookRows, bookTotals, settlementLine, stepOrdersFromResult, summarize } from "@/lib/views.ts";
import { EyeIcon, LockIcon } from "./icons.tsx";
import { StepChart } from "./step-chart.tsx";

const SPEEDS = [1, 60, 3600] as const;
const TICK_MS = 500;

export function SimRunner({ market }: { market: MarketId }) {
  const worker = useRef<Worker | null>(null);
  const busy = useRef(false);
  const [seed, setSeed] = useState(7);
  const [seedText, setSeedText] = useState("7");
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(60);
  const [playing, setPlaying] = useState(false);
  const [snap, setSnap] = useState<SimSnapshot | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"agents" | "log">("agents");
  const [run, setRun] = useState(0);
  const [voidSeries, setVoidSeries] = useState(false);

  const send = useCallback((req: SimRequest) => {
    if (!worker.current || busy.current) return false;
    busy.current = true;
    worker.current.postMessage(req);
    return true;
  }, []);

  useEffect(() => {
    let w: Worker;
    try {
      w = new Worker(new URL("../lib/sim-worker.ts", import.meta.url), { type: "module" });
    } catch (e) {
      setError(`This browser could not start the simulation worker: ${(e as Error).message}`);
      return;
    }
    worker.current = w;
    w.onmessage = (e: MessageEvent) => {
      busy.current = false;
      const msg = e.data as { type: "state"; reset: boolean; events: LogLine[]; snapshot: SimSnapshot } | { type: "error"; message: string };
      if (msg.type === "error") {
        setError(msg.message);
        setPlaying(false);
        return;
      }
      setError(null);
      setSnap(msg.snapshot);
      setLog((prev) => (msg.reset ? msg.events : [...prev, ...msg.events].slice(-400)));
    };
    w.onerror = (e) => {
      busy.current = false;
      setError(`The simulation worker failed: ${e.message}`);
      setPlaying(false);
    };
    busy.current = true;
    w.postMessage({ type: "init", config: { seed, market, voidSeries } } satisfies SimRequest);
    return () => {
      w.terminate();
      worker.current = null;
      busy.current = false;
    };
  }, [seed, market, run, voidSeries]);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => send({ type: "step", seconds: (speed * TICK_MS) / 1000 }), TICK_MS);
    return () => clearInterval(id);
  }, [playing, speed, send]);

  const reset = () => {
    const n = Number(seedText);
    setPlaying(false);
    setLog([]);
    setSnap(null);
    if (seedText !== "" && Number.isSafeInteger(n)) setSeed(n);
    setRun((r) => r + 1);
  };

  const p = snap?.params;
  const live = snap?.live;
  const rows = bookRows(live?.book ?? null);
  const totals = bookTotals(rows);
  const last = snap?.last;
  const lastSummary = last ? summarize(last.result, last.info?.floor ?? null) : null;

  return (
    <div>
      <div className="controls" role="group" aria-label="Simulation controls">
        <button type="button" className="button" onClick={() => setPlaying((x) => !x)} disabled={!snap} aria-pressed={playing}>
          {playing ? "Pause" : "Play"}
        </button>
        <div className="field">
          <span className="label" id="speed-l">
            Speed
          </span>
          <div className="switch" role="group" aria-labelledby="speed-l">
            {SPEEDS.map((s) => (
              <button key={s} type="button" aria-pressed={speed === s} onClick={() => setSpeed(s)}>
                {s}x
              </button>
            ))}
          </div>
        </div>
        <button type="button" className="button ghost" onClick={() => send({ type: "skip" })} disabled={!snap}>
          Skip to clearing
        </button>
        <button type="button" className="button ghost" onClick={() => send({ type: "rounds", n: 10 })} disabled={!snap}>
          Run 10 rounds
        </button>
        <button type="button" className="button ghost" onClick={() => send({ type: "settle" })} disabled={!snap}>
          Settle and redeem
        </button>
        <div className="field" style={{ width: 96 }}>
          <label htmlFor="sim-seed">Seed</label>
          <input id="sim-seed" type="text" inputMode="numeric" value={seedText} onChange={(e) => setSeedText(e.target.value.replace(/\D/g, ""))} />
        </div>
        <button type="button" className="button ghost" onClick={reset}>
          Reset
        </button>
        <label className="check-control">
          <input type="checkbox" checked={voidSeries} onChange={(e) => setVoidSeries(e.target.checked)} />
          <span>
            Silent reporters (void series)
            <span className="tiny muted"> Reporters sit out series 0&rsquo;s delivery, so it is void: cancelled at the centre of the band, half the band to each side. Restarts the run.</span>
          </span>
        </label>
      </div>

      <div aria-live="polite" className="small" style={{ padding: "12px 0" }}>
        {error ? <p className="bad">{error}</p> : null}
        {snap && p ? (
          <p>
            Simulated time <b>{fmtUtc(snap.now)}</b>
            {live ? (
              <>
                {" "}· series {live.series}
                {live.round !== null ? `, round ${live.round}, ${live.phase.toLowerCase()} phase, ${fmtCountdown((live.phaseEndsAt ?? snap.now) - snap.now)} left` : ", between rounds"}
              </>
            ) : (
              " · no series in auction"
            )}
            {snap.lastPrint ? ` · index ${fmtPrice(snap.lastPrint.price, p.tick)} (simulated)` : ""}
          </p>
        ) : !error ? (
          <p className="muted">Starting the engine in this browser…</p>
        ) : null}
      </div>

      <div className="sim-grid">
        <div className="sim-side sim-roster" data-tab={tab}>
          <div className="tabs only-narrow" role="tablist" aria-label="Side panels">
            <button type="button" role="tab" aria-selected={tab === "agents"} onClick={() => setTab("agents")}>
              Agents
            </button>
            <button type="button" role="tab" aria-selected={tab === "log"} onClick={() => setTab("log")}>
              Event log
            </button>
          </div>
          <div className={tab === "agents" ? "" : "hide-narrow"}>
            <h2 style={{ fontSize: "var(--t18)", marginBottom: 8 }}>Agents</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Agent</th>
                    <th scope="col" className="num">
                      Free balance
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(snap?.agents ?? []).map((a) => (
                    <tr key={a.id}>
                      <td>
                        <span className="mono">{a.id}</span> <span className="tiny muted">{a.role}</span>
                        <div className="tiny muted">{a.rule}</div>
                      </td>
                      <td className="num">{fmtUsd(a.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="sim-centre stack">
          <h2 style={{ fontSize: "var(--t18)" }}>
            Sealed book{live && live.round !== null ? `, series ${live.series} round ${live.round}` : ""}
          </h2>
          {rows.length === 0 ? (
            <p className="small muted">No commits in the round in progress yet.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <caption>
                  {totals.commits} commits, {fmtUsd(totals.locked)} locked, {totals.revealed} revealed
                </caption>
                <thead>
                  <tr>
                    <th scope="col" className="num">
                      Seq
                    </th>
                    <th scope="col">Owner</th>
                    <th scope="col" className="collapse-sm">
                      Hash
                    </th>
                    <th scope="col">Side</th>
                    <th scope="col" className="num">
                      Size
                    </th>
                    <th scope="col" className="num">
                      Limit
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.seq} className={r.state === "Committed" ? undefined : "landed"}>
                      <td className="num">{r.seq}</td>
                      <td className="mono">{r.owner}</td>
                      <td className="mono collapse-sm">{r.hash ? shortHash(r.hash) : "no data"}</td>
                      <td>{r.side ? <span className={r.side === "Long" ? "side-long" : "side-short"}><EyeIcon /> {r.side === "Long" ? "LONG" : "SHORT"}</span> : <span className="lock-cell"><LockIcon /> sealed</span>}</td>
                      <td className="num">{r.size !== null ? fmtGpuH(r.size) : <span className="lock-cell"><LockIcon /></span>}</td>
                      <td className="num">{r.price !== null && p ? fmtPrice(r.price, p.tick) : <span className="lock-cell"><LockIcon /></span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h2 style={{ fontSize: "var(--t18)", marginTop: 24 }}>{last ? `Last clearing: series ${last.series}, round ${last.round}` : "Last clearing"}</h2>
          {last && last.info && p && lastSummary ? (
            <>
              <p className="small">
                {lastSummary.price === null ? "No trade: the curves did not cross." : `Cleared at ${fmtPrice(lastSummary.price, p.tick)} (forward ${fmtPrice(lastSummary.forward, p.tick)}) for ${fmtGpuH(lastSummary.volume)}.`} Simulated.
              </p>
              <StepChart key={`${last.series}-${last.round}`} orders={stepOrdersFromResult(last.result)} band={last.info.band} floor={last.info.floor} tick={p.tick} price={last.result.price} volume={last.result.volume} cleared animate height={300} />
            </>
          ) : (
            <p className="small muted">No round has cleared yet. Press Skip to clearing.</p>
          )}
          {snap?.results ? (
            <>
              <h2 style={{ fontSize: "var(--t18)", marginTop: 24 }}>Results after settlement ({snap.settled} series settled)</h2>
              <ul className="limits">
                {snap.settlements.map((s) => (
                  <li key={s.series}>
                    <span className={s.settlement.void ? "flag" : undefined}>
                      Series {s.series}: {settlementLine(s.settlement, snap.params.tick)}.
                    </span>
                    <code>{s.settlement.void ? "void" : "settled"}</code>
                  </li>
                ))}
              </ul>
              <div className="table-wrap">
                <table>
                  <caption>Per agent, simulated. Result is the free balance now minus the deposit.</caption>
                  <thead>
                    <tr>
                      <th scope="col">Agent</th>
                      <th scope="col" className="num">LONG</th>
                      <th scope="col" className="num">SHORT</th>
                      <th scope="col" className="num collapse-sm">Paid</th>
                      <th scope="col" className="num collapse-sm">Received</th>
                      <th scope="col" className="num collapse-sm">Fees burned</th>
                      <th scope="col" className="num collapse-sm">Forfeited</th>
                      <th scope="col" className="num">Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snap.results.map((r) => (
                      <tr key={r.id}>
                        <td className="mono">{r.id}</td>
                        <td className="num">{fmtInt(r.long)}</td>
                        <td className="num">{fmtInt(r.short)}</td>
                        <td className="num collapse-sm">{fmtUsdOrNone(r.paid)}</td>
                        <td className="num collapse-sm">{fmtUsdOrNone(r.received)}</td>
                        <td className="num collapse-sm">{fmtUsdOrNone(r.fees)}</td>
                        <td className="num collapse-sm">{fmtUsdOrNone(r.forfeited)}</td>
                        <td className="num">{fmtUsdOrNone(r.result)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </div>

        <div className={`sim-side sim-log ${tab === "log" ? "" : "hide-narrow"}`}>
          <h2 style={{ fontSize: "var(--t18)", marginBottom: 8 }}>Event log</h2>
          <ol className="log" aria-label="Simulation events, newest first">
            {[...log].reverse().slice(0, 200).map((e, i) => (
              <li key={`${log.length - i}`}>
                <time className="muted">{fmtUtcTime(e.at).replace(" UTC", "")}</time>
                <span className={e.kind === "error" || e.kind === "forfeit" ? "flag" : e.kind === "clear" || e.kind === "settle" ? undefined : "muted"} style={e.kind === "clear" || e.kind === "settle" ? { fontWeight: 650 } : undefined}>
                  {e.text}
                </span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}
