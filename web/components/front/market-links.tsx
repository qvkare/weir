// A row of market links for the reading pages (/how): the same look as the simulate page's.
import Link from "next/link";
import { MARKET_IDS, withMarket, type MarketId } from "@/lib/config.ts";
import { cn } from "@/lib/utils.ts";

const SHORT_NAME: Record<MarketId, string> = { "h100-weekly": "H100 weekly", "h100-fast": "H100 hourly", "h200-weekly": "H200 weekly", "a100-80-weekly": "A100 80 GB weekly" };

export function MarketLinks({ page, current, markets = MARKET_IDS }: { page: string; current: MarketId; markets?: readonly MarketId[] }) {
  return (
    <nav aria-label="Market" className="mt-4 flex flex-wrap gap-1">
      {markets.map((m) => (
        <Link key={m} href={withMarket(page, m)} aria-current={m === current ? "page" : undefined} className={cn("rounded-md px-2.5 py-1 text-xs no-underline ring-1", m === current ? "bg-foreground/[0.09] text-foreground ring-foreground/30" : "text-muted-foreground ring-border hover:text-foreground")}>
          {SHORT_NAME[m]}
        </Link>
      ))}
    </nav>
  );
}
