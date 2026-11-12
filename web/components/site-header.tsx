import Link from "next/link";
import { Lockup } from "./logo.tsx";
import { MarketSwitch, SiteNav } from "./site-nav.tsx";
import { ThemeToggle } from "./theme-toggle.tsx";
import type { MarketId } from "@/lib/config.ts";

export function SiteHeader({ network, markets }: { network: string; markets: readonly MarketId[] }) {
  const net = network.charAt(0).toUpperCase() + network.slice(1);
  return (
    <header className="site-header">
      <div className="wrap row">
        <Link href="/" className="wordmark" aria-label="Weir, home">
          <Lockup />
        </Link>
        <SiteNav />
        <div className="header-tools">
          <span className="tag net" title={`Every contract is on NEAR ${network}. No real money.`}>
            <span className="net-dot" aria-hidden="true" />
            {net}
          </span>
          <MarketSwitch markets={markets} />
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
