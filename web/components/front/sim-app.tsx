"use client";
// /simulate in the application's frame: one toolbar with the shared button styles, a status line,
// then panels of fixed height that scroll inside. The engine, the worker and what they compute
// are unchanged (lib/sim-worker.ts, lib/sim-snapshot.ts); this file is layout and controls only.
// The page opens on the state after setup, computed at build by the same engine and seed.
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { StepChart } from "@/components/step-chart.tsx";
import { MARKET_IDS, MARKET_INFO, withMarket, type MarketId } from "@/lib/config.ts";
import { fmtCountdown, fmtGpuH, fmtInt, fmtPrice, fmtUsd, fmtUsdOrNone, fmtUtc, fmtUtcTime, shortHash } from "@/lib/format.ts";
import type { LogLine, SimSnapshot } from "@/lib/sim-snapshot.ts";
import type { SimRequest } from "@/lib/sim-worker.ts";
import { cn } from "@/lib/utils.ts";
import { bookRows, bookTotals, settlementLine, stepOrdersFromResult, summarize } from "@/lib/views.ts";
import { buttonClass } from "../ui/button.ts";
import { Dash, SHORT_NAME, Td, Th } from "./app/parts.tsx";

const SPEEDS = [1, 60, 3600] as const;
const TICK_MS = 500;

export function SimApp({ market, initial }: { market: MarketId; initial: { snapshot: SimSnapshot; log: LogLine[]; seed: number } | null }) {
  const worker = useRef<Worker | null>(null);
  const busy = useRef(false);
  const [seed, setSeed] = useState(initial?.seed ?? 7);
  const [seedText, setSeedText] = useState(String(initial?.seed ?? 7));
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(60);
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [snap, setSnap] = useState<SimSnapshot | null>(initial?.snapshot ?? null);
  const [log, setLog] = useState<LogLine[]>(initial?.log ?? []);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [run, setRun] = useState(0);
  const [voidSeries, setVoidSeries] = useState(false);

  const send = useCallback((req: SimRequest) => {
    if (!worker.current || busy.current) return false;
    busy.current = true;
    worker.current.postMessage(req);
    setStarted(true);
    return true;
  }, []);

  useEffect(() => {
    let w: Worker;
    try {
      w = new Worker(new URL("../../lib/sim-worker.ts", import.meta.url), { type: "module" });
    } catch (e) {
      setError(`This browser could not start the simulation worker: ${(e as Error).message}`);
      return;
    }
    worker.current = w;
    w.onmessage = (e: MessageEvent) => {
      busy.current = false;
      setReady(true);
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
    setStarted(false);
    setReady(false);
    if (seedText !== "" && Number.isSafeInteger(n)) setSeed(n);
    setRun((r) => r + 1);
  };

  const p = snap?.params;
  const live = snap?.live;
  const rows = bookRows(live?.book ?? null);
  const totals = bookTotals(rows);
  const last = snap?.last;
  const lastSummary = last ? summarize(last.result, last.info?.floor ?? null) : null;
  const on = ready && !!snap;

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card text-left shadow-[0_40px_90px_-30px_rgba(0,0,0,0.55),0_12px_30px_-12px_rgba(0,0,0,0.35)]">
      {/* Market and title */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3 md:px-5">
        <span className="text-sm font-medium text-foreground">Simulation · {SHORT_NAME[market]}</span>
        <span className="rounded-full px-2 py-0.5 text-xs text-muted-foreground ring-1 ring-border">Nothing here touches the chain</span>
        <nav aria-label="Market" className="ml-auto flex flex-wrap gap-1">
          {MARKET_IDS.map((m) => (
            <Link key={m} href={withMarket("/simulate", m)} aria-current={m === market ? "page" : undefined} className={cn("rounded-md px-2.5 py-1 text-xs no-underline ring-1", m === market ? "bg-foreground/[0.09] text-foreground ring-foreground/30" : "text-muted-foreground ring-border hover:text-foreground")}>
              {SHORT_NAME[m]}
            </Link>
          ))}
        </nav>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 md:px-5" role="group" aria-label="Simulation controls">
        <button type="button" className={buttonClass("primary", "sm", "min-w-20 cursor-pointer border-0")} onClick={() => { setPlaying((x) => !x); setStarted(true); }} disabled={!on} aria-pressed={playing}>
          {playing ? "Pause" : "Play"}
        </button>
        <div className="inline-flex h-9 items-center rounded-md p-0.5 ring-1 ring-border" role="group" aria-label="Speed">
          {SPEEDS.map((s) => (
            <button key={s} type="button" aria-pressed={speed === s} onClick={() => setSpeed(s)} className={cn("h-8 cursor-pointer rounded-[5px] border-0 px-2.5 font-mono text-xs", speed === s ? "bg-foreground/[0.1] text-foreground" : "bg-transparent text-muted-foreground hover:text-foreground")}>
              {s}x
            </button>
          ))}
        </div>
        <button type="button" className={buttonClass("secondary", "sm", "cursor-pointer border-0")} onClick={() => send({ type: "skip" })} disabled={!on}>
          Skip to clearing
        </button>
        <button type="button" className={buttonClass("secondary", "sm", "cursor-pointer border-0")} onClick={() => send({ type: "rounds", n: 10 })} disabled={!on}>
          Run 10 rounds
        </button>
        <button type="button" className={buttonClass("secondary", "sm", "cursor-pointer border-0")} onClick={() => send({ type: "settle" })} disabled={!on}>
          Settle and redeem
        </button>
        <span className="mx-1 hidden h-5 w-px bg-border sm:block" aria-hidden="true" />
        <label className="inline-flex h-9 items-center gap-2 text-xs text-muted-foreground">
          Seed
          <input type="text" inputMode="numeric" value={seedText} onChange={(e) => setSeedText(e.target.value.replace(/\D/g, ""))} className="m-0 h-9 w-16 rounded-md border-0 bg-background px-2 py-0 font-mono text-sm text-foreground ring-1 ring-border" />
        </label>
        <button type="button" className={buttonClass("ghost", "sm", "cursor-pointer border-0 bg-transparent")} onClick={reset}>
          Reset
        </button>
        <button
          type="button"
          role="switch"
          aria-checked={voidSeries}
          onClick={() => {
            setVoidSeries((v) => !v);
            setPlaying(false);
            setStarted(false);
          }}
          title="Reporters sit out series 0's delivery, so it settles void: cancelled at the centre of the band, half the band to each side. Restarts the run."
          className="ml-auto inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 font-sans text-xs text-foreground"
        >
          <span className={cn("relative h-5 w-9 rounded-full ring-1 transition-colors", voidSeries ? "bg-foreground ring-foreground" : "bg-background ring-border")} aria-hidden="true">
            <span className={cn("absolute top-0.5 size-4 rounded-full transition-[left]", voidSeries ? "left-[18px] bg-background" : "left-0.5 bg-foreground/60")} />
          </span>
          Silent reporters (void series)
        </button>
      </div>
      <p className="m-0 max-w-none border-b border-border px-4 py-2 text-xs text-muted-foreground md:px-5">
        With silent reporters on, series 0 gets too few prints and is cancelled at the centre of the band: half the band to each side. Switching it restarts the run.
      </p>

      {/* Status line */}
      <div aria-live="polite" className="border-b border-border px-4 py-3 text-sm md:px-5">
        {error ? <p className="m-0 max-w-none text-flag">{error}</p> : null}
        {snap && p ? (
          <p className="m-0 max-w-none text-foreground">
            Simulated time <span className="font-mono">{fmtUtc(snap.now)}</span>
            {live ? (
              <span className="text-muted-foreground">
                {" "}· series {live.series}
                {live.round !== null ? `, round ${live.round}, ${live.phase.toLowerCase()} phase, ${fmtCountdown((live.phaseEndsAt ?? snap.now) - snap.now)} left` : ", between rounds"}
              </span>
            ) : (
              <span className="text-muted-foreground"> · no series in auction</span>
            )}
            {snap.lastPrint ? <span className="text-muted-foreground"> · index {fmtPrice(snap.lastPrint.price, p.tick)} (simulated)</span> : null}
          </p>
        ) : !error ? (
          <p className="m-0 text-muted-foreground">Starting the engine in this browser…</p>
        ) : null}
        {snap && !started ? (
          <p className="m-0 mt-2 max-w-none rounded-md bg-foreground/[0.06] px-3 py-2 text-sm text-foreground">
            The market is set up: {snap.agents.length} agents with their deposits, and the first auction about to open. Press <b>Play</b> to run it at the speed above, or <b>Run 10 rounds</b> to jump ahead.
          </p>
        ) : null}
      </div>

      {/* Panels */}
      <div className="grid lg:grid-cols-2">
        <SimPanel title="Agents" note={`${snap?.agents.length ?? 0} agents, free balances`}>
          <table className="w-full min-w-[460px] border-collapse text-sm">
            <thead>
              <tr>
                <Th>Agent</Th>
                <Th>Role</Th>
                <Th right>Free balance, $</Th>
                <Th>What it does</Th>
              </tr>
            </thead>
            <tbody>
              {(snap?.agents ?? []).map((a) => (
                <tr key={a.id} className="border-t border-border align-top">
                  <Td className="font-mono text-xs">{a.id}</Td>
                  <Td>{a.role}</Td>
                  <Td right>
                    <span className="font-mono">{fmtUsd(a.balance).replace(/^\$/, "")}</span>
                  </Td>
                  <Td className="whitespace-normal">
                    <details className="group">
                      <summary className="cursor-pointer list-none text-xs text-muted-foreground [&::-webkit-details-marker]:hidden">
                        {firstSentence(a.rule, a.role)} <span className="text-foreground group-open:hidden">More</span>
                      </summary>
                      <p className="m-0 mt-1 max-w-none text-xs text-muted-foreground">{a.rule}</p>
                    </details>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </SimPanel>

        <SimPanel title={`Sealed book${live && live.round !== null ? `, series ${live.series} round ${live.round}` : ""}`} note={rows.length ? `${totals.commits} commits, ${fmtUsd(totals.locked)} locked, ${totals.revealed} revealed` : null}>
          {rows.length === 0 ? (
            <p className="m-0 p-5 text-sm text-muted-foreground">No commits in the round in progress yet.</p>
          ) : (
            <table className="w-full min-w-[460px] border-collapse text-sm">
              <thead>
                <tr>
                  <Th right>Seq</Th>
                  <Th>Owner</Th>
                  <Th>Hash</Th>
                  <Th>Side</Th>
                  <Th right>Size, GPU-h</Th>
                  <Th right>Limit, $/GPU-h</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.seq} className="border-t border-border">
                    <Td right>{r.seq}</Td>
                    <Td className="font-mono text-xs">{r.owner}</Td>
                    <Td className="font-mono text-xs">{r.hash ? shortHash(r.hash) : <Dash />}</Td>
                    <Td>{r.side ? <span className={r.side === "Long" ? "text-long" : "text-short"}>{r.side === "Long" ? "LONG" : "SHORT"}</span> : <span className="text-muted-foreground">sealed</span>}</Td>
                    <Td right>{r.size !== null ? fmtInt(r.size) : <Dash />}</Td>
                    <Td right>{r.price !== null && p ? fmtPrice(r.price, p.tick).replace(/ \/GPU-h$/, "") : <Dash />}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </SimPanel>

        <SimPanel title={last ? `Last clearing: series ${last.series}, round ${last.round}` : "Last clearing"} note={last && p && lastSummary ? (lastSummary.price === null ? "No trade: the curves did not cross" : `${fmtPrice(lastSummary.price, p.tick)} (forward ${fmtPrice(lastSummary.forward, p.tick)}) for ${fmtGpuH(lastSummary.volume)}, simulated`) : null}>
          {last && last.info && p ? (
            <div className="px-3 py-2">
              <StepChart key={`${last.series}-${last.round}`} orders={stepOrdersFromResult(last.result)} band={last.info.band} floor={last.info.floor} tick={p.tick} price={last.result.price} volume={last.result.volume} cleared compact height={300} />
            </div>
          ) : (
            <p className="m-0 p-5 text-sm text-muted-foreground">No round has cleared yet. Press Skip to clearing.</p>
          )}
        </SimPanel>

        <SimPanel title="Event log" note="Newest first">
          <ol className="m-0 list-none p-0" aria-label="Simulation events, newest first">
            {[...log].reverse().slice(0, 200).map((e, i) => (
              <li key={`${log.length - i}`} className="flex gap-3 border-t border-border px-5 py-1.5 text-xs first:border-t-0">
                <time className="shrink-0 font-mono text-muted-foreground">{fmtUtcTime(e.at).replace(" UTC", "")}</time>
                <span className={e.kind === "error" || e.kind === "forfeit" ? "text-flag" : e.kind === "clear" || e.kind === "settle" ? "font-medium text-foreground" : "text-muted-foreground"}>{e.text}</span>
              </li>
            ))}
          </ol>
        </SimPanel>
      </div>

      {snap?.results ? (
        <div className="border-t border-border px-4 py-5 md:px-5">
          <h2 className="m-0 mb-3 text-lg font-medium text-foreground">Results after settlement ({snap.settled} series settled)</h2>
          <ul className="m-0 mb-4 list-none space-y-1 p-0 text-sm">
            {snap.settlements.map((s) => (
              <li key={s.series} className={s.settlement.void ? "text-flag" : "text-foreground"}>
                Series {s.series}: {settlementLine(s.settlement, snap.params.tick)}. <span className="text-xs text-muted-foreground">{s.settlement.void ? "void" : "settled"}</span>
              </li>
            ))}
          </ul>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-sm">
              <caption className="pb-2 text-left text-xs text-muted-foreground">Per agent, simulated. Result is the free balance now minus the deposit.</caption>
              <thead>
                <tr>
                  <Th>Agent</Th>
                  <Th right>LONG, GPU-h</Th>
                  <Th right>SHORT, GPU-h</Th>
                  <Th right>Paid, $</Th>
                  <Th right>Received, $</Th>
                  <Th right>Fees burned, $</Th>
                  <Th right>Forfeited, $</Th>
                  <Th right>Result, $</Th>
                </tr>
              </thead>
              <tbody>
                {snap.results.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <Td className="font-mono text-xs">{r.id}</Td>
                    <Td right>{fmtInt(r.long)}</Td>
                    <Td right>{fmtInt(r.short)}</Td>
                    <Td right>{fmtUsdOrNone(r.paid)}</Td>
                    <Td right>{fmtUsdOrNone(r.received)}</Td>
                    <Td right>{fmtUsdOrNone(r.fees)}</Td>
                    <Td right>{fmtUsdOrNone(r.forfeited)}</Td>
                    <Td right>{fmtUsdOrNone(r.result)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
      <p className="m-0 max-w-none border-t border-border px-4 py-3 text-xs text-muted-foreground md:px-5">{MARKET_INFO[market].name} market: {MARKET_INFO[market].delivery}, {MARKET_INFO[market].rounds}. The index is a seeded random walk from the chip&rsquo;s index level; the engine is the one the contract is tested against.</p>
    </div>
  );
}

function SimPanel({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col border-b border-border lg:odd:border-r">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border px-5 py-3">
        <h2 className="m-0 text-base font-medium text-foreground">{title}</h2>
        {note ? <span className="text-xs text-muted-foreground">{note}</span> : null}
      </div>
      <div className="h-[380px] overflow-auto">{children}</div>
    </section>
  );
}

/** One short line per role, from each strategy's own rule (the full rule opens on "More"). */
const SHORT_RULE: Record<string, string> = {
  buyer: "Bids LONG for the hours it will use.",
  seller: "Bids SHORT for the hours its GPUs rent out.",
  maker: "Quotes both sides around its forecast.",
  noise: "Bids a random view, LONG or SHORT.",
};

const firstSentence = (s: string, role?: string) => (role && SHORT_RULE[role]) || (s.split(";")[0] ?? s);
