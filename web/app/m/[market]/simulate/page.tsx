import type { Metadata } from "next";
import { SimulatePage } from "@/components/pages/simulate-page.tsx";
import { marketParams, type MarketPageProps } from "@/lib/market-routes.ts";

export const metadata: Metadata = { title: "Simulate", description: "Scripted agents trade a whole Weir market in your browser, cleared and settled by the real engine. Nothing touches the chain." };
export const dynamicParams = false;
export const generateStaticParams = marketParams;

export default async function Page({ params }: MarketPageProps) {
  return <SimulatePage market={(await params).market} />;
}
