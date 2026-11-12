import type { Metadata } from "next";
import { AppPage } from "@/components/pages/app-page.tsx";
import { viewById } from "@/lib/app-views.ts";
import { DEFAULT_MARKET } from "@/lib/config.ts";

export const metadata: Metadata = { title: "Agents", description: viewById("agents").description };

export default function Page() {
  return <AppPage viewId="agents" market={DEFAULT_MARKET} />;
}
