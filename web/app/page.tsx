import { Suspense } from "react";
import { HomeRefresh, IndexChartBlock, IndexHead, LastClearing, Limits, marketLine, PayoffBlock, Facts, SeriesStrips } from "@/components/home-blocks.tsx";
import { Skeleton } from "@/components/state.tsx";
import { deployments } from "@/lib/build.ts";
import { marketFromParam } from "@/lib/config.ts";
import Link from "next/link";

export const dynamic = "force-dynamic";

type Search = Promise<Record<string, string | string[] | undefined>>;

export default async function Home({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const market = marketFromParam(sp.m);
  const range = typeof sp.range === "string" ? sp.range : undefined;
  const network = deployments().network;
  return (
    <main id="main">
      <div className="wrap">
        <Suspense fallback={<div className="index-head"><Skeleton lines={4} label="Reading the index" /><Skeleton lines={6} label="Reading the sources" /></div>}>
          <IndexHead market={market} />
        </Suspense>

        <section className="section" id="series" aria-labelledby="series-h">
          <div className="section-head">
            <h2 id="series-h">Series and phase clock</h2>
            <span className="note">{marketLine(market)}</span>
          </div>
          <Suspense fallback={<Skeleton lines={3} label="Reading the series" />}>
            <SeriesStrips market={market} />
          </Suspense>
        </section>

        <section className="section" id="index" aria-label="Index history">
          <Suspense fallback={<Skeleton lines={5} label="Reading the prints" />}>
            <IndexChartBlock market={market} range={range} />
          </Suspense>
        </section>

        <section className="section" id="clearing" aria-labelledby="clearing-h">
          <div className="section-head">
            <h2 id="clearing-h">Last clearing</h2>
            <Link className="note" href={`/auction${market === "weekly" ? "" : `?m=${market}`}`}>
              The round in progress
            </Link>
          </div>
          <Suspense fallback={<Skeleton lines={4} label="Reading the last result" />}>
            <LastClearing market={market} />
          </Suspense>
        </section>

        <section className="section" id="hedge" aria-labelledby="hedge-h">
          <div className="section-head">
            <h2 id="hedge-h">Payoff and hedge size</h2>
            <span className="note">Per GPU-hour, at settlement</span>
          </div>
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
          <div className="section-head">
            <h2 id="limits-h">Limits</h2>
            <Link className="note" href="/how#limits">
              Limits and trust in full
            </Link>
          </div>
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
