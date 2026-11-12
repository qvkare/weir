import { HomePage } from "@/components/pages/home-page.tsx";
import { marketParams, type MarketPageProps } from "@/lib/market-routes.ts";

export const dynamicParams = false;
export const generateStaticParams = marketParams;

export default async function Page({ params }: MarketPageProps) {
  return <HomePage market={(await params).market} />;
}
