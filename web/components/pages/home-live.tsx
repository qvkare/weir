"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ChipCards } from "@/components/chip-cards.tsx";
import { DotText } from "@/components/dot-text.tsx";
import { FloorScene } from "@/components/floor-scene.tsx";
import { chipCards, Facts, HeroIndex, IndexChartBlock, IndexSources, lastClearingLine, LastClearing, LimitsList, marketLine, PayoffBlock, SeriesStrips } from "@/components/home-blocks.tsx";
import { LiveBar, useLive } from "@/components/live.tsx";
import { Room } from "@/components/room.tsx";
import { SheetHead } from "@/components/sheet-head.tsx";
import { Specimen } from "@/components/specimen.tsx";
import { Wafer } from "@/components/wafer.tsx";
import { valueOf } from "@/lib/cache.ts";
import { clientSource } from "@/lib/client-source.ts";
import { CHIP_LABEL, MARKET_INFO, withMarket, type MarketId } from "@/lib/config.ts";
import { homeKey, homeProbe, loadHome, type HomeData } from "@/lib/data/home.ts";
import type { FloorPlan } from "@/lib/floor.ts";
import { CHIPS } from "@/lib/hardware.ts";
import type { LoadedBundle } from "@/lib/load.ts";
import type { SiteConfig } from "@/lib/site-config.ts";

const H100 = CHIPS[0]!;

export interface HomeProps {
  cfg: SiteConfig;
  initial: HomeData;
  offered: MarketId[];
  chipMarkets: MarketId[];
  sample: LoadedBundle | null;
  fundingTag: "recorded" | "quotes";
  floor: FloorPlan;
}

export function HomeLive({ cfg, initial, offered, chipMarkets, sample, fundingTag, floor }: HomeProps) {
  const market = initial.market;
  const [range, setRange] = useState(initial.chart.range);
  // ?range= is read in the browser: the static page carries the default range.
  useEffect(() => {
    const r = new URLSearchParams(location.search).get("range");
    if (r && r !== range) setRange(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const ticks = useMemo(() => {
    const t: Partial<Record<MarketId, number>> = {};
    for (const c of initial.chips) if (c.tick) t[c.market] = c.tick;
    return t;
  }, [initial.chips]);
  const pollSecs = MARKET_INFO[market].cadence === "Hourly" ? 30 : 60;
  const [st, retry] = useLive<HomeData>({
    initial,
    initialAt: cfg.builtAt * 1000,
    mode: cfg.mode,
    load: () => loadHome(clientSource(cfg, market), { range, bundlesBase: cfg.bundlesBase, chipSources: chipMarkets.map((m) => clientSource(cfg, m)), ticks }).then(failIfDown),
    probe: () => homeProbe(clientSource(cfg, market)),
    keyOf: homeKey,
    pollSecs,
    deps: [range],
  });
  const d = st.data;
  const wall = st.from === "build";
  const v = { d, wall };
  const onRange = (id: string) => {
    setRange(id);
    const u = new URL(location.href);
    u.searchParams.set("range", id);
    history.replaceState(null, "", u);
  };
  const last = valueOf(d.core.last);
  const cards = chipCards(d, offered);
  const specimenLine = MARKET_INFO[market].chip === "h100" ? `Last clearing: ${lastClearingLine(d)}` : `Last print: ${cards.find((c) => c.chip.id === "h100")?.last ?? "no data"}`;
  const polls = `Checks the round in progress and the last print every ${pollSecs} s while this tab is visible, and reads the page again when either changes.`;

  return (
    <main id="main">
      <section className="hero" aria-labelledby="hero-h">
        <Wafer anchor={last?.price ?? null} anchorIsLive={!!last} />
        <div className="wrap">
          <div className="hero-copy">
            <p className="eyebrow">Week-ahead {CHIP_LABEL[MARKET_INFO[market].chip]} auctions · NEAR {cfg.network}</p>
            <h1 id="hero-h" className="hero-title">
              Take the heat out of your <DotText text="GPU bill." />
            </h1>
            <p className="hero-sub">Next week&rsquo;s GPU hours, priced today. Teams that need compute and people who own it bid once, sealed; one price clears for everyone filled, and every position is paid in full the day it opens.</p>
            <div className="hero-actions">
              <Link className="button" href={withMarket("/auction", market)}>
                The round in progress <span className="arrow" aria-hidden="true">&rarr;</span>
              </Link>
              <Link className="button ghost" href="/how">
                How a round clears
              </Link>
            </div>
          </div>
          <div className="hero-index">
            <HeroIndex {...v} />
            <LiveBar st={st} mode={cfg.mode} builtAt={cfg.builtAt} polls={polls} retry={retry} />
          </div>
        </div>
      </section>

      <div className="wrap">
        <section className="section" id="round" aria-labelledby="round-h">
          <SheetHead no="01" id="round-h" title="One round, as work" note="Example orders · cleared by the Weir engine" />
          <p className="statement">Many agents. One price.</p>
          <p className="lead">Every bid arrives sealed and opens at the same moment, so nobody bids against a price they have seen. The engine finds the one price where the most GPU-hours trade; everyone filled pays it.</p>
          <div className="floor-wrap">
            <FloorScene plan={floor} />
          </div>
        </section>

        <section className="section" id="room" aria-labelledby="room-h">
          <SheetHead no="02" id="room-h" title="Who is in the room" note="Two sides, one price" />
          <Room />
        </section>

        <section className="section" id="hardware" aria-labelledby="hardware-h">
          <SheetHead no="03" id="hardware-h" title="The hour is the product" note="Three chips, a market each · the specimen is an H100" />
          <Specimen
            hourLabel={specimenLine}
            sheet={
              <>
                <div>
                  <div className="figure">
                    <span className="label">Item</span>
                  </div>
                  <DotText text={H100.name} className="spec-model" />
                </div>
                <dl className="kv spec">
                  <dt>Model</dt>
                  <dd>{H100.model}</dd>
                  <dt>Memory</dt>
                  <dd>{H100.memory}</dd>
                  <dt>Bandwidth</dt>
                  <dd>{H100.bandwidth}</dd>
                  <dt>Die</dt>
                  <dd>{H100.die}</dd>
                  <dt>Unit traded</dt>
                  <dd>1 GPU-hour</dd>
                  <dt>{MARKET_INFO[market].chip === "h100" ? "Last clearing" : "Last print"}</dt>
                  <dd>{specimenLine.replace(/^Last (clearing|print): /, "")}</dd>
                </dl>
                <p className="tiny muted" style={{ marginTop: "auto" }}>
                  Drawn from NVIDIA&rsquo;s public descriptions of the part; sources are listed in the site&rsquo;s code. No maker&rsquo;s logo or trade dress; the model is named in plain text.
                </p>
              </>
            }
          />
          <ChipCards cards={cards} />
        </section>

        <section className="section" id="series" aria-labelledby="series-h">
          <SheetHead no="04" id="series-h" title="Series and phase clock" note={marketLine(market)} />
          <SeriesStrips {...v} />
        </section>

        <section className="section" id="index" aria-label="Index history">
          <IndexChartBlock {...v} no="05" onRange={onRange} />
        </section>

        <section className="section" id="sources" aria-labelledby="sources-h">
          <SheetHead no="06" id="sources-h" title="The index and its sources" note={<Link href="/proof#verifier">Re-hash them on Proof</Link>} />
          <IndexSources {...v} sample={sample} />
        </section>

        <section className="section" id="clearing" aria-labelledby="clearing-h">
          <SheetHead no="07" id="clearing-h" title="Last clearing" note={<Link href={withMarket("/auction", market)}>The round in progress</Link>} />
          <LastClearing {...v} />
        </section>

        <section className="section" id="hedge" aria-labelledby="hedge-h">
          <SheetHead no="08" id="hedge-h" title="Payoff and hedge size" note="Per GPU-hour, at settlement" />
          <p className="statement">Next week&rsquo;s compute, called today.</p>
          <PayoffBlock {...v} />
        </section>

        <section className="section" aria-label="Three facts">
          <Facts {...v} fundingTag={fundingTag} />
        </section>

        <section className="section" id="limits" aria-labelledby="limits-h">
          <SheetHead no="09" id="limits-h" title="Limits" note={<Link href="/how#limits">Limits and trust in full</Link>} />
          <LimitsList params={valueOf(d.core.params)} network={cfg.network} />
        </section>
      </div>
    </main>
  );
}

/** A read where the market's parameters or status did not come back is a failed read: keep the last figures. */
function failIfDown(d: HomeData): HomeData {
  if (!d.core.params.ok && !d.core.status.ok) throw new Error(d.core.status.ok ? "" : d.core.status.error);
  if (!d.core.status.ok) throw new Error(d.core.status.error);
  return d;
}
