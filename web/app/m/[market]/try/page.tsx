import type { Metadata } from "next";
import { AppPage } from "@/components/pages/app-page.tsx";
import { viewById } from "@/lib/app-views.ts";
import { marketParams, type MarketPageProps } from "@/lib/market-routes.ts";

export const metadata: Metadata = { title: "Test bid", description: viewById("try").description };
export const dynamicParams = false;
// Every market has the page, so switching market keeps the view; only the hourly market bids.
export const generateStaticParams = marketParams;

export default async function Page({ params }: MarketPageProps) {
  return <AppPage viewId="try" market={(await params).market} />;
}
