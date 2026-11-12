import type { Metadata } from "next";
import { HowPage } from "@/components/pages/how-page.tsx";
import { DEFAULT_MARKET } from "@/lib/config.ts";

export const metadata: Metadata = { title: "How it works", description: "Series and rounds, commit and reveal, the clearing rule, settlement, funding through NEAR Intents, and every limit." };

export default function Page() {
  return <HowPage market={DEFAULT_MARKET} />;
}
