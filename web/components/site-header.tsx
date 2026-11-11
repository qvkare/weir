import Link from "next/link";
import { Suspense } from "react";
import { Lockup } from "./logo.tsx";
import { MarketSwitch, MarketSwitchFallback, SiteNav, SiteNavFallback } from "./site-nav.tsx";
import { ThemeToggle } from "./theme-toggle.tsx";

export function SiteHeader({ network }: { network: string }) {
  const net = network.charAt(0).toUpperCase() + network.slice(1);
  return (
    <header className="site-header">
      <div className="wrap row">
        <Link href="/" className="wordmark" aria-label="Weir, home">
          <Lockup />
        </Link>
        <Suspense fallback={<SiteNavFallback />}>
          <SiteNav />
        </Suspense>
        <div className="header-tools">
          <span className="tag net" title={`Every contract is on NEAR ${network}. No real money.`}>
            <span className="net-dot" aria-hidden="true" />
            {net}
          </span>
          <Suspense fallback={<MarketSwitchFallback />}>
            <MarketSwitch />
          </Suspense>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
