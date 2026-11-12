import type { Metadata } from "next";
import { AgentsPage } from "@/components/pages/agents-page.tsx";
import { marketParams, type MarketPageProps } from "@/lib/market-routes.ts";

export const metadata: Metadata = { title: "Agents", description: "Give an agent a NEAR function-call key that can commit, reveal, clear and redeem on Weir, and cannot withdraw. The commit string, a minimal loop, and the agents on the book." };
export const dynamicParams = false;
export const generateStaticParams = marketParams;

export default async function Page({ params }: MarketPageProps) {
  return <AgentsPage market={(await params).market} />;
}
