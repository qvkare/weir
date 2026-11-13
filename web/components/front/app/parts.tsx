"use client";
// The Weir application frame: sidebar, title row, chip row and main area. The homepage's window
// and every market page (lib/app-views.ts) are built from these same parts, so the picture on
// the homepage is the application itself. Ours, not from a registry.
import Link from "next/link";
import type { ReactNode } from "react";
import { Countdown } from "@/components/countdown.tsx";
import { viewsFor, type AppView } from "@/lib/app-views.ts";
import { MARKET_IDS, MARKET_INFO, withMarket, type MarketId } from "@/lib/config.ts";
import type { FrontChip, FrontRow } from "@/lib/data/front.ts";
import { dollarsOfPrice, fmtGpuH, fmtUsd, fmtUtcTime } from "@/lib/format.ts";
import { cn } from "@/lib/utils.ts";
import type { WireLiveSeries } from "@weir/engine";

export const SHORT_NAME: Record<MarketId, string> = { "h100-weekly": "H100 weekly", "h100-fast": "H100 hourly", "h200-weekly": "H200 weekly", "a100-80-weekly": "A100 80 GB weekly" };

export interface FrameProps {
  /** The sidebar. */
  sidebar: ReactNode;
  /** The phone's top selectors (the sidebar is hidden below 768 px). */
  phoneNav?: ReactNode;
  title: ReactNode;
  chips?: ReactNode;
  children: ReactNode;
  /** As tall as the viewport allows, the main area scrolling inside (the market pages); "embed": a fixed 640 px (the homepage's tabs); else as tall as its content. */
  fill?: boolean | "embed";
}

export function Frame({ sidebar, phoneNav, title, chips, children, fill }: FrameProps) {
  const mode = fill === true ? "page" : fill === "embed" ? "embed" : undefined;
  // Bounded frames (app/site.css, "The application frame"): the main area is the scroll
  // container, reachable with Tab and scrolled with the arrow keys; the sidebar scrolls on its own.
  return (
    <div data-app-frame={mode ?? "content"} className="app-frame relative overflow-hidden rounded-xl border border-border bg-card text-left shadow-[0_1px_0_0_color-mix(in_srgb,var(--foreground)_6%,transparent)_inset,0_40px_90px_-30px_rgba(0,0,0,0.55),0_12px_30px_-12px_rgba(0,0,0,0.35)]">
      <div className={cn("app-frame-grid grid", sidebar && "md:grid-cols-[236px_minmax(0,1fr)]")}>
        {sidebar}
        <div className="app-frame-col flex min-w-0 flex-col">
          {phoneNav}
          {title}
          {chips}
          <div data-frame-main="" className="app-frame-main relative min-h-0 flex-1" {...(mode ? { tabIndex: 0, role: "region", "aria-label": "View content" } : {})}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Sidebar ──────────────────────────────────────────────────────

export interface SidebarProps {
  network: string;
  chips: FrontChip[];
  selected: MarketId;
  /** The view on screen: switching market keeps it. */
  view: AppView;
  /** Switches the market in place (the homepage's window, reading the chain); else each market is a link. */
  onSelect?: ((m: MarketId) => void) | null;
}

export function Sidebar({ network, chips, selected, view, onSelect }: SidebarProps) {
  return (
    <aside className="hidden min-h-0 overflow-y-auto border-r border-border bg-background/40 p-3 md:block" aria-label="Markets and views">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <span className="grid size-6 place-items-center rounded-md bg-foreground text-xs font-medium text-background">W</span>
        <span className="text-sm font-medium text-foreground">Weir</span>
        <span className="ml-auto rounded-md px-1.5 text-xs text-muted-foreground ring-1 ring-border">{network}</span>
      </div>
      <Group title="Markets · last index print, $/GPU-h">
        {MARKET_IDS.map((m) => {
          const c = chips.find((x) => x.market === m);
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
            <Link key={m} href={withMarket(view.path, m)} className={cls} aria-current={m === selected ? "true" : undefined}>
              {body}
            </Link>
          );
        })}
      </Group>
      {(["Views", "Proof"] as const).map((g) => (
        <Group key={g} title={g}>
          {viewsFor(selected).filter((v) => v.group === g).map((v) => (
            <NavItem key={v.id} icon={ICONS[v.id]} href={withMarket(v.path, selected)} current={v.id === view.id}>
              {v.label}
            </NavItem>
          ))}
        </Group>
      ))}
      <Group title="Network">
        <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
          <span className="size-1.5 rounded-full bg-foreground/60" aria-hidden="true" /> NEAR {network}
        </div>
        <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
          <span className="size-1.5 rounded-full bg-foreground/30" aria-hidden="true" /> Test dollars, no real money
        </div>
      </Group>
    </aside>
  );
}

/** Below 768 px: two selectors in place of the sidebar. They navigate to the chosen market's or view's page. */
export function PhoneNav({ selected, view }: { selected: MarketId; view: AppView }) {
  const go = (href: string) => {
    window.location.assign(href);
  };
  // A view the sidebar does not list for this market (the test bid on a weekly market) stays selectable while shown.
  const listed = viewsFor(selected);
  const views = listed.some((v) => v.id === view.id) ? listed : [...listed, view];
  return (
    <div className="grid grid-cols-2 gap-2 border-b border-border p-3 md:hidden">
      <label className="grid gap-1 text-xs text-muted-foreground">
        Market
        <select className="h-9 rounded-md bg-background px-2 text-sm text-foreground ring-1 ring-border" value={selected} onChange={(e) => go(withMarket(view.path, e.target.value as MarketId))}>
          {MARKET_IDS.map((m) => (
            <option key={m} value={m}>
              {SHORT_NAME[m]}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-xs text-muted-foreground">
        View
        <select className="h-9 rounded-md bg-background px-2 text-sm text-foreground ring-1 ring-border" value={view.id} onChange={(e) => go(withMarket(views.find((v) => v.id === e.target.value)!.path, selected))}>
          {views.map((v) => (
            <option key={v.id} value={v.id}>
              {v.group === "Proof" ? `Proof: ${v.label}` : v.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

// ── Title and chip rows ──────────────────────────────────────────

/** `frozen`: a copy shown as of publication (the homepage's four views), so no clock runs. */
export function TitleRow({ market, live, now, wall, action, frozen }: { market: MarketId; live: WireLiveSeries | null; now: number; wall: boolean; action?: ReactNode; frozen?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3 md:px-5">
      <span className="text-sm font-medium text-foreground">
        {SHORT_NAME[market]}
        {live ? <span className="text-muted-foreground"> · series {live.series}</span> : null}
      </span>
      {live && live.round !== null && live.phase_ends_at ? (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs text-foreground">
          <span className="size-1.5 rounded-full bg-accent" aria-hidden="true" />
          {frozen ? (
            <>Round {live.round}, {live.phase === "Commit" ? "commit" : "reveal"} phase to {fmtUtcTime(live.phase_ends_at)}</>
          ) : (
            <>
              Round {live.round}, {live.phase === "Commit" ? "commit" : "reveal"} ends in <Countdown endsAt={live.phase_ends_at} serverNow={now} wall={wall} className="font-mono" />
            </>
          )}
        </span>
      ) : live ? (
        <span className="rounded-full px-2 py-0.5 text-xs text-muted-foreground ring-1 ring-border">Between rounds</span>
      ) : null}
      {action ? <span className="ml-auto">{action}</span> : null}
    </div>
  );
}

export function ChipRow({ label, children, bar }: { label: string; children?: ReactNode; bar?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5 md:px-5">
      <span className="text-sm text-foreground">{label}</span>
      {children ? <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" /> : null}
      {children}
      {bar ? <div className="ml-auto max-w-md basis-full lg:basis-auto">{bar}</div> : null}
    </div>
  );
}

/** A label for what the grid shows. Not a control: it does nothing when pressed. */
export function Chip({ children }: { children: ReactNode }) {
  return <span className="inline-flex h-7 items-center rounded-md px-2.5 text-xs text-muted-foreground ring-1 ring-border">{children}</span>;
}

/** A chip that is a control: a filter the view applies. */
export function FilterChip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={cn("inline-flex h-7 cursor-pointer items-center rounded-md border-0 px-2.5 font-sans text-xs ring-1 transition-colors", on ? "bg-foreground/[0.09] text-foreground ring-foreground/30" : "bg-transparent text-muted-foreground ring-border hover:text-foreground")}>
      {children}
    </button>
  );
}

export const smallButton = "inline-flex h-8 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground no-underline hover:opacity-90";

// ── The rounds grid ──────────────────────────────────────────────

export function RoundsTable({ rows, tick, showSeries, empty, fade, selected, hrefOf }: { rows: FrontRow[]; tick: number | undefined; showSeries: boolean; empty: ReactNode; fade?: boolean; selected?: string | null; hrefOf?: (r: FrontRow) => string | null }) {
  return (
    <div className="relative">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[780px] border-collapse text-sm">
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
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="h-[440px] px-5 text-center text-sm text-muted-foreground">
                  {empty}
                </td>
              </tr>
            ) : (
              rows.map((r) => <RoundRow key={`${r.series}-${r.round}`} r={r} tick={tick} showSeries={showSeries} on={selected === `${r.series}-${r.round}`} href={hrefOf?.(r) ?? null} />)
            )}
          </tbody>
        </table>
      </div>
      {fade ? <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-card to-transparent" /> : null}
    </div>
  );
}

function RoundRow({ r, tick, showSeries, on, href }: { r: FrontRow; tick: number | undefined; showSeries: boolean; on: boolean; href: string | null }) {
  const open = r.state === "Committing" || r.state === "Revealing";
  const round = (
    <>
      <span className="font-mono text-foreground">{r.round}</span>
      {showSeries ? <span className="text-muted-foreground"> · s{r.series}</span> : null}
    </>
  );
  return (
    <tr className={cn("border-t border-border hover:bg-muted/40", on && "bg-foreground/[0.06]")}>
      <Td>{href ? <a href={href} className="no-underline hover:underline" aria-current={on ? "true" : undefined}>{round}</a> : round}</Td>
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

export const Dash = () => <span className="text-muted-foreground">&ndash;</span>;

export function Th({ children, right }: { children: ReactNode; right?: boolean }) {
  return <th className={cn("whitespace-nowrap border-b border-border px-2.5 py-2.5 font-sans text-xs font-normal normal-case tracking-normal text-muted-foreground first:pl-5", right ? "text-right" : "text-left")}>{children}</th>;
}

export function Td({ children, right, className }: { children: ReactNode; right?: boolean; className?: string }) {
  return <td className={cn("whitespace-nowrap border-b-0 px-2.5 py-2.5 align-middle font-sans text-sm first:pl-5", right ? "text-right" : "text-left", className)}>{children}</td>;
}

export function Group({ title, children }: { title: string; children: ReactNode }) {
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

/** A labelled panel inside a view's main area. */
export function Panel({ title, note, id, children, className }: { title: ReactNode; note?: ReactNode; id?: string; children: ReactNode; className?: string }) {
  return (
    <section id={id} className={cn("border-b border-border px-4 py-6 last:border-b-0 md:px-6", className)}>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="m-0 text-lg font-medium text-foreground">{title}</h2>
        {note ? <span className="text-xs text-muted-foreground">{note}</span> : null}
      </div>
      {children}
    </section>
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
const ICONS: Record<string, ReactNode> = {
  round: (
    <I>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3l2 1.5" />
    </I>
  ),
  book: (
    <I>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </I>
  ),
  clearings: (
    <I>
      <path d="M5.5 4.5h7M5.5 8h7M5.5 11.5h7M3 4.5h.01M3 8h.01M3 11.5h.01" />
    </I>
  ),
  prints: (
    <I>
      <path d="M2.5 12.5h11M3.5 10l3-3 2.5 2 4-4.5" />
    </I>
  ),
  try: (
    <I>
      <rect x="2.5" y="4" width="11" height="8" rx="1.5" />
      <path d="M5.5 8h5M8.5 6l2 2-2 2" />
    </I>
  ),
  agents: (
    <I>
      <circle cx="6" cy="6" r="2.5" />
      <path d="M8.5 6h5v2M11.5 6v1.5M2.5 13c.5-2 2-3 3.5-3s3 1 3.5 3" />
    </I>
  ),
  contracts: (
    <I>
      <path d="M4 2.5h6l2.5 2.5v8.5H4z" />
      <path d="M6 7h4.5M6 9.5h4.5" />
    </I>
  ),
  solvency: (
    <I>
      <path d="M8 2.5v11M3 5.5h10M3 5.5l-1.5 4h3zM13 5.5l-1.5 4h3z" />
    </I>
  ),
  review: (
    <I>
      <path d="M8 2l5 2v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4z" />
      <path d="M5.8 8.2l1.6 1.6 3-3.2" />
    </I>
  ),
  record: (
    <I>
      <rect x="3" y="2.5" width="10" height="11" rx="1.5" />
      <path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" />
    </I>
  ),
};
