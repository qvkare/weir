"use client";
// The homepage below the hero: the sources ribbon, how it works in three cells, a bento of five
// objects read from the chain, the review wall and the "built by" block. Ours; every object is
// drawn from the window's own read (lib/data/front.ts) or from records in the repository.
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { bundleHash } from "@weir/index";
import { CLOSED, OPEN, STATED, specHref, type Finding } from "@/lib/audit.ts";
import { MARKET_INFO } from "@/lib/config.ts";
import type { FrontData } from "@/lib/data/front.ts";
import { dollarsOfPrice, fmtSpan, fmtUsd, fmtUtc, fmtUtcTime, shortAccount, shortHash } from "@/lib/format.ts";
import { longPayout } from "@/lib/payoff.ts";
import { stepOrdersFromResult } from "@/lib/views.ts";
import { cn } from "@/lib/utils.ts";

// ── Small shared pieces ──────────────────────────────────────────

export function Pill({ children, tone = "plain" }: { children: ReactNode; tone?: "plain" | "live" | "ok" | "flag" | "muted" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs",
        tone === "live" && "bg-foreground/[0.09] text-foreground",
        tone === "plain" && "text-foreground ring-1 ring-border",
        tone === "ok" && "text-foreground ring-1 ring-border",
        tone === "flag" && "text-flag ring-1 ring-[color-mix(in_srgb,var(--flag)_45%,transparent)]",
        tone === "muted" && "text-muted-foreground ring-1 ring-border",
      )}
    >
      {tone === "live" ? <span className="size-1.5 rounded-full bg-accent" aria-hidden="true" /> : null}
      {tone === "ok" ? <span className="size-1.5 rounded-full bg-foreground/70" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="m-0 mb-4 text-xs uppercase tracking-[0.12em] text-muted-foreground">{children}</p>;
}

/** The references' split heading: a serif heading at the left, a grey sentence at the right. */
function SplitHead({ eyebrow, title, sentence, id }: { eyebrow: string; title: ReactNode; sentence: ReactNode; id: string }) {
  return (
    <div className="reveal mb-12 grid gap-6 md:grid-cols-[1.1fr_1fr] md:items-end">
      <div>
        <Eyebrow>{eyebrow}</Eyebrow>
        <h2 id={id} className="font-display m-0 max-w-xl text-4xl text-foreground">
          {title}
        </h2>
      </div>
      <p className="m-0 max-w-md text-base text-muted-foreground md:justify-self-end">{sentence}</p>
    </div>
  );
}

function Shell({ id, label, children, className }: { id: string; label: string; children: ReactNode; className?: string }) {
  return (
    <section id={id} aria-labelledby={label} className={cn("py-20 md:py-28", className)}>
      <div className="mx-auto max-w-[1278px] px-6">{children}</div>
    </section>
  );
}

// ── The sources ribbon ───────────────────────────────────────────

const SOURCES = ["Vast.ai", "RunPod", "Akash", "Lium", "Verda", "Shadeform"];

export function SourcesRibbon() {
  return (
    <section aria-labelledby="sources-ribbon-h" className="border-y border-border py-12">
      <div className="mx-auto max-w-[1278px] px-6 text-center">
        <p id="sources-ribbon-h" className="m-0 mx-auto max-w-none text-xs text-muted-foreground">
          The index is computed from the public price lists of
        </p>
        <ul className="m-0 mt-5 flex list-none flex-wrap items-center justify-center gap-x-10 gap-y-3 p-0">
          {SOURCES.map((s) => (
            <li key={s} className="text-2xl font-medium tracking-[-0.02em] text-muted-foreground">
              {s}
            </li>
          ))}
        </ul>
        <p className="m-0 mx-auto mt-5 max-w-none text-xs text-muted-foreground">
          Prices only: no relationship with Weir is implied. Shadeform resells many clouds, and each counts as its own provider.{" "}
          <Link href={specHref("9")} className="text-foreground underline underline-offset-4">
            How the index is computed
          </Link>
        </p>
      </div>
    </section>
  );
}

// ── How it works, three cells ────────────────────────────────────

export function HowCells({ d }: { d: FrontData }) {
  const tick = d.params?.tick;
  const live = d.live;
  const cl = d.clearing;
  return (
    <Shell id="how" label="how-h">
      <SplitHead
        id="how-h"
        eyebrow="How it works"
        title={
          <>
            Sealed bids, one price, <span className="text-muted-foreground">paid in full.</span>
          </>
        }
        sentence="A round takes sealed commits, opens them together and clears them at one price. The index prints of the delivery week then settle every position."
      />
      <ol className="m-0 flex list-none flex-col gap-6 p-0 md:gap-24">
        <Cell n={1} title="Bids arrive sealed" text={<>A commit is a hash and a lock. Sides and prices stay hidden until the reveal{live?.round !== null && live ? `; this is round ${live.round} of series ${live.series} as read` : ""}.</>}>
          <div className="w-full max-w-[300px] space-y-2">
            {d.sealed.length === 0 ? (
              <p className="m-0 text-center text-sm text-muted-foreground">No commits yet in the round in progress.</p>
            ) : (
              d.sealed.slice(0, 4).map((c, i) => (
                <div key={c.seq} className={cn("flex items-center gap-3 rounded-lg bg-background/60 px-3 py-2 ring-1 ring-border", i > 1 && "opacity-70")}>
                  <span className="font-mono text-xs text-muted-foreground">#{c.seq}</span>
                  <span className="font-mono text-xs text-foreground">{c.hash ? shortHash(c.hash, 6, 4) : "no hash"}</span>
                  <span className="ml-auto font-mono text-xs text-muted-foreground">{fmtUsd(c.lock)}</span>
                  <Pill tone={c.state === "Revealed" ? "ok" : "muted"}>{c.state === "Committed" ? "sealed" : c.state.toLowerCase()}</Pill>
                </div>
              ))
            )}
          </div>
        </Cell>
        <Cell n={2} title="One price clears the round" text={cl && cl.result.price !== null ? <>Every filled order pays the price where the two sides meet: {dollarsOfPrice(cl.result.price, tick)} a GPU-hour for LONG in round {cl.round} of series {cl.series}, cleared {fmtUtcTime(cl.result.cleared_at)}.</> : <>Every filled order pays the price where the two sides meet. No round has cleared with a trade yet.</>}>
          {cl && cl.result.price !== null ? <Curves d={d} /> : null}
        </Cell>
        <Cell n={3} title="The week's prints settle it" text="The fixing is the average of the delivery week's index prints. A LONG unit is paid the fixing minus the floor, a SHORT unit the rest of the band.">
          <SettleMini />
        </Cell>
      </ol>
    </Shell>
  );
}

/** One step, a card. From md up the cards pin under the header in turn and slide over one another
 * (position: sticky, no script); on phones and under reduced motion they are a plain stack. */
function Cell({ n, title, text, children }: { n: number; title: string; text: ReactNode; children: ReactNode }) {
  return (
    <li className="how-card grid items-center gap-8 rounded-2xl bg-card p-6 ring-1 ring-border md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] md:p-10" style={{ ["--n" as string]: n - 1 }}>
      <div>
        <p className="m-0 font-mono text-xs text-muted-foreground">Step {n} of 3</p>
        <h3 className="font-display m-0 mt-3 text-3xl text-foreground">{title}</h3>
        <p className="m-0 mt-4 max-w-md text-base text-muted-foreground">{text}</p>
      </div>
      <div className="flex h-64 items-center justify-center rounded-xl bg-background/50 p-4 ring-1 ring-border" aria-hidden="true">
        {children}
      </div>
    </li>
  );
}

/** The cleared round's two curves, as filled: buyers from the highest price down, sellers from the lowest up. */
function Curves({ d }: { d: FrontData }) {
  const cl = d.clearing!;
  const orders = stepOrdersFromResult(cl.result);
  const longs = orders.filter((o) => o.side === "Long").sort((a, b) => b.price - a.price);
  const shorts = orders.filter((o) => o.side === "Short").sort((a, b) => a.price - b.price);
  const prices = orders.map((o) => o.price).concat(cl.result.price!);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const span = hi - lo || 1;
  const total = Math.max(longs.reduce((n, o) => n + o.size, 0), shorts.reduce((n, o) => n + o.size, 0), 1);
  const W = 260;
  const H = 170;
  const y = (p: number) => 15 + (1 - (p - lo) / span) * (H - 30);
  const x = (q: number) => 10 + (q / total) * (W - 20);
  const path = (list: typeof orders) => {
    let q = 0;
    let s = "";
    list.forEach((o, i) => {
      s += `${i ? "L" : "M"}${x(q).toFixed(1)} ${y(o.price).toFixed(1)}`;
      q += o.size;
      s += `L${x(q).toFixed(1)} ${y(o.price).toFixed(1)}`;
    });
    return s;
  };
  const py = y(cl.result.price!);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full max-w-[300px]">
      <path d={path(longs)} fill="none" stroke="var(--long)" strokeWidth={2} />
      <path d={path(shorts)} fill="none" stroke="var(--short)" strokeWidth={2} strokeDasharray="5 3" />
      <line x1={10} x2={W - 10} y1={py} y2={py} stroke="currentColor" strokeOpacity={0.5} strokeDasharray="2 3" className="text-foreground" />
      <circle cx={x(Math.min(cl.result.volume, total))} cy={py} r={4} className="fill-foreground" />
      <text x={W - 10} y={py - 6} textAnchor="end" className="fill-muted-foreground" style={{ fontSize: 11 }}>
        {dollarsOfPrice(cl.result.price!, d.params?.tick)} · {cl.result.volume} GPU-h
      </text>
    </svg>
  );
}

/** A worked example (the one /how uses): seven prints, their average, and what each side is paid. */
function SettleMini() {
  const floor = 2_000_000;
  const band = 800_000;
  const prints = [2_350_000, 2_450_000, 2_600_000, 2_700_000, 2_800_000, 2_500_000, 2_450_000];
  const fixing = Math.floor(prints.reduce((a, b) => a + b, 0) / prints.length);
  const lp = longPayout(fixing, floor, band);
  const W = 260;
  const H = 170;
  const y = (p: number) => 20 + (1 - (p - floor) / band) * 100;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full max-w-[300px]">
      <rect x={10} y={y(floor + band)} width={W - 20} height={y(floor) - y(floor + band)} rx={4} className="fill-foreground" fillOpacity={0.05} />
      {prints.map((p, i) => (
        <circle key={i} cx={30 + i * 33} cy={y(p)} r={3.5} className="fill-foreground" />
      ))}
      <line x1={10} x2={W - 10} y1={y(fixing)} y2={y(fixing)} stroke="currentColor" strokeDasharray="4 3" className="text-foreground" />
      <rect x={10} y={140} width={((W - 20) * lp) / band} height={14} rx={3} fill="var(--long)" />
      <rect x={10 + ((W - 20) * lp) / band} y={140} width={((W - 20) * (band - lp)) / band} height={14} rx={3} fill="var(--short)" fillOpacity={0.55} />
      <text x={W - 10} y={y(fixing) - 6} textAnchor="end" className="fill-muted-foreground" style={{ fontSize: 11 }}>
        worked example: fixing {dollarsOfPrice(fixing)}
      </text>
    </svg>
  );
}

// ── The bento ────────────────────────────────────────────────────

export function Bento({ d, agents }: { d: FrontData; agents: { account: string; role: string }[] }) {
  return (
    <Shell id="inside" label="inside-h">
      <SplitHead
        id="inside-h"
        eyebrow="Inside a market"
        title={
          <>
            What the chain shows, <span className="text-muted-foreground">read in this browser.</span>
          </>
        }
        sentence={`Five views of the ${MARKET_INFO[d.market].name} market, from the same read as the window above.`}
      />
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="md:col-span-2" textFirst title="The life of a round" text="Commit, reveal and clear repeat each round; delivery and settlement come once a series. The step the round is in now is lit.">
          <Flow d={d} />
        </Card>
        <Card title="Agents on this market" text="Four of the agents the deploy tool recorded for this market, with their latest action in the rounds above. Each trades with a key that cannot withdraw; the operator also holds a full-access key to each account.">
          <Agents d={d} agents={agents} />
        </Card>
        <Card title="Sources around the median" text={d.bundle ? `The last print's bundle: each provider's price at its distance from the median, ${fmtUtc(d.bundle.data.bucket)}.` : "The last print's bundle, when the bundle host answers."}>
          <Rings d={d} />
        </Card>
        <Card title="A print, checked here" text="The hash a reporter put on chain, against the hash of the bundle this browser fetched.">
          <HashCheck d={d} />
        </Card>
        <Card title="Last events on chain" text="Clearings and the last index print, newest first, as read.">
          <Timeline d={d} />
        </Card>
      </div>
    </Shell>
  );
}

function Card({ title, text, className, textFirst, children }: { title: string; text: string; className?: string; /** Title and sentence at the top, the object right under them. */ textFirst?: boolean; children: ReactNode }) {
  const words = (
    <>
      <h3 className={cn("m-0 text-lg font-medium text-foreground", !textFirst && "mt-6")}>{title}</h3>
      <p className="m-0 mt-2 max-w-none text-sm text-muted-foreground">{text}</p>
    </>
  );
  return (
    <div className={cn("flex flex-col rounded-2xl bg-card p-6 ring-1 ring-border md:p-7", className)}>
      {textFirst ? words : null}
      <div className={cn("flex flex-1 justify-center", textFirst ? "mt-8 items-stretch" : "min-h-56 items-center")}>{children}</div>
      {textFirst ? null : words}
    </div>
  );
}

function Flow({ d }: { d: FrontData }) {
  const live = d.live;
  const p = d.params;
  if (!live || !p) return <p className="m-0 text-sm text-muted-foreground">No series is in auction.</p>;
  const commit = live.phase === "Commit";
  const reveal = live.phase === "Reveal";
  const revealEnds = live.phase_ends_at === null ? null : commit ? live.phase_ends_at + p.reveal_secs : live.phase_ends_at;
  const steps: { name: string; when: string; state: "now" | "next" | "later" | "done" }[] = [
    { name: "Commit", when: commit && live.phase_ends_at ? `until ${fmtUtcTime(live.phase_ends_at)}` : "sealed orders", state: commit ? "now" : reveal ? "done" : "later" },
    { name: "Reveal", when: revealEnds ? `until ${fmtUtcTime(revealEnds)}` : "orders opened", state: reveal ? "now" : commit ? "next" : "later" },
    { name: "Clear", when: "one price, anyone may call", state: reveal ? "next" : "later" },
    { name: "Delivery", when: `from ${fmtUtcTime(live.delivery_start)}`, state: "later" },
    { name: "Settle", when: `from ${fmtUtcTime(live.delivery_end + p.report_grace_secs)}`, state: "later" },
  ];
  return (
    <div className="flex h-full w-full flex-col">
    <ol className="m-0 grid w-full list-none grid-cols-1 gap-3 p-0 sm:grid-cols-5 sm:gap-0">
      {steps.map((s, i) => (
        <li key={s.name} className="relative flex flex-col items-center text-center">
          {i ? <span aria-hidden="true" className="absolute right-1/2 top-6 hidden h-px w-full bg-border sm:block" /> : null}
          <span className={cn("relative z-10 grid size-12 place-items-center rounded-xl text-sm ring-1", s.state === "now" ? "bg-foreground text-background ring-foreground" : "bg-background text-foreground ring-border")}>{i + 1}</span>
          <span className="mt-3 text-sm font-medium text-foreground">{s.name}</span>
          <span className="mt-1 text-xs text-muted-foreground">{s.when}</span>
          <span className="mt-2">{s.state === "now" ? <Pill tone="live">Now, round {live.round}</Pill> : s.state === "next" ? <Pill>Next</Pill> : s.state === "done" ? <Pill tone="ok">Done, round {live.round}</Pill> : <Pill tone="muted">Later</Pill>}</span>
        </li>
      ))}
    </ol>
    <dl className="m-0 mt-auto grid gap-x-6 gap-y-2 border-t border-border pt-5 text-sm sm:grid-cols-3">
      <div>
        <dt className="text-xs text-muted-foreground">Series {live.series}, auctions</dt>
        <dd className="m-0 text-foreground">{fmtUtcTime(live.auction_open)} to {fmtUtcTime(live.auction_close)}</dd>
      </div>
      <div>
        <dt className="text-xs text-muted-foreground">Each round</dt>
        <dd className="m-0 text-foreground">{fmtSpan(p.commit_secs)} commit, {fmtSpan(p.reveal_secs)} reveal</dd>
      </div>
      <div>
        <dt className="text-xs text-muted-foreground">Delivery</dt>
        <dd className="m-0 text-foreground">{fmtUtcTime(live.delivery_start)} to {fmtUtcTime(live.delivery_end)}</dd>
      </div>
    </dl>
    </div>
  );
}

function Agents({ d, agents }: { d: FrontData; agents: { account: string; role: string }[] }) {
  if (agents.length === 0) return <p className="m-0 text-sm text-muted-foreground">No agents are recorded for this market.</p>;
  return (
    <ul className="m-0 w-full list-none space-y-2 p-0">
      {agents.slice(0, 4).map((a) => {
        const act = d.actions[a.account];
        return (
          <li key={a.account} className="flex items-center gap-3 rounded-lg bg-background/60 px-3 py-2 ring-1 ring-border">
            <span className="min-w-0">
              <span className="block truncate text-sm text-foreground" title={a.account}>
                {a.role} · <span className="font-mono text-xs text-muted-foreground">{shortAccount(a.account)}</span>
              </span>
              <span className="block truncate text-xs text-muted-foreground">{act ? `${act.what}, round ${act.round}` : "no action in the rounds read"}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Rings({ d }: { d: FrontData }) {
  const b = d.bundle?.data;
  if (!b || b.index === null) return <p className="m-0 text-sm text-muted-foreground">{d.bundleError ? `Bundle not fetched: ${d.bundleError}.` : "No bundle read yet."}</p>;
  const included = b.providers.filter((p) => p.status === "included" && typeof p.value === "number");
  const R = 92;
  return (
    <svg viewBox="-110 -110 220 220" className="h-56 w-56">
      {[1, 2, 3].map((k) => (
        <circle key={k} r={(R * k) / 3} fill="none" stroke="var(--border)" />
      ))}
      {included.map((p, i) => {
        const dev = Math.min(Math.abs(p.value! / b.index! - 1), 0.6);
        const r = 14 + (dev / 0.6) * (R - 14);
        const a = (i / included.length) * Math.PI * 2 - Math.PI / 2;
        return <circle key={p.id} cx={Math.cos(a) * r} cy={Math.sin(a) * r} r={4} className="fill-foreground" fillOpacity={p.source === "shadeform" ? 0.45 : 0.9} />;
      })}
      <text textAnchor="middle" y={4} className="fill-foreground" style={{ fontSize: 13 }}>
        {dollarsOfPrice(b.index)}
      </text>
      <text textAnchor="middle" y={98} className="fill-muted-foreground" style={{ fontSize: 9 }}>
        {included.length} providers · rings at 20%, 40%, 60%
      </text>
    </svg>
  );
}

function HashCheck({ d }: { d: FrontData }) {
  const onChain = d.print?.reports[0]?.bundle ?? null;
  const [mine, setMine] = useState<string | null>(null);
  useEffect(() => {
    setMine(null);
    if (!d.bundle) return;
    let gone = false;
    bundleHash(d.bundle.data).then((h) => !gone && setMine(h), () => !gone && setMine("failed"));
    return () => {
      gone = true;
    };
  }, [d.bundle]);
  const match = mine !== null && onChain !== null && mine === onChain;
  return (
    <div className="w-full space-y-3 font-mono text-xs">
      <Row label="On chain" value={onChain ? shortHash(onChain, 10, 6) : "no print"} />
      <Row label="Recomputed here" value={!d.bundle ? (d.bundleError ? "not published" : "no bundle") : mine === null ? "hashing…" : mine === "failed" ? "could not hash" : shortHash(mine, 10, 6)} />
      <div className="pt-1 font-sans">
        {!onChain ? (
          <Pill tone="muted">No print yet</Pill>
        ) : !d.bundle ? (
          d.bundleError ? <Pill tone="muted">Not published</Pill> : <Pill tone="muted">Not checked yet</Pill>
        ) : mine === null || mine === "failed" ? (
          <Pill tone="muted">Not checked yet</Pill>
        ) : match ? (
          <Pill tone="ok">The hashes match</Pill>
        ) : (
          <Pill tone="flag">The hashes do not match</Pill>
        )}
      </div>
      {onChain && !d.bundle && d.bundleError ? <p className="m-0 max-w-none font-sans text-xs text-muted-foreground">The bundle host has no file for this report, so it could not be checked. Not a failed check.</p> : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-background/60 px-3 py-2 ring-1 ring-border">
      <span className="font-sans text-muted-foreground">{label}</span>
      <span className="text-foreground">{value}</span>
    </div>
  );
}

function Timeline({ d }: { d: FrontData }) {
  const tick = d.params?.tick;
  const events: { at: number; text: string }[] = [];
  for (const r of d.rows) if (r.clearedAt !== null) events.push({ at: r.clearedAt, text: r.price !== null ? `Round ${r.round} cleared at ${dollarsOfPrice(r.price, tick)} LONG, ${r.volume} GPU-h` : `Round ${r.round} cleared with no trade` });
  if (d.print && d.print.price !== null) events.push({ at: d.print.bucket, text: `Index printed ${dollarsOfPrice(d.print.price, tick)} for the bucket from ${fmtUtcTime(d.print.bucket)}` });
  events.sort((a, b) => b.at - a.at);
  if (events.length === 0) return <p className="m-0 text-sm text-muted-foreground">No events read yet.</p>;
  return (
    <ol className="m-0 w-full list-none space-y-3 border-l border-border p-0 pl-4">
      {events.slice(0, 5).map((e, i) => (
        <li key={`${e.at}-${i}`} className="relative">
          <span aria-hidden="true" className={cn("absolute -left-[21px] top-1.5 size-2 rounded-full", i === 0 ? "bg-foreground" : "bg-foreground/30")} />
          <span className="block text-xs text-muted-foreground">{fmtUtcTime(e.at)}</span>
          <span className="block text-sm text-foreground">{e.text}</span>
        </li>
      ))}
    </ol>
  );
}

// ── The review wall ──────────────────────────────────────────────

const WALL: (Finding & { kind: "Open" | "Limit" | "Closed" })[] = [...OPEN.slice(0, 4).map((f) => ({ ...f, kind: "Open" as const })), ...STATED.slice(0, 2).map((f) => ({ ...f, kind: "Limit" as const })), ...CLOSED.slice(0, 3).map((f) => ({ ...f, kind: "Closed" as const }))];

export function ReviewWall({ passes, total }: { passes: number; total: number }) {
  return (
    <Shell id="review" label="review-h">
      <SplitHead
        id="review-h"
        eyebrow="The review"
        title={
          <>
            What the review found, <span className="text-muted-foreground">in its own words.</span>
          </>
        }
        sentence={`An AI reviewer's findings from ${passes} passes over the contract: not customers, and not an audit firm. Open ones first.`}
      />
      <p className="m-0 mb-8 max-w-none rounded-2xl bg-card p-6 text-base text-foreground ring-1 ring-border">
        All three price reporters are run by one operator today, who can set any price. Nothing on chain checks a report against its data.{" "}
        <Link href="/proof/review" className="text-foreground underline underline-offset-4">
          What you are trusting
        </Link>
      </p>
      <div className="gap-4 [column-fill:_balance] sm:columns-2 lg:columns-3">
        {WALL.map((f) => (
          <figure key={`${f.id}-${f.kind}`} className="m-0 mb-4 break-inside-avoid rounded-2xl bg-card p-6 ring-1 ring-border">
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone={f.kind === "Closed" ? "ok" : f.kind === "Open" ? "flag" : "plain"}>{f.kind === "Limit" ? "Open, a stated limit" : f.kind}</Pill>
              <Pill tone="muted">{f.severity}</Pill>
              <span className="ml-auto text-xs text-muted-foreground">Finding {f.id}, pass {f.id.split(".")[0]}</span>
            </div>
            <blockquote className="m-0 mt-4 text-base text-foreground">&ldquo;{f.finding}&rdquo;</blockquote>
            <figcaption className="mt-3 text-sm text-muted-foreground">{f.status}</figcaption>
          </figure>
        ))}
      </div>
      <p className="m-0 mt-6 text-sm text-muted-foreground">
        {WALL.length} of {total} findings, quoted from the <Link href="/audit">review record</Link>. The rest, with the tests that keep them, are on <Link href="/proof/review">Proof</Link>.
      </p>
    </Shell>
  );
}

// ── Built by ─────────────────────────────────────────────────────

const RESULTS = [
  { name: "Linea MCP", what: "MCP server that lets AI agents read wallets, send tokens, and call contracts on Linea.", place: "1st place", event: "Linea Dev Cook-Off", href: "https://x.com/lineabuild/status/1913222836056969581", link: "Announcement" },
  { name: "Mirror Search", what: "Privacy preserving search tool running in WebAssembly on Bless Network's shared compute layer.", place: "1st place", event: "Bless Network Genesis Hackathon", href: "https://x.com/theblessnetwork/status/1935370517336440866", link: "Announcement" },
  { name: "Copil", what: "AI powered DeFi copilot that automates cross-chain strategies with Chainlink Automation.", place: "2nd place", event: "Chainlink Chromion Hackathon", href: "https://www.youtube.com/live/xuGBbwtmjFc?t=957", link: "Recording" },
];

const ext = { target: "_blank", rel: "noopener" } as const;

export function BuiltBy() {
  return (
    <Shell id="maker" label="maker-h">
      <h2 id="maker-h" className="font-display m-0 mb-12 max-w-3xl text-4xl text-foreground">
        Built by Qvkare. <span className="text-muted-foreground">His earlier results, as listed on qvkare.com.</span>
      </h2>
      <div className="grid gap-4 md:grid-cols-[320px_minmax(0,1fr)]">
        <div className="flex flex-col items-start rounded-2xl bg-card p-6 ring-1 ring-border md:p-8">
          <img src="/maker/qvkare.png" alt="Qvkare's pixel-art portrait" width={112} height={112} className="size-28 rounded-xl ring-1 ring-border [image-rendering:pixelated]" />
          <p className="m-0 mt-5 text-2xl font-medium text-foreground">Qvkare</p>
          <p className="m-0 mt-1 text-sm text-muted-foreground">Blocks &amp; pixel maxi</p>
          <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-sm">
            <a href="https://qvkare.com" {...ext} className="text-foreground underline underline-offset-4">
              qvkare.com
            </a>
            <a href="https://github.com/qvkare" {...ext} className="text-foreground underline underline-offset-4">
              GitHub
            </a>
            <a href="https://x.com/Qvkare" {...ext} className="text-foreground underline underline-offset-4">
              X
            </a>
          </div>
        </div>
        <ul className="m-0 grid list-none gap-4 p-0">
          {RESULTS.map((r) => (
            <li key={r.name} className="flex flex-col gap-3 rounded-2xl bg-card p-6 ring-1 ring-border sm:flex-row sm:items-start">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-lg font-medium text-foreground">{r.name}</span>
                  <Pill tone="plain">{r.place}</Pill>
                </div>
                <p className="m-0 mt-2 max-w-none text-sm text-muted-foreground">{r.what}</p>
                <p className="m-0 mt-1 text-sm text-foreground">{`${r.place}, ${r.event}.`}</p>
              </div>
              <a href={r.href} {...ext} className="shrink-0 text-sm text-foreground underline underline-offset-4">
                {r.link}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </Shell>
  );
}
