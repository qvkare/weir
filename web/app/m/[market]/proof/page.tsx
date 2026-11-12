import type { Metadata } from "next";
import { ProofPage } from "@/components/pages/proof-page.tsx";
import { marketParams, type MarketPageProps } from "@/lib/market-routes.ts";

export const metadata: Metadata = { title: "Proof", description: "Contracts and their remaining keys, parameters, recorded transactions, bundle hashes re-checked in your browser, and a live solvency check." };
export const dynamicParams = false;
export const generateStaticParams = marketParams;

export default async function Page({ params }: MarketPageProps) {
  return <ProofPage market={(await params).market} />;
}
