import type { Metadata } from "next";
import { AppPage } from "@/components/pages/app-page.tsx";
import { APP_VIEWS, viewOf } from "@/lib/app-views.ts";
import { DEFAULT_MARKET } from "@/lib/config.ts";

type Props = { params: Promise<{ view?: string[] }> };

export const dynamicParams = false;
export const generateStaticParams = () => APP_VIEWS.filter((v) => v.section === "proof").map((v) => ({ view: v.slug ? [v.slug] : [] }));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const v = viewOf("proof", (await params).view?.[0])!;
  return { title: v.label, description: v.description };
}

export default async function Page({ params }: Props) {
  return <AppPage viewId={viewOf("proof", (await params).view?.[0])!.id} market={DEFAULT_MARKET} />;
}
