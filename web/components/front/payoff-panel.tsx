"use client";
// The Payoff tab of "One market, four views": the payoff and hedge-size tool from /how, in the
// application's frame (no sidebar: it is a tool, not one of the market's views).
import { PayoffBlock } from "@/components/home-blocks.tsx";
import type { MarketId } from "@/lib/config.ts";
import type { ShellData } from "@/lib/data/app.ts";
import type { HomeData } from "@/lib/data/home.ts";
import { ChipRow, Frame, TitleRow } from "./app/parts.tsx";

export function PayoffPanel({ market, shell, series }: { market: MarketId; shell: ShellData; series: HomeData }) {
  return (
    <Frame fill="embed" sidebar={null} title={<TitleRow market={market} live={shell.live} now={shell.now} wall frozen />} chips={<ChipRow label="Payoff and hedge size" />}>
      <div className="px-4 py-6 md:px-6">
        <PayoffBlock d={series} wall />
      </div>
    </Frame>
  );
}
