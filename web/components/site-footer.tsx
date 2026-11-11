import Link from "next/link";
import { Lockup, Mark } from "./logo.tsx";

export function SiteFooter({ builtAt, spec }: { builtAt: number; spec: string | null }) {
  return (
    <footer className="site-footer">
      <div className="wrap">
        <div className="footer-level" aria-hidden="true">
          <span />
          <Mark width={26.7} height={20} />
          <span />
        </div>
        <div className="footer-cols">
          <div className="footer-brand">
            <Lockup />
            <p>One price for next week&rsquo;s GPU-hour.</p>
            <p className="tiny">NEAR testnet only. No real money moves.</p>
          </div>
          <nav aria-label="Footer: market">
            <b>Market</b>
            <ul>
              <li><Link href="/">Index</Link></li>
              <li><Link href="/auction">Auction</Link></li>
              <li><Link href="/simulate">Simulate</Link></li>
              <li><Link href="/backtest">Backtest</Link></li>
            </ul>
          </nav>
          <nav aria-label="Footer: read">
            <b>Read</b>
            <ul>
              <li><Link href="/how">How it works</Link></li>
              <li><Link href="/how#limits">Limits and trust</Link></li>
              <li><Link href="/proof">Contracts and checks</Link></li>
            </ul>
          </nav>
          <nav aria-label="Footer: for agents">
            <b>For agents</b>
            <ul>
              <li><Link href="/agents">Agent keys</Link></li>
              <li><a href="/api/status">/api/status</a></li>
              <li><a href="/api/round">/api/round</a></li>
              <li><a href="/llms.txt">/llms.txt</a></li>
            </ul>
          </nav>
        </div>
        <p className="footer-colophon tiny">
          Built {new Date(builtAt * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC{spec ? ` from SPEC v${spec}` : ""}. No analytics, no cookies, no third-party scripts. Set in Archivo and IBM Plex Mono.
        </p>
      </div>
    </footer>
  );
}
