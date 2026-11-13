import type { Metadata } from "next";
import { AppPage } from "@/components/pages/app-page.tsx";
import { viewById } from "@/lib/app-views.ts";
import { DEFAULT_MARKET } from "@/lib/config.ts";

export const metadata: Metadata = { title: "Test bid", description: viewById("try").description };

// The default market is weekly: this page says the test bid runs on the hourly market and links there.
export default function Page() {
  return <AppPage viewId="try" market={DEFAULT_MARKET} />;
}
