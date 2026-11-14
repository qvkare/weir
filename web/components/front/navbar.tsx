"use client";
// Adapted from Ruixen UI "navbar-minimal" (https://ruixen.com/r/navbar-minimal.json).
// MIT, Copyright (c) 2025 Ruixen UI. Changes: our mark, links and button; the button opens the
// auction of the market on screen; a theme switch; a <details> menu at phone width; once the
// page scrolls, the bar becomes a floating rounded pill, centred, as in the reference; a
// secondary "Connect wallet" link to the test bid, which shows the account once connected.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type MouseEvent } from "react";
import { Lockup } from "@/components/logo.tsx";
import { ThemeToggle } from "@/components/theme-toggle.tsx";
import { marketOfPath, withMarket, type MarketId } from "@/lib/config.ts";
import { HEADER_LINKS } from "@/lib/nav.ts";
import { cn } from "@/lib/utils.ts";
import { CONNECT_EVENT, connectedAccount, shortAccount, WALLET_EVENT } from "@/lib/wallet-record.ts";
import { buttonClass } from "../ui/button.ts";

/** The market whose test bid connects a wallet (components/front/app/try-view.tsx, TRY_MARKET). */
const WALLET_MARKET: MarketId = "h100-fast";

/** The account this browser has connected, read from storage after mount (the server renders
 * none), again when the test bid announces a change in this tab or storage changes in another. */
function useConnectedAccount(contractId: string | null): string | null {
  const [account, setAccount] = useState<string | null>(null);
  useEffect(() => {
    const read = () => {
      let kv: Storage | null = null;
      try {
        kv = window.localStorage;
      } catch {
        // Storage blocked: no wallet can be connected here.
      }
      setAccount(connectedAccount(kv, contractId));
    };
    read();
    window.addEventListener(WALLET_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(WALLET_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, [contractId]);
  return account;
}

export function Navbar({ walletContract = null }: { walletContract?: string | null }) {
  const pathname = usePathname();
  const { market, page } = marketOfPath(pathname);
  const account = useConnectedAccount(walletContract);
  const tryHref = withMarket("/try", WALLET_MARKET);
  const wallet = account
    ? { href: tryHref, label: shortAccount(account), title: `Connected: ${account}`, aria: `Connected wallet ${account}, open the test bid` }
    : { href: `${tryHref}?connect=1`, label: "Connect wallet", title: undefined, aria: undefined };
  // Already on the test bid: a link to the same page would not reopen the chooser, so ask the view.
  const onWallet = (e: MouseEvent<HTMLAnchorElement>) => {
    if (account || pathname.replace(/\/$/, "") !== tryHref) return;
    e.preventDefault();
    e.currentTarget.closest("details")?.removeAttribute("open");
    window.dispatchEvent(new Event(CONNECT_EVENT));
  };
  const links = HEADER_LINKS.map((l) => ({ ...l, href: withMarket(l.href, market), current: page === l.href }));
  const [floating, setFloating] = useState(false);
  useEffect(() => {
    const on = () => setFloating(window.scrollY > 24);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  return (
    <header className={cn("sticky top-0 z-40 h-16 w-full transition-colors duration-[var(--dur-settle)]", floating ? "border-b border-transparent" : "border-b border-border bg-background/80 backdrop-blur-md")}>
      <div
        className={cn(
          "mx-auto flex items-center justify-between gap-6 transition-[max-width,margin,height,padding,border-radius,background-color,box-shadow] duration-[var(--dur-settle)]",
          floating ? "mt-3 h-12 w-[calc(100%-1.5rem)] max-w-[880px] rounded-full bg-background/80 px-4 shadow-lg ring-1 ring-border backdrop-blur-md" : "h-16 max-w-[1278px] px-6",
        )}
      >
        <div className="flex items-center gap-8">
          <Link href={withMarket("/", market)} className="flex items-center text-foreground no-underline" aria-label="Weir, home">
            <Lockup />
          </Link>
          <nav aria-label="Main" className="hidden items-center gap-6 lg:flex">
            {links.map((l) => (
              <Link key={l.href} href={l.href} aria-current={l.current ? "page" : undefined} className={cn("text-sm no-underline transition-colors hover:text-foreground", l.current ? "text-foreground" : "text-muted-foreground")}>
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          {walletContract ? (
            <Link href={wallet.href} title={wallet.title} aria-label={wallet.aria} onClick={onWallet} className={buttonClass("secondary", "sm", cn("hidden md:inline-flex", account && "font-mono text-xs"))}>
              {wallet.label}
            </Link>
          ) : null}
          <Link href={withMarket("/auction", market)} className={buttonClass("primary", "sm", "hidden sm:inline-flex")}>
            Open the auction
          </Link>
          <details key={page} className="group relative lg:hidden">
            <summary className="flex h-9 cursor-pointer list-none items-center rounded-full px-3 text-sm text-foreground ring-1 ring-border [&::-webkit-details-marker]:hidden">Menu</summary>
            <nav aria-label="Main, phone" className="absolute right-0 top-11 z-50 grid w-56 gap-1 rounded-2xl bg-card p-2 shadow-lg ring-1 ring-border">
              {[...links, { label: "Open the auction", href: withMarket("/auction", market), current: false }].map((l) => (
                <Link key={l.label} href={l.href} className="rounded-xl px-3 py-2.5 text-sm text-foreground no-underline hover:bg-muted">
                  {l.label}
                </Link>
              ))}
              {walletContract ? (
                <Link href={wallet.href} title={wallet.title} aria-label={wallet.aria} onClick={onWallet} className="truncate rounded-xl px-3 py-2.5 text-sm text-foreground no-underline hover:bg-muted md:hidden">
                  {account ? <span className="font-mono text-xs">{shortAccount(account, 24)}</span> : wallet.label}
                </Link>
              ) : null}
            </nav>
          </details>
        </div>
      </div>
    </header>
  );
}
