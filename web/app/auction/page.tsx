import type { Metadata } from "next";
import { AuctionPage } from "@/components/pages/auction-page.tsx";
import { DEFAULT_MARKET } from "@/lib/config.ts";

export const metadata: Metadata = { title: "Auction", description: "The sealed round in progress, the phase clock, and every cleared round with its step chart and fills." };

export default function Page() {
  return <AuctionPage market={DEFAULT_MARKET} />;
}
