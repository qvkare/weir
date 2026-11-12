import type { Metadata } from "next";
import { AgentsPage } from "@/components/pages/agents-page.tsx";
import { DEFAULT_MARKET } from "@/lib/config.ts";

export const metadata: Metadata = { title: "Agents", description: "Give an agent a NEAR function-call key that can commit, reveal, clear and redeem on Weir, and cannot withdraw. The commit string, a minimal loop, and the agents on the book." };

export default function Page() {
  return <AgentsPage market={DEFAULT_MARKET} />;
}
