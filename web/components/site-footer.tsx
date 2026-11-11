import Link from "next/link";

export function SiteFooter({ builtAt }: { builtAt: number }) {
  return (
    <footer className="site-footer">
      <div className="wrap cols">
        <div>
          <p>
            <b>Weir</b>. One price for next week&rsquo;s GPU-hour. NEAR testnet only; no real money moves.
          </p>
          <p className="tiny" style={{ marginTop: 8 }}>
            Built {new Date(builtAt * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC from SPEC v0.1. No analytics, no cookies, no third-party scripts.
          </p>
        </div>
        <div>
          <b>Read</b>
          <ul>
            <li>
              <Link href="/how#limits">Limits and trust</Link>
            </li>
            <li>
              <Link href="/proof">Contracts and checks</Link>
            </li>
            <li>
              <Link href="/backtest">Backtest</Link>
            </li>
          </ul>
        </div>
        <div>
          <b>For agents</b>
          <ul>
            <li>
              <a href="/api/status">/api/status</a>
            </li>
            <li>
              <a href="/api/round">/api/round</a>
            </li>
            <li>
              <a href="/llms.txt">/llms.txt</a>
            </li>
          </ul>
        </div>
      </div>
    </footer>
  );
}
