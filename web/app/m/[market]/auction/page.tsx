import type { Metadata } from "next";
import { AuctionPage } from "@/components/pages/auction-page.tsx";
import { marketParams, type MarketPageProps } from "@/lib/market-routes.ts";

export const metadata: Metadata = { title: "Auction", description: "The sealed round in progress, the phase clock, and every cleared round with its step chart and fills." };
export const dynamicParams = false;
export const generateStaticParams = marketParams;

export default async function Page({ params }: MarketPageProps) {
  return <AuctionPage market={(await params).market} />;
}
