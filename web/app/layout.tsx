import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import { SiteFooter } from "@/components/site-footer.tsx";
import { SiteHeader } from "@/components/site-header.tsx";
import { THEME_SCRIPT } from "@/components/theme-toggle.tsx";
import { buildData, deployments, isModel } from "@/lib/build.ts";
import "./globals.css";

// Archivo carries both axes: width 62 to 125 and weight 100 to 900.
const sans = localFont({
  src: "./fonts/archivo-latin-wdth-wght.woff2",
  weight: "100 900",
  variable: "--font-sans",
  display: "swap",
  declarations: [{ prop: "font-stretch", value: "62% 125%" }],
});

const mono = localFont({
  src: [
    { path: "./fonts/ibm-plex-mono-latin-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-mono-latin-500.woff2", weight: "500", style: "normal" },
  ],
  variable: "--font-mono",
  display: "swap",
});

const DESCRIPTION =
  "Weir runs sealed, uniform-price auctions on next week's H100 GPU-hour. Buyers hold LONG, sellers hold SHORT, every position is paid in full when it opens, and the index is the median of named reporters whose data anyone can re-hash. NEAR testnet.";

export const metadata: Metadata = {
  // Set WEIR_SITE_URL at build time to the deployed address so link previews resolve.
  metadataBase: new URL(process.env.WEIR_SITE_URL ?? "http://localhost:3000"),
  title: { default: "Weir: one price for next week's GPU-hour", template: "%s | Weir" },
  description: DESCRIPTION,
  openGraph: { siteName: "Weir", title: "Weir: one price for next week's GPU-hour", description: DESCRIPTION, type: "website", images: [{ url: "/opengraph-image.png", width: 1200, height: 630, alt: "Weir. A sealed auction step chart: demand falls, supply rises, one clearing price." }] },
  twitter: { card: "summary_large_image", title: "Weir", description: DESCRIPTION, images: ["/opengraph-image.png"] },
  icons: { icon: [{ url: "/icon.svg", type: "image/svg+xml" }], apple: "/apple-icon.png" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F7F5EF" },
    { media: "(prefers-color-scheme: dark)", color: "#13120E" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const model = isModel();
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <a className="skip" href="#main">
          Skip to content
        </a>
        {model ? (
          <div className="ribbon" role="note">
            Model data, not the chain. Market figures here come from the Weir engine running a fixed script on this server.
          </div>
        ) : null}
        <SiteHeader network={deployments().network} />
        {children}
        <SiteFooter builtAt={buildData().builtAt} spec={buildData().specVersion} />
      </body>
    </html>
  );
}
