"use client";
// Adapted from Ruixen UI "navbar-minimal" (https://ruixen.com/r/navbar-minimal.json).
// MIT, Copyright (c) 2025 Ruixen UI. Changes: our mark, links and button; the button opens the
// auction of the market on screen; a theme switch; a <details> menu at phone width; once the
// page scrolls, the bar becomes a floating rounded pill, centred, as in the reference.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Lockup } from "@/components/logo.tsx";
import { ThemeToggle } from "@/components/theme-toggle.tsx";
import { marketOfPath, withMarket } from "@/lib/config.ts";
import { HEADER_LINKS } from "@/lib/nav.ts";
import { cn } from "@/lib/utils.ts";
import { buttonClass } from "../ui/button.ts";

export function Navbar() {
  const { market, page } = marketOfPath(usePathname());
  const links = HEADER_LINKS.map((l) => ({ ...l, href: withMarket(l.href, market), current: page === l.href }));
  const [floating, setFloating] = useState(false);
  useEffect(() => {
    const on = () => setFloating(window.scrollY > 24);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  return (
    <header className={cn("sticky top-0 z-40 h-16 w-full transition-colors duration-300", floating ? "border-b border-transparent" : "border-b border-border bg-background/80 backdrop-blur-md")}>
      <div
        className={cn(
          "mx-auto flex items-center justify-between gap-6 transition-[max-width,margin,height,padding,border-radius,background-color,box-shadow] duration-300 ease-out",
          floating ? "mt-3 h-12 w-[calc(100%-1.5rem)] max-w-[880px] rounded-full bg-background/80 px-4 shadow-lg ring-1 ring-border backdrop-blur-md" : "h-16 max-w-[1278px] px-6",
        )}
      >
        <div className="flex items-center gap-8">
          <Link href={withMarket("/", market)} className="flex items-center text-foreground no-underline" aria-label="Weir, home">
            <Lockup />
          </Link>
          <nav aria-label="Main" className="hidden items-center gap-6 md:flex">
            {links.map((l) => (
              <Link key={l.href} href={l.href} aria-current={l.current ? "page" : undefined} className={cn("text-sm no-underline transition-colors hover:text-foreground", l.current ? "text-foreground" : "text-muted-foreground")}>
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Link href={withMarket("/auction", market)} className={buttonClass("primary", "sm", "hidden sm:inline-flex")}>
            Open the auction
          </Link>
          <details key={page} className="group relative md:hidden">
            <summary className="flex h-9 cursor-pointer list-none items-center rounded-full px-3 text-sm text-foreground ring-1 ring-border [&::-webkit-details-marker]:hidden">Menu</summary>
            <nav aria-label="Main, phone" className="absolute right-0 top-11 z-50 grid w-56 gap-1 rounded-2xl bg-card p-2 shadow-lg ring-1 ring-border">
              {[...links, { label: "Open the auction", href: withMarket("/auction", market), current: false }].map((l) => (
                <Link key={l.label} href={l.href} className="rounded-xl px-3 py-2.5 text-sm text-foreground no-underline hover:bg-muted">
                  {l.label}
                </Link>
              ))}
            </nav>
          </details>
        </div>
      </div>
    </header>
  );
}
