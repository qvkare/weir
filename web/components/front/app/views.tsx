"use client";
// The Weir application's views (lib/app-views.ts), each inside the same frame the homepage's
// window shows: sidebar, title row, chip row, and a main area that scrolls inside the frame.
// Each view reads the chain in this browser after showing the figures as published, labelled.
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { AgentPanel, LiveCurves, NoRoundInProgress, RoundResult, SealedBook } from "@/components/auction-blocks.tsx";
import { SeriesStrips } from "@/components/home-blocks.tsx";
import { LiveBar, useLive } from "@/components/live.tsx";
import { NotDeployed, RpcError } from "@/components/state.tsx";
import { Contracts, Solvency } from "@/components/pages/proof-live.tsx";
import { ProofIndex } from "@/components/pages/proof-index.tsx";
import { MOVED_ANCHORS, type AppView } from "@/lib/app-views.ts";
import { valueOf } from "@/lib/cache.ts";
import { clientReader, clientSource } from "@/lib/client-source.ts";
import { MARKET_INFO, withMarket, type MarketId } from "@/lib/config.ts";
import { loadAgentRows, loadClearings, loadPrintList, loadShell, shellKey, type AgentsViewData, type ClearingsData, type PrintsData, type ShellData } from "@/lib/data/app.ts";
import { auctionKey, auctionProbe, loadAuction, type AuctionData } from "@/lib/data/auction.ts";
import type { HomeData } from "@/lib/data/home.ts";
import { loadProof, type ContractRow, type ProofData } from "@/lib/data/proof.ts";
import { homeProbe } from "@/lib/data/home.ts";
import { dollarsOfPrice, fmtBps, fmtGpuH, fmtUsd, fmtUsdOrNone, fmtUtc, fmtUtcTime, shortAccount, shortHash } from "@/lib/format.ts";
import type { LoadedBundle } from "@/lib/load.ts";
import type { SiteConfig } from "@/lib/site-config.ts";
import { cn } from "@/lib/utils.ts";
import { bookRows, bookTotals, lastResult } from "@/lib/views.ts";
import { BUNDLES_SINCE, checkBundle, checkMedian, summarizeChecks, type PrintCheckSummary, type Row as CheckRow } from "@/lib/verify.ts";
import { Chip, ChipRow, Dash, FilterChip, Frame, Panel, PhoneNav, RoundsTable, Sidebar, smallButton, Td, Th, TitleRow } from "./parts.tsx";

// ── The frame around every view ──────────────────────────────────

export interface ShellProps {
  cfg: SiteConfig;
  market: MarketId;
  view: AppView;
  shell: ShellData;
  /** Every market the sidebar lists. */
  markets: MarketId[];
  /** Shown inside the homepage's tabs: figures as published, no reads, no address forwarding. */
  embedded?: boolean;
}

function useShell({ cfg, market, shell, markets }: ShellProps) {
  const poll = MARKET_INFO[market].cadence === "Hourly" ? 15 : 30;
  return useLive<ShellData>({
    initial: shell,
    initialAt: cfg.builtAt * 1000,
    mode: cfg.mode,
    load: async () => {
      const own = clientSource(cfg, market);
      const d = await loadShell(own, markets.filter((m) => m !== market).map((m) => clientSource(cfg, m)));
      if (d.error) throw new Error(d.error);
      return d;
    },
    probe: () => homeProbe(clientSource(cfg, market)),
    keyOf: shellKey,
    pollSecs: poll,
  });
}

/** Forwards old anchors of this section's page (/proof#audited, /auction#book-h…) to their view. */
function useMovedAnchors(view: AppView, market: MarketId, off = false) {
  useEffect(() => {
    if (off) return;
    const id = location.hash.slice(1);
    const to = id ? MOVED_ANCHORS[view.section][id] : null;
    const q = new URLSearchParams(location.search);
    if (view.id === "round" && q.has("series") && q.has("round")) {
      q.delete("m");
      location.replace(withMarket("/auction/clearings", market, q.toString()));
      return;
    }
    if (!to || to.split("#")[0] === view.path) return;
    const [path, hash] = to.split("#") as [string, string | undefined];
    location.replace(withMarket(path, market) + (hash ? `#${hash}` : ""));
  }, [view, market, off]);
}

function ShellFrame(p: ShellProps & { chips?: ReactNode; children: ReactNode }) {
  const [st] = useShell(p);
  useMovedAnchors(p.view, p.market, p.embedded);
  const s = st.data;
  const auctionView = p.view.section === "auction";
  return (
    <Frame
      fill={p.embedded ? "embed" : true}
      sidebar={<Sidebar network={p.cfg.network} chips={s.chips} selected={p.market} view={p.view} />}
      phoneNav={<PhoneNav selected={p.market} view={p.view} />}
      title={
        <TitleRow
          market={p.market}
          live={s.live}
          now={s.now}
          wall={st.from === "build"}
          frozen={p.embedded}
          action={
            auctionView ? (
              <Link href="/how" className="text-xs text-foreground underline underline-offset-4">
                How a round works
              </Link>
            ) : (
              <Link href={withMarket("/auction", p.market)} className={smallButton}>
                Open the auction
              </Link>
            )
          }
        />
      }
      chips={p.chips}
    >
      {p.children}
    </Frame>
  );
}

const barClass = "m-0 flex-nowrap items-baseline border-0 bg-transparent p-0 font-sans text-xs text-muted-foreground";

// ── Round in progress ────────────────────────────────────────────

export function RoundView(p: ShellProps & { initial: AuctionData }) {
  const { cfg, market } = p;
  const poll = MARKET_INFO[market].cadence === "Hourly" ? 15 : 30;
  const [st, retry] = useLive<AuctionData>({
    initial: p.initial,
    initialAt: cfg.builtAt * 1000,
    mode: cfg.mode,
    load: async () => {
      const d = await loadAuction(clientSource(cfg, market), null);
      if (!d.core.status.ok) throw new Error(d.core.status.error);
      return d;
    },
    probe: () => auctionProbe(clientSource(cfg, market), null),
    keyOf: auctionKey,
    pollSecs: poll,
  });
  const d = st.data;
  const params = valueOf(d.core.params);
  const live = d.live;
  const bar = <LiveBar st={st} mode={cfg.mode} builtAt={cfg.builtAt} polls={`Checks the round and its book every ${poll} s while this tab is visible.`} retry={retry} className={barClass} />;
  let body: ReactNode;
  if (d.core.kind === "none") body = <div className="p-6"><NotDeployed market={market} what="auction" /></div>;
  else if (!params || !valueOf(d.core.status)) body = <div className="p-6"><RpcError read={!d.core.params.ok ? d.core.params : d.core.status} href={withMarket("/auction", market)} model={d.core.kind === "model"} /></div>;
  else if (!live || live.round === null || live.phase_ends_at === null) body = <Panel title="No round in progress"><NoRoundInProgress params={params} now={d.core.now} /></Panel>;
  else {
    const round = d.round ? valueOf(d.round) : null;
    const series = d.series ? valueOf(d.series) : null;
    const totals = bookTotals(bookRows(round));
    const prev = lastResult(d.recent ? valueOf(d.recent) : null);
    const commit = live.phase === "Commit";
    body = (
      <>
        <Panel title={`Round ${live.round} of series ${live.series}`} note={`${commit ? "Commit" : "Reveal"} phase, ends ${fmtUtc(live.phase_ends_at)}`}>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Commits" value={String(totals.commits)} sub={`${totals.revealed} revealed, ${totals.void} void, ${totals.sealed} sealed`} />
            <Stat label="Locked" value={fmtUsdOrNone(totals.locked)} sub="An upper bound on what the orders can cost" />
            <Stat label="Commit fees held" value={fmtUsdOrNone(totals.fees)} sub="Burned when the round clears; they belong to nobody" />
            <Stat label="Delivery" value={`${fmtUtcTime(live.delivery_start)}`} sub={`to ${fmtUtc(live.delivery_end)}`} />
          </div>
          <p className="m-0 mt-4 max-w-none text-sm text-muted-foreground">
            {totals.commits === 0 ? "No sealed commits yet. Sides and prices stay hidden until the reveal." : commit ? "Sides and prices stay hidden until the reveal." : `Unrevealed commits forfeit ${fmtBps(params.forfeit_bps)} of their lock, burned at clearing.`}{" "}
            <Link href={withMarket("/auction/book", market)}>The sealed book</Link>
          </p>
          {d.round && !d.round.ok ? <RpcError read={d.round} href={withMarket("/auction", market)} model={d.core.kind === "model"} /> : null}
        </Panel>
        {!commit ? (
          <Panel title="Curves as revealed">
            <LiveCurves round={round} series={series} params={params} />
          </Panel>
        ) : null}
        <Panel title={prev ? `Round ${prev.round}, cleared` : "Last cleared round"} note={prev ? <Link href={withMarket("/auction/clearings", market, `series=${live.series}&round=${prev.round}`)}>Open in Clearings</Link> : null}>
          {prev ? <RoundResult result={prev.result} series={series} params={params} round={prev.round} /> : <p className="m-0 text-sm text-muted-foreground">No round of series {live.series} has cleared yet.</p>}
        </Panel>
        {d.series2 ? (
          <Panel id="series" title="Series and phase clock" note={`${MARKET_INFO[market].delivery}, ${MARKET_INFO[market].rounds}`}>
            <SeriesStrips d={d.series2 as HomeData} wall={st.from === "build"} />
          </Panel>
        ) : null}
        <Panel title="Bid with an agent">
          <AgentPanel market={market} />
        </Panel>
      </>
    );
  }
  return (
    <ShellFrame {...p} chips={<ChipRow label="Round in progress" bar={bar} />}>
      {body}
    </ShellFrame>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-lg bg-background/60 p-4 ring-1 ring-border">
      <p className="m-0 text-xs text-muted-foreground">{label}</p>
      <p className="m-0 mt-1 font-mono text-2xl text-foreground">{value}</p>
      <p className="m-0 mt-1 max-w-none text-xs text-muted-foreground">{sub}</p>
    </div>
  );
}

// ── Sealed book ──────────────────────────────────────────────────

export function BookView(p: ShellProps & { initial: AuctionData }) {
  const { cfg, market } = p;
  const poll = MARKET_INFO[market].cadence === "Hourly" ? 15 : 30;
  const [st, retry] = useLive<AuctionData>({
    initial: p.initial,
    initialAt: cfg.builtAt * 1000,
    mode: cfg.mode,
    load: async () => {
      const d = await loadAuction(clientSource(cfg, market), null);
      if (!d.core.status.ok) throw new Error(d.core.status.error);
      return d;
    },
    probe: () => auctionProbe(clientSource(cfg, market), null),
    keyOf: auctionKey,
    pollSecs: poll,
  });
  const d = st.data;
  const params = valueOf(d.core.params);
  const live = d.live;
  const round = d.round ? valueOf(d.round) : null;
  const totals = bookTotals(bookRows(round));
  const bar = <LiveBar st={st} mode={cfg.mode} builtAt={cfg.builtAt} polls={`Checks the book every ${poll} s while this tab is visible.`} retry={retry} className={barClass} />;
  return (
    <ShellFrame
      {...p}
      chips={
        <ChipRow label="Sealed book" bar={bar}>
          {live && live.round !== null ? <Chip>Round {live.round}, series {live.series}</Chip> : null}
          <Chip>{totals.commits} commits</Chip>
          <Chip>{totals.commits ? `${fmtUsd(totals.locked)} locked` : "Nothing locked yet"}</Chip>
        </ChipRow>
      }
    >
      {d.core.kind === "none" ? (
        <div className="p-6"><NotDeployed market={market} what="book" /></div>
      ) : !params ? (
        <div className="p-6"><RpcError read={d.core.params} href={withMarket("/auction/book", market)} model={d.core.kind === "model"} /></div>
      ) : !live || live.round === null ? (
        <Panel title="No round in progress"><NoRoundInProgress params={params} now={d.core.now} /></Panel>
      ) : (
        <Panel title={`Round ${live.round} of series ${live.series}`} note="Sides, sizes and prices appear as each commit is revealed. A cleared round's book is not kept on chain; its filled orders are in Clearings.">
          <SealedBook round={round} params={params} />
        </Panel>
      )}
    </ShellFrame>
  );
}

// ── Clearings ────────────────────────────────────────────────────

export function ClearingsView(p: ShellProps & { initial: ClearingsData }) {
  const { cfg, market } = p;
  const [sel, setSel] = useState<{ series: number; round: number } | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const s = Number(q.get("series"));
    const r = Number(q.get("round"));
    if (q.has("series") && q.has("round") && Number.isInteger(s) && Number.isInteger(r)) setSel({ series: s, round: r });
  }, []);
  const [st, retry] = useLive<ClearingsData>({
    initial: p.initial,
    initialAt: cfg.builtAt * 1000,
    mode: cfg.mode,
    load: async () => {
      const d = await loadClearings(clientSource(cfg, market), sel);
      if (d.error) throw new Error(d.error);
      return d;
    },
    pollSecs: 0,
    deps: [sel],
  });
  const d = st.data;
  const params = d.params;
  const picked = d.picked;
  const bar = <LiveBar st={st} mode={cfg.mode} builtAt={cfg.builtAt} polls="Read when the page opens and when you pick a round; reload to read again." retry={retry} className={barClass} />;
  return (
    <ShellFrame
      {...p}
      chips={
        <ChipRow label="Clearings" bar={bar}>
          <Chip>Newest first</Chip>
          {d.series !== null ? <Chip>Series {d.series}</Chip> : null}
          <Chip>All {d.rows.length} rounds</Chip>
        </ChipRow>
      }
    >
      {d.kind === "none" ? (
        <div className="p-6"><NotDeployed market={market} what="clearing" /></div>
      ) : (
        <>
          <RoundsTable
            rows={d.rows}
            tick={params?.tick}
            showSeries={false}
            selected={picked ? `${picked.series}-${picked.round}` : null}
            empty={d.error ? `Could not read the chain: ${d.error}` : `No round of series ${d.series ?? ""} has cleared yet.`}
            hrefOf={(r) => withMarket("/auction/clearings", market, `series=${r.series}&round=${r.round}`)}
          />
          {picked && params ? (
            <Panel id="round" title={`Round ${picked.round} of series ${picked.series}`} note={picked.result ? `Cleared ${fmtUtc(picked.result.cleared_at)}` : null}>
              {picked.result ? <RoundResult result={picked.result} series={picked.info} params={params} round={picked.round} /> : <p className="m-0 text-sm text-muted-foreground">This round has no result: it has not cleared, held no commits, or its result was pruned after settlement.</p>}
            </Panel>
          ) : null}
        </>
      )}
    </ShellFrame>
  );
}

// ── Index prints ─────────────────────────────────────────────────

interface PrintCheck {
  bucket: number;
  rows: CheckRow[];
  done: boolean;
}

export function PrintsView(p: ShellProps & { initial: PrintsData; index: HomeData; sample: LoadedBundle | null }) {
  const { cfg, market } = p;
  const [st, retry] = useLive<PrintsData>({
    initial: p.initial,
    initialAt: cfg.builtAt * 1000,
    mode: cfg.mode,
    load: async () => {
      const d = await loadPrintList(clientSource(cfg, market));
      if (d.error) throw new Error(d.error);
      return d;
    },
    pollSecs: 0,
  });
  const d = st.data;
  const checks = useChecks(d, cfg.bundlesBase, cfg.mode === "chain" && st.from === "live");
  const [open, setOpen] = useState<number | null>(null);
  const bar = <LiveBar st={st} mode={cfg.mode} builtAt={cfg.builtAt} polls="Read once when the page opens; each print's bundles are then fetched and hashed here." retry={retry} className={barClass} />;
  return (
    <ShellFrame
      {...p}
      chips={
        <ChipRow label="Index prints" bar={bar}>
          <Chip>Newest first</Chip>
          <Chip>Last {d.prints.length} prints</Chip>
        </ChipRow>
      }
    >
      <section id="verifier" aria-label="Prints, checked in this browser">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] border-collapse text-sm">
            <thead>
              <tr>
                <Th>Bucket, UTC</Th>
                <Th right>Print, $/GPU-h</Th>
                <Th>Reports</Th>
                <Th>Median</Th>
                <Th>Hashes</Th>
                <Th>Method checks</Th>
                <Th>Detail</Th>
              </tr>
            </thead>
            <tbody>
              {d.prints.length === 0 ? (
                <tr>
                  <td colSpan={7} className="h-40 px-5 text-center text-sm text-muted-foreground">
                    {d.kind === "none" ? `The ${MARKET_INFO[market].name} market is not deployed yet.` : d.error ? `Could not read the chain: ${d.error}` : "No print yet."}
                  </td>
                </tr>
              ) : (
                d.prints.map((pr) => {
                  const c = checks.find((x) => x.bucket === pr.bucket);
                  const kinds = (k: CheckRow["kind"]) => c?.rows.filter((r) => r.kind === k) ?? [];
                  const med = pr.price !== null && pr.reports.length ? checkMedian({ bucket: pr.bucket, price: pr.price, reports: pr.reports.map((r) => ({ reporter: r.reporter, price: r.price, bundle: r.bundle })) }) : null;
                  const sum = c && c.done ? summarizeChecks(c.rows, pr.reports.map((r) => r.reporter)) : null;
                  const before = pr.bucket < BUNDLES_SINCE;
                  return (
                    <PrintRow key={pr.bucket} open={open === pr.bucket} onToggle={() => setOpen(open === pr.bucket ? null : pr.bucket)} c={c} reason={sum && sum.unavailable ? (before ? `The bundle host has no file for ${sum.unavailable === pr.reports.length ? "these reports" : `${sum.unavailable} of these reports`}: they were made before ${fmtUtc(BUNDLES_SINCE)}, when the host started publishing bundles. Not a failed check.` : `The bundle host had no file for ${sum.unavailable} of these reports when asked. Not a failed check.`) : null}>
                      <Td>{fmtUtc(pr.bucket)}</Td>
                      <Td right>{pr.price !== null ? <span className="font-mono text-foreground">{dollarsOfPrice(pr.price, d.tick ?? undefined)}</span> : <span className="text-muted-foreground">{pr.state === "Open" ? "open" : "no print"}</span>}</Td>
                      <Td>
                        {pr.reports.length} <span className="text-muted-foreground">({pr.reports.map((r) => shortAccount(r.reporter).split(".")[0]).join(", ")})</span>
                      </Td>
                      <Td>{med ? <Status ok={med.ok}>{med.ok ? "matches" : "differs"}</Status> : <Dash />}</Td>
                      <Td>{!c ? <Status>not checked</Status> : !sum ? <Status>checking</Status> : sum.matched + sum.differs === 0 ? <Status>not published</Status> : <HashPills s={sum} />}</Td>
                      <Td>{!sum ? <Dash /> : sum.rulesPassed + sum.rulesFailed === 0 ? <Status>not run</Status> : <Status ok={sum.rulesFailed === 0}>{sum.rulesFailed ? `${sum.rulesFailed} of ${sum.rulesPassed + sum.rulesFailed} bundles fail` : `${sum.rulesPassed} of ${sum.rulesPassed} bundles pass`}</Status>}</Td>
                    </PrintRow>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <p className="m-0 max-w-none px-5 py-3 text-xs text-muted-foreground">
          {p.embedded ? "Open the view to fetch each report's bundle and check it in this browser." : cfg.mode !== "chain" ? "Bundles are checked only against the live chain; model figures have no files behind their hashes." : !cfg.bundlesBase ? "No bundle host is set for this deployment, so report hashes cannot be fetched. Unverified." : "Each report's bundle is fetched from the reporters' bundle host and hashed with SHA-256 in this browser; the method's checks run on it, and the print is recomputed as the median of the reports. A report is matched, did not match, or not published (the host has no file for it, which is not a failed check)."}
        </p>
      </section>
      <div className="px-4 md:px-6">
        <ProofIndex cfg={cfg} initial={p.index} market={market} sample={p.sample} />
      </div>
    </ShellFrame>
  );
}

/** Matched, did not match and not available, each its own pill; red only for a real mismatch. */
function HashPills({ s }: { s: PrintCheckSummary }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {s.matched ? <Status ok>{`${s.matched} matched`}</Status> : null}
      {s.differs ? <Status ok={false}>{`${s.differs} did not match`}</Status> : null}
      {s.unavailable ? <Status>{`${s.unavailable} not published`}</Status> : null}
    </span>
  );
}

function PrintRow({ open, onToggle, c, reason, children }: { open: boolean; onToggle: () => void; c: PrintCheck | undefined; reason: string | null; children: ReactNode }) {
  return (
    <>
      <tr className="border-t border-border hover:bg-muted/40">
        {children}
        <Td>
          <button type="button" aria-expanded={open} onClick={onToggle} disabled={!c || !c.done} className="cursor-pointer rounded-md border-0 bg-transparent px-2 py-1 font-sans text-xs text-foreground ring-1 ring-border disabled:cursor-default disabled:opacity-50">
            {open ? "Hide" : "Show"}
          </button>
        </Td>
      </tr>
      {open && c ? (
        <tr>
          <td colSpan={7} className="bg-background/50 px-5 py-3">
            {reason ? <p className="m-0 mb-2 max-w-none text-xs text-muted-foreground">{reason}</p> : null}
            <ul className="m-0 list-none space-y-1 p-0 text-xs">
              {c.rows.map((r, i) => (
                <li key={i} className="flex gap-2">
                  {r.kind === "fetch" ? <Status>not published</Status> : <Status ok={r.ok}>{r.ok ? "ok" : "no"}</Status>}
                  <span className="text-muted-foreground">{describe(r)}</span>
                </li>
              ))}
            </ul>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function describe(r: CheckRow): string {
  switch (r.kind) {
    case "fetch":
      return `${shortAccount(r.label)}: ${r.detail}`;
    case "hash":
      return `${shortAccount(r.label)}: file ${shortHash(r.file, 8, 4)} against chain ${shortHash(r.chain, 8, 4)}`;
    case "rules":
      return `${shortAccount(r.label)}: ${r.passed} method checks passed${r.failed.length ? `, failed: ${r.failed.map((f) => f.name).join("; ")}` : ""}`;
    case "index":
      return `${shortAccount(r.label)}: the bundle's index ${r.file ?? "none"} against the reported ${r.chain}`;
    case "median":
      return `median ${r.recomputed ?? "none"} against the print ${r.chain}`;
  }
}

function Status({ ok, children }: { ok?: boolean; children: ReactNode }) {
  return <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs ring-1", ok === true ? "text-foreground ring-border" : ok === false ? "text-flag ring-[color-mix(in_srgb,var(--flag)_45%,transparent)]" : "text-muted-foreground ring-border")}>
    {ok === true ? <span className="size-1.5 rounded-full bg-foreground/70" aria-hidden="true" /> : null}
    {children}
  </span>;
}

/** Fetches each report's bundle and checks it, one print at a time, newest first. */
function useChecks(d: PrintsData, base: string | null, run: boolean): PrintCheck[] {
  const [out, setOut] = useState<PrintCheck[]>([]);
  const key = d.prints.map((p) => p.bucket).join(",");
  useEffect(() => {
    if (!run || !base) return;
    let gone = false;
    (async () => {
      const acc: PrintCheck[] = [];
      for (const pr of d.prints) {
        if (gone) return;
        if (pr.price === null) continue;
        const entry: PrintCheck = { bucket: pr.bucket, rows: [], done: false };
        acc.push(entry);
        setOut([...acc]);
        for (const r of pr.reports) {
          try {
            const res = await fetch(`${base}/${r.bundle}.json`, { cache: "no-store" });
            if (!res.ok) entry.rows.push({ kind: "fetch", label: r.reporter, ok: false, detail: `the bundle host answered HTTP ${res.status} for ${shortHash(r.bundle)}` });
            else entry.rows.push(...(await checkBundle(await res.text(), r.bundle, r.price, r.reporter)));
          } catch (e) {
            entry.rows.push({ kind: "fetch", label: r.reporter, ok: false, detail: `could not fetch ${shortHash(r.bundle)}: ${(e as Error).message}` });
          }
        }
        entry.done = true;
        if (!gone) setOut([...acc]);
      }
    })();
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, run, base]);
  return out;
}

// ── Agents ───────────────────────────────────────────────────────

export function AgentsView(p: ShellProps & { initial: AgentsViewData; accounts: { account: string; role: string }[]; guide: ReactNode }) {
  const { cfg, market, accounts } = p;
  const [st, retry] = useLive<AgentsViewData>({
    initial: p.initial,
    initialAt: cfg.builtAt * 1000,
    mode: cfg.mode,
    load: async () => {
      const d = await loadAgentRows(clientSource(cfg, market), accounts);
      if (d.error) throw new Error(d.error);
      return d;
    },
    pollSecs: 0,
  });
  const d = st.data;
  const bar = <LiveBar st={st} mode={cfg.mode} builtAt={cfg.builtAt} polls="Read once when the page opens." retry={retry} className={barClass} />;
  return (
    <ShellFrame
      {...p}
      chips={
        <ChipRow label="Agents" bar={bar}>
          <Chip>{d.rows.length} accounts</Chip>
          {d.series !== null ? <Chip>Positions in series {d.series}</Chip> : null}
        </ChipRow>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] border-collapse text-sm">
          <thead>
            <tr>
              <Th>Account</Th>
              <Th>Role</Th>
              <Th>Key</Th>
              <Th right>Free balance, $</Th>
              <Th right>Position, GPU-h</Th>
              <Th>Latest action read</Th>
            </tr>
          </thead>
          <tbody>
            {d.rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="h-32 px-5 text-center text-sm text-muted-foreground">
                  No agents are recorded for this market.
                </td>
              </tr>
            ) : (
              d.rows.map((r) => (
                <tr key={r.account} className="border-t border-border hover:bg-muted/40">
                  <Td>
                    <span className="font-mono text-xs text-foreground" title={r.account}>
                      {shortAccount(r.account)}
                    </span>
                  </Td>
                  <Td>{r.role}</Td>
                  <Td>
                    <Status ok>cannot withdraw</Status>
                  </Td>
                  <Td right>{r.balance !== null ? <span className="font-mono">{fmtUsd(r.balance).replace(/^\$/, "")}</span> : <Dash />}</Td>
                  <Td right>{r.position ? <span className="font-mono">{r.position.long ? `${fmtGpuH(r.position.long)} LONG` : ""}{r.position.long && r.position.short ? ", " : ""}{r.position.short ? `${fmtGpuH(r.position.short)} SHORT` : ""}{!r.position.long && !r.position.short ? "none" : ""}</span> : <Dash />}</Td>
                  <Td>{r.last ? `${r.last.what}, round ${r.last.round}${r.last.at ? `, ${fmtUtcTime(r.last.at)}` : ""}` : <span className="text-muted-foreground">none in the rounds read</span>}</Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="m-0 max-w-none border-b border-border px-5 py-3 text-xs text-muted-foreground">The accounts the deploy tool recorded for this market. Each trades with a function-call key that cannot withdraw; the operator also holds a full-access key to each account.</p>
      {p.guide}
    </ShellFrame>
  );
}

// ── Proof: contracts, solvency, review, record ───────────────────

function useProof(p: ShellProps & { initial: ProofData; rows: ContractRow[] }) {
  const { cfg, market, rows } = p;
  return useLive<ProofData>({
    initial: p.initial,
    initialAt: cfg.builtAt * 1000,
    mode: cfg.mode,
    load: async () => {
      const readers = new Map<MarketId, ReturnType<typeof clientReader>>();
      const readerOf = (m: MarketId) => readers.get(m) ?? (readers.set(m, clientReader(cfg, m)), readers.get(m)!);
      const d = await loadProof(rows, readerOf, market);
      const failed = [d.params, d.totals].find((r) => r && !r.ok);
      if (failed && !failed.ok) throw new Error(failed.error);
      return d;
    },
    pollSecs: 0,
  });
}

export function ContractsView(p: ShellProps & { initial: ProofData; rows: ContractRow[]; params: ReactNode }) {
  const [st, retry] = useProof(p);
  const bar = <LiveBar st={st} mode={p.cfg.mode} builtAt={p.cfg.builtAt} polls="Read once when the page opens." retry={retry} className={barClass} />;
  return (
    <ShellFrame {...p} chips={<ChipRow label="Contracts" bar={bar}><Chip>{st.data.contracts.length} accounts</Chip></ChipRow>}>
      <Panel id="contracts" title="Contracts" note="Keys and code hash. A contract account with no keys cannot change its code.">
        <Contracts d={st.data} explorer={p.cfg.explorer} />
      </Panel>
      {p.params}
    </ShellFrame>
  );
}

export function SolvencyView(p: ShellProps & { initial: ProofData; rows: ContractRow[] }) {
  const [st, retry] = useProof(p);
  const bar = <LiveBar st={st} mode={p.cfg.mode} builtAt={p.cfg.builtAt} polls="Read once when the page opens." retry={retry} className={barClass} />;
  return (
    <ShellFrame {...p} chips={<ChipRow label="Solvency" bar={bar} />}>
      <Panel id="solvency" title={`Solvency, ${MARKET_INFO[p.market].name} market`} note="What the contract owes, against the dollars it holds">
        <Solvency market={p.market} d={st.data} />
      </Panel>
    </ShellFrame>
  );
}

export function ReviewView(p: ShellProps & { review: ReactNode; sandbox: ReactNode }) {
  const [filter, setFilter] = useState<"all" | "open" | "stated" | "closed">("all");
  return (
    <ShellFrame
      {...p}
      chips={
        <ChipRow label="Review">
          {(["all", "open", "stated", "closed"] as const).map((f) => (
            <FilterChip key={f} on={filter === f} onClick={() => setFilter(f)}>
              {f === "all" ? "All findings" : f === "open" ? "Open" : f === "stated" ? "Stated limits" : "Closed"}
            </FilterChip>
          ))}
        </ChipRow>
      }
    >
      <p className="m-0 max-w-none border-b border-border bg-background/40 px-5 py-4 text-sm text-foreground">All three price reporters are run by one operator today, who can set any price. Nothing on chain checks a report against its data.</p>
      <div className="px-4 py-6 md:px-6" data-filter={filter === "all" ? undefined : filter}>
        {p.review}
      </div>
      <Panel id="sandbox" title="Contract against the engine" note="Run by the authors on a local test node">
        {p.sandbox}
      </Panel>
    </ShellFrame>
  );
}

export function RecordView(p: ShellProps & { record: ReactNode; count: number }) {
  return (
    <ShellFrame {...p} chips={<ChipRow label="Record"><Chip>{p.count} transactions</Chip><Chip>Grouped by what they did</Chip></ChipRow>}>
      <div className="px-4 py-6 md:px-6">{p.record}</div>
    </ShellFrame>
  );
}

