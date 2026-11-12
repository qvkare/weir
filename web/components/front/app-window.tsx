"use client";
// The product picture under the hero: Weir as an application window, read from the chain (the
// build's figures first, labelled). Ours, not from a registry; the proportions follow the
// reference the owner chose (a sidebar, a title row, filter chips, a data grid that fades out).
// The two side colours appear only on a buyer's or a seller's value.
import Link from "next/link";
import type { ReactNode } from "react";
import { Countdown } from "@/components/countdown.tsx";
import { MARKET_IDS, MARKET_INFO, withMarket, type MarketId } from "@/lib/config.ts";
import type { FrontData, FrontRow } from "@/lib/data/front.ts";
import { dollarsOfPrice, fmtGpuH, fmtUsd, fmtUtcTime } from "@/lib/format.ts";
import { cn } from "@/lib/utils.ts";

export interface AppWindowProps {
  d: FrontData;
  /** The market the window shows; while it is being read, d may still be the previous one. */
  selected: MarketId;
  /** Switches the window in place (chain mode); null: each market is a link instead. */
  onSelect: ((m: MarketId) => void) | null;
  wall: boolean;
  network: string;
  /** The live-read line (components/live.tsx). */
  bar: ReactNode;
}

const SHORT_NAME: Record<MarketId, string> = { "h100-weekly": "H100 weekly", "h100-fast": "H100 hourly", "h200-weekly": "H200 weekly", "a100-80-weekly": "A100 80 GB weekly" };

export function AppWindow({ d, selected, onSelect, wall, network, bar }: AppWindowProps) {
  const reading = d.market !== selected;
  const tick = d.params?.tick;
  const live = d.live;
  const series = live?.series ?? null;
  const spansTwo = d.rows.some((r) => r.series !== series);
  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-card text-left shadow-[0_1px_0_0_color-mix(in_srgb,var(--foreground)_6%,transparent)_inset,0_40px_90px_-30px_rgba(0,0,0,0.55),0_12px_30px_-12px_rgba(0,0,0,0.35)]">
      <div className="grid md:grid-cols-[236px_minmax(0,1fr)]">
        {/* Sidebar */}
        <aside className="hidden border-r border-border bg-background/40 p-3 md:block" aria-label="Markets and views">
          <div className="flex items-center gap-2 px-2 py-1.5">
            <span className="grid size-6 place-items-center rounded-md bg-foreground text-xs font-medium text-background">W</span>
            <span className="text-sm font-medium text-foreground">Weir</span>
            <span className="ml-auto rounded-md px-1.5 text-xs text-muted-foreground ring-1 ring-border">{network}</span>
          </div>
          <Group title="Markets · last index print, $/GPU-h">
            {MARKET_IDS.map((m) => {
              const c = d.chips.find((x) => x.market === m);
              const body = (
                <>
                  <ChipIcon />
                  <span className="truncate">{SHORT_NAME[m]}</span>
                  <span className="ml-auto font-mono text-xs text-muted-foreground">{c?.last ? dollarsOfPrice(c.last.price, c.tick ?? undefined) : "none"}</span>
                </>
              );
              const cls = cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground no-underline transition-colors hover:bg-foreground/[0.06]", m === selected && "bg-foreground/[0.09] font-medium ring-1 ring-border");
              return onSelect ? (
                <button key={m} type="button" className={cn(cls, "cursor-pointer border-0 bg-transparent text-left font-sans")} aria-pressed={m === selected} onClick={() => onSelect(m)}>
                  {body}
                </button>
              ) : (
                <Link key={m} href={withMarket("/", m)} className={cls} aria-current={m === selected ? "true" : undefined}>
                  {body}
                </Link>
              );
            })}
          </Group>
          <Group title="Views">
            <NavItem icon={<ClockIcon />} href={withMarket("/auction", selected)}>
              Round in progress
            </NavItem>
            <NavItem icon={<LockIcon />} href={withMarket("/auction", selected) + "#book-h"}>
              Sealed book
            </NavItem>
            <NavItem icon={<ListIcon />} href={withMarket("/auction", selected) + "#recent-h"} current>
              Clearings
            </NavItem>
            <NavItem icon={<ChartIcon />} href={withMarket("/proof", selected) + "#index"}>
              Index prints
            </NavItem>
            <NavItem icon={<CheckIcon />} href={withMarket("/proof", selected)}>
              Proof
            </NavItem>
          </Group>
          <Group title="Network">
            <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
              <span className="size-1.5 rounded-full bg-foreground/60" aria-hidden="true" /> NEAR {network}
            </div>
            <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
              <span className="size-1.5 rounded-full bg-foreground/30" aria-hidden="true" /> Test dollars, no real money
            </div>
          </Group>
        </aside>

        {/* Main */}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3 md:px-5">
            <span className="text-sm font-medium text-foreground">
              {SHORT_NAME[selected]}
              {series !== null && !reading ? <span className="text-muted-foreground"> · series {series}</span> : null}
            </span>
            {live && live.round !== null && live.phase_ends_at && !reading ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs text-foreground">
                <span className="size-1.5 rounded-full bg-accent" aria-hidden="true" />
                Round {live.round}, {live.phase === "Commit" ? "commit" : "reveal"} ends in <Countdown endsAt={live.phase_ends_at} serverNow={d.now} wall={wall} className="font-mono" />
              </span>
            ) : null}
            <Link href={withMarket("/auction", selected)} className="ml-auto inline-flex h-8 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground no-underline hover:opacity-90">
              Open the auction
            </Link>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5 md:px-5">
            <span className="text-sm text-foreground">Clearings</span>
            <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
            <Chip>Newest first</Chip>
            {series !== null && !reading ? <Chip>{spansTwo ? `Series ${series} and ${series - 1}` : `Series ${series}`}</Chip> : null}
            <Chip>Last {Math.max(d.rows.length, 1)} rounds</Chip>
            <div className="ml-auto hidden max-w-md lg:block">{bar}</div>
          </div>
          <div className="relative">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] border-collapse text-sm">
                <thead>
                  <tr>
                    <Th>Round</Th>
                    <Th>State</Th>
                    <Th right>Long price, $/GPU-h</Th>
                    <Th right>Forward, $/GPU-h</Th>
                    <Th right>Volume, GPU-h</Th>
                    <Th right>Commits (revealed)</Th>
                    <Th right>Fees, $</Th>
                    <Th>Cleared, UTC</Th>
                  </tr>
                </thead>
                <tbody>
                  {reading ? (
                    <tr>
                      <td colSpan={8} className="h-[440px] px-5 text-center text-sm text-muted-foreground">
                        Reading {SHORT_NAME[selected]} from NEAR {network}&hellip;
                      </td>
                    </tr>
                  ) : d.rows.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="h-[440px] px-5 text-center text-sm text-muted-foreground">
                        {d.kind === "none" ? `The ${MARKET_INFO[selected].name} market is not deployed yet.` : d.error ? `Could not read the chain: ${d.error}` : "No round has been held yet."}
                      </td>
                    </tr>
                  ) : (
                    d.rows.map((r) => <Row key={`${r.series}-${r.round}`} r={r} tick={tick} showSeries={spansTwo} />)
                  )}
                </tbody>
              </table>
            </div>
            <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-card to-transparent" />
          </div>
          <div className="border-t border-border px-4 py-2 lg:hidden">{bar}</div>
        </div>
      </div>
    </div>
  );
}

function Row({ r, tick, showSeries }: { r: FrontRow; tick: number | undefined; showSeries: boolean }) {
  const open = r.state === "Committing" || r.state === "Revealing";
  return (
    <tr className="border-t border-border hover:bg-muted/40">
      <Td>
        <span className="font-mono text-foreground">{r.round}</span>
        {showSeries ? <span className="text-muted-foreground"> · s{r.series}</span> : null}
      </Td>
      <Td>
        <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs", open ? "bg-muted text-foreground" : r.state === "Cleared" ? "text-foreground ring-1 ring-border" : "text-muted-foreground ring-1 ring-border")}>
          <span className={cn("size-1.5 rounded-full", open ? "bg-accent" : r.state === "Cleared" ? "bg-foreground/70" : "bg-foreground/25")} aria-hidden="true" />
          {r.state}
        </span>
      </Td>
      <Td right>{r.price !== null ? <span className="font-mono text-long">{dollarsOfPrice(r.price, tick)}</span> : <Dash />}</Td>
      <Td right>{r.forward !== null ? <span className="font-mono text-foreground">{dollarsOfPrice(r.forward, tick)}</span> : <Dash />}</Td>
      <Td right>{r.volume !== null ? <span className="font-mono text-foreground">{fmtGpuH(r.volume).replace(/ GPU-h$/, "")}</span> : <Dash />}</Td>
      <Td right>
        <span className="font-mono text-foreground">{r.commits}</span> <span className="text-muted-foreground">({r.revealed})</span>
      </Td>
      <Td right>
        {open && r.commits === 0 ? (
          <Dash />
        ) : (
          <>
            <span className="font-mono text-foreground">{fmtUsd(r.fees).replace(/^\$/, "")}</span>
            {open ? <span className="text-muted-foreground"> held</span> : null}
          </>
        )}
      </Td>
      <Td>{r.clearedAt !== null ? <span className="text-muted-foreground">{fmtUtcTime(r.clearedAt).replace(/ UTC$/, "")}</span> : <span className="text-muted-foreground">{r.locked !== null && r.commits > 0 ? `open, ${fmtUsd(r.locked)} locked` : "open"}</span>}</Td>
    </tr>
  );
}

const Dash = () => <span className="text-muted-foreground">&ndash;</span>;

function Th({ children, right }: { children: ReactNode; right?: boolean }) {
  return <th className={cn("whitespace-nowrap border-b border-border px-3 py-2.5 font-sans text-xs font-normal normal-case tracking-normal text-muted-foreground first:pl-5", right ? "text-right" : "text-left")}>{children}</th>;
}

function Td({ children, right }: { children: ReactNode; right?: boolean }) {
  return <td className={cn("whitespace-nowrap border-b-0 px-3 py-2.5 align-middle font-sans text-sm first:pl-5", right ? "text-right" : "text-left")}>{children}</td>;
}

function Chip({ children }: { children: ReactNode }) {
  return <span className="inline-flex h-7 items-center rounded-md px-2.5 text-xs text-muted-foreground ring-1 ring-border">{children}</span>;
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-4">
      <p className="m-0 px-2 pb-1 text-xs text-muted-foreground">{title}</p>
      <div className="grid gap-0.5">{children}</div>
    </div>
  );
}

function NavItem({ icon, href, current, children }: { icon: ReactNode; href: string; current?: boolean; children: ReactNode }) {
  return (
    <Link href={href} aria-current={current ? "page" : undefined} className={cn("flex items-center gap-2 rounded-md px-2 py-1.5 text-sm no-underline transition-colors hover:bg-foreground/[0.06]", current ? "bg-foreground/[0.09] font-medium text-foreground ring-1 ring-border" : "text-muted-foreground")}>
      {icon}
      {children}
    </Link>
  );
}

// Small icons, drawn here: 14 px, the current text colour.
const I = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 16 16" className="size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden="true">
    {children}
  </svg>
);
const ChipIcon = () => (
  <I>
    <rect x="4" y="4" width="8" height="8" rx="1.5" />
    <path d="M6 2v2M10 2v2M6 12v2M10 12v2M2 6h2M2 10h2M12 6h2M12 10h2" />
  </I>
);
const ClockIcon = () => (
  <I>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 5v3l2 1.5" />
  </I>
);
const LockIcon = () => (
  <I>
    <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
    <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
  </I>
);
const ListIcon = () => (
  <I>
    <path d="M5.5 4.5h7M5.5 8h7M5.5 11.5h7M3 4.5h.01M3 8h.01M3 11.5h.01" />
  </I>
);
const ChartIcon = () => (
  <I>
    <path d="M2.5 12.5h11M3.5 10l3-3 2.5 2 4-4.5" />
  </I>
);
const CheckIcon = () => (
  <I>
    <path d="M8 2l5 2v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4z" />
    <path d="M5.8 8.2l1.6 1.6 3-3.2" />
  </I>
);
