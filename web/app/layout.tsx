import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import { SiteFooter } from "@/components/site-footer.tsx";
import { SiteHeader } from "@/components/site-header.tsx";
import { MOTION_SCRIPT, THEME_SCRIPT } from "@/lib/reduced-motion.ts";
import { buildData, deployments, isModel, liveMarkets } from "@/lib/build.ts";
import "./globals.css";

// Geist and Geist Mono, both variable in weight (OFL; licence in app/fonts). Figures to remember
// are drawn in the dot-matrix face (lib/dotmatrix.ts), which needs no font file.
const sans = localFont({
  src: "./fonts/geist-latin-wght.woff2",
  weight: "100 900",
  variable: "--font-sans",
  display: "swap",
});

const mono = localFont({
  src: "./fonts/geist-mono-latin-wght.woff2",
  weight: "100 900",
  variable: "--font-mono",
  display: "swap",
});

const TITLE = "Weir: take the heat out of your GPU bill";
const DESCRIPTION =
  "Weir runs sealed, single-price auctions on next week's GPU-hour, one market per chip: H100, H200 and A100 80 GB. Teams that need compute buy LONG, people who own GPUs buy SHORT, every position is paid in full when it opens, and the index is the median of named reporters whose data anyone can re-hash. NEAR testnet.";

export const metadata: Metadata = {
  // Set WEIR_SITE_URL at build time to the deployed address so link previews resolve.
  metadataBase: new URL(process.env.WEIR_SITE_URL ?? "http://localhost:3000"),
  title: { default: TITLE, template: "%s | Weir" },
  description: DESCRIPTION,
  openGraph: { siteName: "Weir", title: TITLE, description: DESCRIPTION, type: "website", images: [{ url: "/opengraph-image.png", width: 1200, height: 630, alt: "Weir. The heatsink mark, the line Take the heat out of your GPU bill, and a wafer map of one simulated sealed round with the filled orders lit in blue and gold." }] },
  twitter: { card: "summary_large_image", title: "Weir", description: DESCRIPTION, images: ["/opengraph-image.png"] },
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon-32.png", type: "image/png", sizes: "32x32" },
      { url: "/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    apple: "/apple-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ECECE8" },
    { media: "(prefers-color-scheme: dark)", color: "#0B0B0C" },
  ],
};

/** Patterns every drawing shares: the seller's hatch, a sealed cover, the substrate's dots. */
function SharedDefs() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true" focusable="false">
      <defs>
        <pattern id="hatch-short" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="4" height="4" fill="var(--short-soft)" />
          <line x1="0" y1="0" x2="0" y2="4" stroke="var(--short)" strokeWidth="1.6" />
        </pattern>
        <pattern id="hatch-short-soft" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="5" height="5" fill="var(--short-soft)" />
          <line x1="0" y1="0" x2="0" y2="5" stroke="var(--short)" strokeWidth="0.9" strokeOpacity="0.7" />
        </pattern>
        <pattern id="hatch-sealed" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="4" height="4" fill="var(--panel)" />
          <line x1="0" y1="0" x2="0" y2="4" stroke="var(--rule)" strokeWidth="1.2" />
        </pattern>
        <pattern id="dots" width="5" height="5" patternUnits="userSpaceOnUse">
          <circle cx="2.5" cy="2.5" r="0.8" fill="var(--rule)" />
        </pattern>
      </defs>
    </svg>
  );
}

export default function RootLayout({ children }: { children: ReactNode }) {
  const model = isModel();
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT + ";" + MOTION_SCRIPT }} />
      </head>
      <body>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <SharedDefs />
        {model ? (
          <div className="ribbon" role="note">
            <b>Model</b> Model data, not the chain. Market figures here come from the Weir engine running a fixed script on this server.
          </div>
        ) : null}
        <SiteHeader network={deployments().network} markets={liveMarkets()} />
        {children}
        <SiteFooter builtAt={buildData().builtAt} spec={buildData().specVersion} />
      </body>
    </html>
  );
}
