"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { MARKET_INFO, MARKET_IDS, marketFromParam, type MarketId } from "@/lib/config.ts";

export const LINKS = [
  { href: "/", label: "Index" },
  { href: "/auction", label: "Auction" },
  { href: "/simulate", label: "Simulate" },
  { href: "/backtest", label: "Backtest" },
  { href: "/how", label: "How it works" },
  { href: "/proof", label: "Proof" },
  { href: "/agents", label: "Agents" },
] as const;

const withMarket = (href: string, m: MarketId) => (m === "weekly" ? href : `${href}?m=${m}`);

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

/** Weekly or fast. Keeps the page and its other parameters, except a round picked on another market. */
export function MarketSwitch() {
  const path = usePathname();
  const params = useSearchParams();
  const m = marketFromParam(params.get("m"));
  const href = (id: MarketId) => {
    const q = new URLSearchParams(params.toString());
    q.delete("series");
    q.delete("round");
    if (id === "weekly") q.delete("m");
    else q.set("m", id);
    const s = q.toString();
    return s ? `${path}?${s}` : path;
  };
  return (
    <div className="switch" role="group" aria-label="Market">
      {MARKET_IDS.map((id) => (
        <Link key={id} href={href(id)} aria-current={id === m ? "true" : undefined} title={`${MARKET_INFO[id].delivery}, ${MARKET_INFO[id].rounds}`}>
          {MARKET_INFO[id].label}
        </Link>
      ))}
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

export function MarketSwitchFallback() {
  return (
    <div className="switch" role="group" aria-label="Market">
      {MARKET_IDS.map((id) => (
        <a key={id} href={id === "weekly" ? "/" : `/?m=${id}`}>
          {MARKET_INFO[id].label}
        </a>
      ))}
    </div>
  );
}
