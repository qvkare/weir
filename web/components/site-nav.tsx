"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { LINKS } from "@/lib/nav.ts";
import { CHIP_KEYS, CHIP_LABEL, DEFAULT_MARKET, MARKET_INFO, marketFromParam, marketsOfChip, mq, withMarket, type MarketId } from "@/lib/config.ts";

export { LINKS };

export function SiteNav() {
  const path = usePathname();
  const m = marketFromParam(useSearchParams().get("m"));
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
 * Keeps the page and its other parameters, except a round picked on another market.
 */
export function MarketSwitch({ markets }: { markets: readonly MarketId[] }) {
  const path = usePathname();
  const params = useSearchParams();
  const m = marketFromParam(params.get("m"));
  const href = (id: MarketId) => {
    const q = new URLSearchParams(params.toString());
    q.delete("series");
    q.delete("round");
    q.delete("range");
    if (id === DEFAULT_MARKET) q.delete("m");
    else q.set("m", id);
    const s = q.toString();
    return s ? `${path}?${s}` : path;
  };
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

/** Server fallback before the search params are known: the same links, default market. */
export function SiteNavFallback() {
  return (
    <nav aria-label="Main" style={{ display: "contents" }}>
      <ul className="nav">
        {LINKS.map((l) => (
          <li key={l.href}>
            <a href={l.href}>{l.label}</a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function MarketSwitchFallback({ markets }: { markets: readonly MarketId[] }) {
  const chips = CHIP_KEYS.filter((c) => marketsOfChip(c, markets).length);
  return (
    <div className="market-switch">
      <div className="switch" role="group" aria-label="Chip">
        {chips.map((c) => {
          const id = marketsOfChip(c, markets)[0]!;
          return (
            <a key={c} href={`/${mq(id)}`}>
              {CHIP_LABEL[c]}
            </a>
          );
        })}
      </div>
    </div>
  );
}
