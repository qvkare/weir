import type { Metadata } from "next";
import { AppPage } from "@/components/pages/app-page.tsx";
import { viewById } from "@/lib/app-views.ts";
import { marketParams, type MarketPageProps } from "@/lib/market-routes.ts";

export const metadata: Metadata = { title: "Agents", description: viewById("agents").description };
export const dynamicParams = false;
export const generateStaticParams = marketParams;

export default async function Page({ params }: MarketPageProps) {
  return <AppPage viewId="agents" market={(await params).market} />;
}
