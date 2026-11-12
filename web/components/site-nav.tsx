"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LINKS } from "@/lib/nav.ts";
import { CHIP_KEYS, CHIP_LABEL, MARKET_INFO, marketOfPath, marketsOfChip, PER_MARKET_PAGES, withMarket, type MarketId } from "@/lib/config.ts";

export { LINKS };

export function SiteNav() {
  const { market: m, page: path } = marketOfPath(usePathname());
  return (
    <nav aria-label="Main" className="nav-wrap" style={{ display: "contents" }}>
      <ul className="nav">
        {LINKS.map((l) => (
          <li key={l.href}>
            <Link href={withMarket(l.href, m)} aria-current={path === l.href ? "page" : undefined}>
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * Chip first, then cadence where a chip has more than one market (H100: weekly and hourly).
 * Keeps the page; a round or range picked on another market is dropped.
 */
export function MarketSwitch({ markets }: { markets: readonly MarketId[] }) {
  const { market: m, page } = marketOfPath(usePathname());
  // Pages with one version for all markets (/spec, /audit, /backtest) switch to the market's home.
  const perMarket = PER_MARKET_PAGES.includes(page);
  const href = (id: MarketId) => withMarket(perMarket ? page : "/", id);
  const chips = CHIP_KEYS.filter((c) => marketsOfChip(c, markets).length);
  const cur = MARKET_INFO[m].chip;
  const cadences = marketsOfChip(cur, markets);
  return (
    <div className="market-switch">
      <div className="switch" role="group" aria-label="Chip">
        {chips.map((c) => {
          const target = cadences.includes(m) && c === cur ? m : marketsOfChip(c, markets)[0]!;
          return (
            <Link key={c} href={href(target)} aria-current={c === cur ? "true" : undefined} title={`${CHIP_LABEL[c]} markets`}>
              {CHIP_LABEL[c]}
            </Link>
          );
        })}
      </div>
      {cadences.length > 1 ? (
        <div className="switch" role="group" aria-label={`${CHIP_LABEL[cur]} cadence`}>
          {cadences.map((id) => (
            <Link key={id} href={href(id)} aria-current={id === m ? "true" : undefined} title={`${MARKET_INFO[id].delivery}, ${MARKET_INFO[id].rounds}`}>
              {MARKET_INFO[id].cadence}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}
