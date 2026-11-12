import type { Metadata } from "next";
import { SimulatePage } from "@/components/pages/simulate-page.tsx";
import { DEFAULT_MARKET } from "@/lib/config.ts";

export const metadata: Metadata = { title: "Simulate", description: "Scripted agents trade a whole Weir market in your browser, cleared and settled by the real engine. Nothing touches the chain." };

export default function Page() {
  return <SimulatePage market={DEFAULT_MARKET} />;
}
