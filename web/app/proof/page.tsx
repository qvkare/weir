import type { Metadata } from "next";
import { ProofPage } from "@/components/pages/proof-page.tsx";
import { DEFAULT_MARKET } from "@/lib/config.ts";

export const metadata: Metadata = { title: "Proof", description: "Contracts and their remaining keys, parameters, recorded transactions, bundle hashes re-checked in your browser, and a live solvency check." };

export default function Page() {
  return <ProofPage market={DEFAULT_MARKET} />;
}
