import Link from "next/link";
import { Suspense } from "react";
import { ChipCards } from "@/components/chip-cards.tsx";
import { DotText } from "@/components/dot-text.tsx";
import { FloorScene } from "@/components/floor-scene.tsx";
import { chipCardData, HeroIndex, HeroWafer, HomeRefresh, IndexChartBlock, IndexSources, LastClearing, lastClearingLine, Limits, marketLine, PayoffBlock, Facts, SeriesStrips } from "@/components/home-blocks.tsx";
import { Room } from "@/components/room.tsx";
import { SheetHead } from "@/components/sheet-head.tsx";
import { Specimen } from "@/components/specimen.tsx";
import { Skeleton } from "@/components/state.tsx";
import { deployments } from "@/lib/build.ts";
import { CHIP_LABEL, MARKET_INFO, marketFromParam, withMarket, type MarketId } from "@/lib/config.ts";
import { buildFloor } from "@/lib/floor.ts";
import { CHIPS } from "@/lib/hardware.ts";

const FLOOR = buildFloor();
const H100 = CHIPS[0]!;

export const dynamic = "force-dynamic";

type Search = Promise<Record<string, string | string[] | undefined>>;

const withM = (path: string, market: MarketId) => withMarket(path, market);

async function SpecimenBlock({ market }: { market: MarketId }) {
  // The specimen is always the H100; its last clearing is the selected H100 market's, else the weekly one.
  const h100 = MARKET_INFO[market].chip === "h100" ? market : "h100-weekly";
  const [line, cards] = await Promise.all([lastClearingLine(h100), chipCardData(market)]);
  return (
    <>
      <Specimen
        hourLabel={`Last clearing: ${line}`}
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
              <dt>Last clearing</dt>
              <dd>{line}</dd>
            </dl>
            <p className="tiny muted" style={{ marginTop: "auto" }}>
              Drawn from NVIDIA&rsquo;s public descriptions of the part; sources are listed in the site&rsquo;s code. No maker&rsquo;s logo or trade dress; the model is named in plain text.
            </p>
          </>
        }
      />
      <ChipCards cards={cards} />
    </>
  );
}

export default async function Home({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const market = marketFromParam(sp.m);
  const range = typeof sp.range === "string" ? sp.range : undefined;
  const network = deployments().network;
  return (
    <main id="main">
      <section className="hero" aria-labelledby="hero-h">
        <Suspense fallback={<div className="wafer" aria-hidden="true" />}>
          <HeroWafer market={market} />
        </Suspense>
        <div className="wrap">
          <div className="hero-copy">
            <p className="eyebrow">Week-ahead {CHIP_LABEL[MARKET_INFO[market].chip]} auctions · NEAR {network}</p>
            <h1 id="hero-h" className="hero-title">
              Take the heat out of your <DotText text="GPU bill." />
            </h1>
            <p className="hero-sub">Next week&rsquo;s GPU hours, priced today. Teams that need compute and people who own it bid once, sealed; one price clears for everyone filled, and every position is paid in full the day it opens.</p>
            <div className="hero-actions">
              <Link className="button" href={withM("/auction", market)}>
                The round in progress <span className="arrow" aria-hidden="true">&rarr;</span>
              </Link>
              <Link className="button ghost" href="/how">
                How a round clears
              </Link>
            </div>
          </div>
          <div className="hero-index">
            <Suspense fallback={<Skeleton lines={3} label="Reading the index" />}>
              <HeroIndex market={market} />
            </Suspense>
          </div>
        </div>
      </section>

      <div className="wrap">
        <section className="section" id="round" aria-labelledby="round-h">
          <SheetHead no="01" id="round-h" title="One round, as work" note="Example orders · cleared by the Weir engine" />
          <p className="statement">Many agents. One price.</p>
          <p className="lead">Every bid arrives sealed and opens at the same moment, so nobody bids against a price they have seen. The engine finds the one price where the most GPU-hours trade; everyone filled pays it.</p>
          <div className="floor-wrap">
            <FloorScene plan={FLOOR} />
          </div>
        </section>

        <section className="section" id="room" aria-labelledby="room-h">
          <SheetHead no="02" id="room-h" title="Who is in the room" note="Two sides, one price" />
          <Room />
        </section>

        <section className="section" id="hardware" aria-labelledby="hardware-h">
          <SheetHead no="03" id="hardware-h" title="The hour is the product" note="Three chips, a market each · the specimen is an H100" />
          <Suspense fallback={<Skeleton lines={6} label="Drawing the specimen" />}>
            <SpecimenBlock market={market} />
          </Suspense>
        </section>

        <section className="section" id="series" aria-labelledby="series-h">
          <SheetHead no="04" id="series-h" title="Series and phase clock" note={marketLine(market)} />
          <Suspense fallback={<Skeleton lines={3} label="Reading the series" />}>
            <SeriesStrips market={market} />
          </Suspense>
        </section>

        <section className="section" id="index" aria-label="Index history">
          <Suspense fallback={<Skeleton lines={5} label="Reading the prints" />}>
            <IndexChartBlock market={market} range={range} no="05" />
          </Suspense>
        </section>

        <section className="section" id="sources" aria-labelledby="sources-h">
          <SheetHead no="06" id="sources-h" title="The index and its sources" note={<Link href="/proof#verifier">Re-hash them on Proof</Link>} />
          <Suspense fallback={<Skeleton lines={6} label="Reading the sources" />}>
            <IndexSources market={market} />
          </Suspense>
        </section>

        <section className="section" id="clearing" aria-labelledby="clearing-h">
          <SheetHead no="07" id="clearing-h" title="Last clearing" note={<Link href={withM("/auction", market)}>The round in progress</Link>} />
          <Suspense fallback={<Skeleton lines={4} label="Reading the last result" />}>
            <LastClearing market={market} />
          </Suspense>
        </section>

        <section className="section" id="hedge" aria-labelledby="hedge-h">
          <SheetHead no="08" id="hedge-h" title="Payoff and hedge size" note="Per GPU-hour, at settlement" />
          <p className="statement">Next week&rsquo;s compute, called today.</p>
          <Suspense fallback={<Skeleton lines={5} label="Reading the band" />}>
            <PayoffBlock market={market} />
          </Suspense>
        </section>

        <section className="section" aria-label="Three facts">
          <Suspense fallback={<Skeleton lines={3} />}>
            <Facts market={market} />
          </Suspense>
        </section>

        <section className="section" id="limits" aria-labelledby="limits-h">
          <SheetHead no="09" id="limits-h" title="Limits" note={<Link href="/how#limits">Limits and trust in full</Link>} />
          <Suspense fallback={<Skeleton lines={5} />}>
            <Limits market={market} network={network} />
          </Suspense>
        </section>
      </div>
      <Suspense fallback={null}>
        <HomeRefresh market={market} />
      </Suspense>
    </main>
  );
}
