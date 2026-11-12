import type { Metadata } from "next";
import { HowPage } from "@/components/pages/how-page.tsx";
import { marketParams, type MarketPageProps } from "@/lib/market-routes.ts";

export const metadata: Metadata = { title: "How it works", description: "Series and rounds, commit and reveal, the clearing rule, settlement, funding through NEAR Intents, and every limit." };
export const dynamicParams = false;
export const generateStaticParams = marketParams;

export default async function Page({ params }: MarketPageProps) {
  return <HowPage market={(await params).market} />;
}
