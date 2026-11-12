"use client";
// The product picture under the hero: the Weir application's Clearings view (components/front/app),
// read from the chain, the build's figures first and labelled. The same sidebar, rows and grid as
// /auction/clearings; every item in it opens the matching page. Ours, not from a registry.
import Link from "next/link";
import type { ReactNode } from "react";
import { viewById } from "@/lib/app-views.ts";
import { MARKET_INFO, withMarket, type MarketId } from "@/lib/config.ts";
import type { FrontData } from "@/lib/data/front.ts";
import { Chip, ChipRow, Frame, RoundsTable, SHORT_NAME, Sidebar, smallButton, TitleRow } from "./app/parts.tsx";

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

const CLEARINGS = viewById("clearings");

export function AppWindow({ d, selected, onSelect, wall, network, bar }: AppWindowProps) {
  const reading = d.market !== selected;
  const live = reading ? null : d.live;
  const series = live?.series ?? null;
  const spansTwo = d.rows.some((r) => r.series !== series);
  return (
    <Frame
      sidebar={<Sidebar network={network} chips={d.chips} selected={selected} view={CLEARINGS} onSelect={onSelect} />}
      title={
        <TitleRow
          market={selected}
          live={live}
          now={d.now}
          wall={wall}
          action={
            <Link href={withMarket("/auction", selected)} className={smallButton}>
              Open the auction
            </Link>
          }
        />
      }
      chips={
        <ChipRow label="Clearings" bar={bar}>
          <Chip>Newest first</Chip>
          {series !== null ? <Chip>{spansTwo ? `Series ${series} and ${series - 1}` : `Series ${series}`}</Chip> : null}
          <Chip>Last {Math.max(d.rows.length, 1)} rounds</Chip>
          <Link href={withMarket(CLEARINGS.path, selected)} className="text-xs text-foreground underline underline-offset-4">
            All rounds
          </Link>
        </ChipRow>
      }
    >
      <RoundsTable
        rows={reading ? [] : d.rows}
        tick={d.params?.tick}
        showSeries={spansTwo}
        fade
        empty={reading ? `Reading ${SHORT_NAME[selected]} from NEAR ${network}…` : d.kind === "none" ? `The ${MARKET_INFO[selected].name} market is not deployed yet.` : d.error ? `Could not read the chain: ${d.error}` : "No round has been held yet."}
        hrefOf={(r) => (r.clearedAt !== null ? withMarket(CLEARINGS.path, selected, `series=${r.series}&round=${r.round}`) : withMarket("/auction/book", selected))}
      />
    </Frame>
  );
}
