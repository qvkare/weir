import type { Metadata } from "next";
import { AppPage } from "@/components/pages/app-page.tsx";
import { APP_VIEWS, viewOf } from "@/lib/app-views.ts";
import { marketParams } from "@/lib/market-routes.ts";
import type { MarketId } from "@/lib/config.ts";

type Props = { params: Promise<{ market: MarketId; view?: string[] }> };

export const dynamicParams = false;
export const generateStaticParams = () => marketParams().flatMap(({ market }) => APP_VIEWS.filter((v) => v.section === "auction").map((v) => ({ market, view: v.slug ? [v.slug] : [] })));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const v = viewOf("auction", (await params).view?.[0])!;
  return { title: v.label, description: v.description };
}

export default async function Page({ params }: Props) {
  const p = await params;
  return <AppPage viewId={viewOf("auction", p.view?.[0])!.id} market={p.market} />;
}
