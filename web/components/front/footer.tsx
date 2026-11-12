// Adapted from Ruixen UI "footer-pro" (https://ruixen.com/r/footer-pro.json).
// MIT, Copyright (c) 2025 Ruixen UI. Changes: our lockup, columns and lines; no social icons
// (no lucide-react); the status line is the build's time and spec, with no animated dot; set as a
// large rounded card, as in the reference.
import Link from "next/link";
import { Lockup } from "@/components/logo.tsx";

interface Col {
  title: string;
  links: { label: string; href: string }[];
}

const COLUMNS: Col[] = [
  { title: "Market", links: [{ label: "Home", href: "/" }, { label: "Auction", href: "/auction" }, { label: "Simulate", href: "/simulate" }, { label: "Backtest", href: "/backtest" }] },
  { title: "Read", links: [{ label: "How it works", href: "/how" }, { label: "Limits and trust", href: "/how#limits" }, { label: "Contracts and checks", href: "/proof" }, { label: "Review record", href: "/audit" }, { label: "Specification", href: "/spec" }] },
  { title: "For agents", links: [{ label: "Agent keys", href: "/agents" }, { label: "/api/status", href: "/api/status" }, { label: "/api/round", href: "/api/round" }, { label: "/llms.txt", href: "/llms.txt" }] },
];

export function Footer({ builtAt, spec, network }: { builtAt: number; spec: string | null; network: string }) {
  return (
    <footer className="bg-background px-3 pb-3 pt-10 sm:px-6 sm:pb-6">
      <div className="mx-auto max-w-[1278px] rounded-3xl bg-card px-6 py-12 ring-1 ring-border sm:px-10 lg:py-16">
        <div className="flex flex-col gap-10 lg:flex-row lg:gap-16">
          <div className="shrink-0 lg:max-w-[300px]">
            <Lockup />
            <p className="mt-4 text-sm text-muted-foreground">Sealed, single-price auctions on next week&rsquo;s GPU-hour: H100, H200 and A100 80 GB.</p>
            <p className="mt-2 text-sm text-muted-foreground">NEAR {network} only. No real money moves.</p>
          </div>
          <div className="grid flex-1 grid-cols-2 gap-x-8 gap-y-10 sm:grid-cols-3">
            {COLUMNS.map((c) => (
              <nav key={c.title} aria-label={`Footer: ${c.title}`}>
                <p className="text-sm font-medium text-foreground">{c.title}</p>
                <ul className="mt-4 list-none space-y-2.5 p-0">
                  {c.links.map((l) => (
                    <li key={l.href}>
                      {l.href.startsWith("/api") || l.href.endsWith(".txt") ? (
                        <a href={l.href} className="text-sm text-muted-foreground no-underline transition-colors hover:text-foreground">
                          {l.label}
                        </a>
                      ) : (
                        <Link href={l.href} className="text-sm text-muted-foreground no-underline transition-colors hover:text-foreground">
                          {l.label}
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              </nav>
            ))}
          </div>
        </div>
        <div className="mt-14 border-t border-border pt-6">
          <p className="text-xs text-muted-foreground">
            Built {new Date(builtAt * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC{spec ? ` from SPEC v${spec}` : ""}. No analytics, no cookies, no third-party scripts. Set in Geist and Geist Mono.
          </p>
        </div>
      </div>
    </footer>
  );
}
