"use client";
// The homepage: six sections, one job each. The hero and the market window; the problem in one
// measured figure; how it works; the three markets; how to check it, with what you are trusting;
// a closing call. Figures are the build's until this browser has read the chain, and say so.
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { LiveBar, useLive } from "@/components/live.tsx";
import { clientSource } from "@/lib/client-source.ts";
import { CHIP_KEYS, CHIP_LABEL, MARKET_INFO, marketsOfChip, withMarket, type ChipKey, type MarketId } from "@/lib/config.ts";
import { frontKey, frontProbe, loadFront, type FrontData } from "@/lib/data/front.ts";
import { dollarsOfPrice, fmtUtc, fmtUtcTime } from "@/lib/format.ts";
import type { SiteConfig } from "@/lib/site-config.ts";
import { buttonClass } from "../ui/button.ts";
import { GroupedFaq } from "./grouped-faq.tsx";
import { Hero } from "./hero.tsx";
import { AppWindow } from "./app-window.tsx";
import { ScrollTextRise } from "./scroll-text-rise.tsx";
import { Bento, BuiltBy, HowCells, ReviewWall, SourcesRibbon } from "./lower.tsx";

export interface FrontProps {
  cfg: SiteConfig;
  /** The market this homepage is for (/ or /m/<market>). */
  page: MarketId;
  /** The window's first market, as the build read it, with every market's last print. */
  initial: FrontData;
  /** Every market the sidebar lists. */
  chipMarkets: MarketId[];
  /** The backdrop behind the window (server-drawn), and the line saying what it is. */
  backdrop: ReactNode;
  backdropNote: string | null;
  /** The same backdrop again, behind the closing call to action. */
  closeBackdrop: ReactNode;
  /** The agents the deploy tool recorded (account, market, role). */
  agents: { account: string; market: string; role: string }[];
  /** How many findings the review record lists. */
  findings: number;
  offered: MarketId[];
  /** One line of specs per chip, from lib/hardware.ts. */
  specs: Record<ChipKey, string>;
  /** The backtest's measured spread of weekly moves; null when its results are missing. */
  moves: { weeks: number; min: number; max: number; first: string; last: string } | null;
  /** The reviewer's number of passes (lib/audit.ts). */
  passes: number;
}

/** Anchors the homepage used to have, and where their content lives now. */
const MOVED: Record<string, string> = { round: "/how#round", room: "/how#room", hedge: "/how#hedge", series: "/auction#series", clearing: "/auction", index: "/proof#index", sources: "/proof#sources", hardware: "#markets" };

export function Front({ cfg, page, initial, chipMarkets, offered, specs, moves, passes, backdrop, backdropNote, closeBackdrop, agents, findings }: FrontProps) {
  const market = page;
  // The window's market: switched in place when this browser reads the chain itself.
  const [sel, setSel] = useState<MarketId>(initial.market);
  // An old link to a section that moved goes to its new place.
  useEffect(() => {
    const to = MOVED[location.hash.slice(1)];
    if (!to) return;
    if (to.startsWith("#")) location.hash = to;
    else location.replace(withMarket(to.split("#")[0]!, market) + (to.includes("#") ? `#${to.split("#")[1]}` : ""));
  }, [market]);
  const pollSecs = MARKET_INFO[sel].cadence === "Hourly" ? 15 : 30;
  const [st, retry] = useLive<FrontData>({
    initial,
    initialAt: cfg.builtAt * 1000,
    mode: cfg.mode,
    load: async () => {
      const own = clientSource(cfg, sel);
      const d = await loadFront(own, chipMarkets.map((m) => (m === sel ? own : clientSource(cfg, m))), cfg.bundlesBase);
      if (d.error) throw new Error(d.error);
      return d;
    },
    probe: () => frontProbe(clientSource(cfg, sel)),
    keyOf: frontKey,
    pollSecs,
    deps: [sel],
  });
  const d = st.data;
  const live = st.from === "live" && d.market === sel;
  const auction = withMarket("/auction", sel);
  const bar = <LiveBar st={st} mode={cfg.mode} builtAt={cfg.builtAt} polls={`Checks the round every ${pollSecs} s while this tab is visible.`} retry={retry} className="m-0 max-w-xl flex-nowrap items-baseline border-0 bg-transparent p-0 font-sans text-xs text-muted-foreground" />;

  return (
    <main id="main" className="bg-background">
      <Hero
        pill={<Pill d={d} live={live} network={cfg.network} />}
        pillHref={auction}
        title={
          <>
            Next week&rsquo;s GPU hours,
            <br />
            <span className="text-muted-foreground">priced today.</span>
          </>
        }
        description="Teams that need compute and people who own GPUs bid once, sealed. One price clears for everyone filled, and every position is paid in full when it opens."
        primaryAction={{ href: auction, label: "See the live round" }}
        secondaryAction={{ href: withMarket("/how", market), label: "How it works" }}
      >
        <div className="relative">
          <div aria-hidden="true" className="pointer-events-none absolute -top-[300px] left-1/2 h-[1150px] w-[max(1600px,100vw)] -translate-x-1/2">
            {backdrop}
          </div>
          <div className="relative">
            <AppWindow d={d} selected={sel} onSelect={cfg.mode === "chain" ? setSel : null} wall={!live} network={cfg.network} bar={bar} />
          </div>
          {backdropNote ? <p className="relative m-0 mx-auto mt-4 max-w-none text-center text-xs text-muted-foreground">{backdropNote}</p> : null}
        </div>
      </Hero>

      <SourcesRibbon />

      {moves ? (
        <ScrollTextRise
          id="problem"
          label="The problem"
          text={`Over ${moves.weeks} delivery weeks, the weekly average price of an H100 hour ended between ${pct(moves.min)} and ${pct(moves.max)} against the price known 8 to 10 days before.`}
          note={
            <>
              Weir&rsquo;s backtest of its own index on public provider prices, delivery weeks from {moves.first} to {moves.last}. A reconstruction, not trades.{" "}
              <Link href="/backtest" className="text-foreground underline underline-offset-4">
                The backtest
              </Link>
            </>
          }
        />
      ) : null}

      <HowCells d={d} />

      <Bento d={d} agents={agents.filter((a) => a.market === d.market)} />

      <Section id="markets" lead="Three chips, a market each." rest="Each with its own index and its own auctions.">
        <div className="grid gap-4 md:grid-cols-3">
          {CHIP_KEYS.map((k) => d.chips.find((c) => MARKET_INFO[c.market].chip === k && MARKET_INFO[c.market].cadence === "Weekly") ?? d.chips.find((c) => MARKET_INFO[c.market].chip === k)).filter((c) => !!c).map((c) => {
            const chip = MARKET_INFO[c.market].chip;
            const others = marketsOfChip(chip, offered).filter((m) => m !== c.market);
            return (
              <div key={c.market} className="flex flex-col rounded-2xl bg-card p-6 ring-1 ring-border">
                <h3 className="m-0 text-2xl font-medium text-foreground">{CHIP_LABEL[chip]}</h3>
                <p className="m-0 mt-1 text-sm text-muted-foreground">{specs[chip]}</p>
                <p className="m-0 mt-8 text-2xl text-foreground">
                  <span className="font-mono">{c.last ? dollarsOfPrice(c.last.price, c.tick ?? undefined) : "No print yet"}</span>
                </p>
                <p className="m-0 mt-1 text-sm text-muted-foreground">{c.last ? `per GPU-hour, print of ${fmtUtc(c.last.bucket)}` : "The first print opens the market."}</p>
                <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm">
                  {[c.market, ...others].map((m) => (
                    <Link key={m} href={withMarket("/auction", m)} className="text-foreground no-underline hover:underline">
                      {MARKET_INFO[m].cadence === "Hourly" ? "Hourly demo" : "Weekly auction"} &rarr;
                    </Link>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <p className="m-0 mt-6 text-sm text-muted-foreground">
          {live ? `Read from NEAR ${cfg.network} at ${fmtUtcTime(Math.floor(st.at / 1000), true)}.` : `As of the build, ${fmtUtc(cfg.builtAt)}.`}
        </p>
      </Section>

      <ReviewWall passes={passes} total={findings} />

      <Section id="check" lead="Check it yourself." rest="The live figures come from contracts anyone can read.">
        <div className="grid gap-4 md:grid-cols-3">
          <Check href="/proof#contracts" title={`Contracts on NEAR ${cfg.network}`}>
            Their keys, code and parameters, read in your browser.
          </Check>
          <Check href="/audit" title={`A review in ${passes} passes`}>
            By an AI reviewer, not an audit firm. Every finding and its status.
          </Check>
          <Check href="/proof#verifier" title="A print, re-hashed here">
            Fetch the data behind an index print and hash it in this browser.
          </Check>
        </div>
        <p id="limits" className="m-0 mt-10 max-w-3xl rounded-2xl bg-card p-6 text-base text-foreground ring-1 ring-border">
          All three price reporters are run by one operator today, who can set any price. This is NEAR {cfg.network} with test dollars; no real money moves.{" "}
          <Link href="/how#limits" className="text-foreground underline underline-offset-4">
            Every limit
          </Link>
        </p>
        <div className="mt-14 max-w-3xl">
          <GroupedFaq
            groups={[
              {
                title: "What you are trusting",
                items: [
                  { question: "Who sets the index?", answer: <>Three named reporters post a price each hour; the print is their median. One operator runs all three today, and nothing on chain checks a report against its data. <Link href="/proof#verifier">Re-hash one</Link>.</> },
                  { question: "Can my position be liquidated?", answer: <>No. A LONG and a SHORT together are backed by the whole band, locked when they open. The payout stops at the band&rsquo;s edges, and nothing is called for later. <Link href="/proof#solvency">Solvency, read live</Link>.</> },
                  { question: "Is any of this real money?", answer: <>No. Every contract is on NEAR {cfg.network}, with a test dollar anyone can mint.</> },
                ],
              },
              {
                title: "Using it",
                items: [
                  { question: "What is traded?", answer: <>A week-ahead position on the price of one GPU-hour: LONG for those who buy compute, SHORT for those who own GPUs. It settles in dollars on the index; no GPU time changes hands on Weir.</> },
                  { question: "How does an agent bid?", answer: <>With a NEAR function-call key that can commit, reveal, clear and redeem, and cannot withdraw. <Link href={withMarket("/agents", market)}>Setting one up</Link>.</> },
                  { question: "Where do the index prices come from?", answer: <>Six public price lists, read on a fixed schedule by three reporters; each print is the median of their reports. <Link href="/proof#sources">The last print&rsquo;s sources</Link>.</> },
                ],
              },
            ]}
          />
        </div>
      </Section>

      <BuiltBy />

      <section aria-labelledby="close-h" className="relative flex min-h-[720px] items-start overflow-hidden pb-32 pt-[96px] text-center sm:pt-[170px]">
        {closeBackdrop ? (
          <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-1/2 w-[max(1600px,100vw)] -translate-x-1/2">
            {closeBackdrop}
          </div>
        ) : null}
        <div className="relative mx-auto w-full max-w-[1278px] px-6">
          <h2 id="close-h" className="font-display m-0 text-4xl text-foreground">
            Watch a round clear. <span className="text-muted-foreground">Or run a market in your browser.</span>
          </h2>
          <div className="mt-10 flex flex-wrap justify-center gap-3">
            <Link href={auction} className={buttonClass("primary")}>
              Open the auction
            </Link>
            <Link href={withMarket("/simulate", market)} className={buttonClass("secondary")}>
              Run a simulation
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}

const pct = (x: number) => `${x < 0 ? "−" : "+"}${Math.abs(x * 100).toFixed(1)}%`;

/** The section heading the references share: a lead phrase, then the rest of the sentence in grey. */
function Section({ id, lead, rest, children }: { id: string; lead: string; rest: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="py-20 md:py-28">
      <div className="mx-auto max-w-[1278px] px-6">
        <h2 id={`${id}-h`} className="font-display m-0 mb-12 max-w-3xl text-4xl text-foreground">
          {lead} <span className="text-muted-foreground">{rest}</span>
        </h2>
        {children}
      </div>
    </section>
  );
}

/** True at every moment: the network until this browser has read the round, then the round. */
function Pill({ d, live, network }: { d: FrontData; live: boolean; network: string }) {
  const name = MARKET_INFO[d.market].name;
  // On a phone the market's name is dropped rather than the line cut short.
  const of = <span className="hidden sm:inline"> of {name}</span>;
  let text: ReactNode = (
    <>
      {name} · NEAR {network}, test dollars
    </>
  );
  if (live && d.live && d.live.round !== null && d.live.phase_ends_at)
    text = (
      <>
        Round {d.live.round}
        {of} {d.live.phase === "Commit" ? "takes sealed bids" : "reveals"} until {fmtUtcTime(d.live.phase_ends_at)}
      </>
    );
  else if (live && d.live) text = <>{name}: between rounds</>;
  return (
    <>
      <span className={`live-dot${live ? "" : " stale"}`} aria-hidden="true" />
      <span>{text}</span>
      <span aria-hidden="true" className="text-muted-foreground">
        &rarr;
      </span>
    </>
  );
}

function Check({ href, title, children }: { href: string; title: string; children: ReactNode }) {
  return (
    <Link href={href} className="flex flex-col rounded-2xl p-6 text-foreground no-underline ring-1 ring-border transition-colors hover:bg-card">
      <span className="text-lg font-medium">{title} &rarr;</span>
      <span className="mt-2 text-base text-muted-foreground">{children}</span>
    </Link>
  );
}
