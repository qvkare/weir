// The views of the Weir application: the frame the homepage pictures and the market pages use.
// Each view is a page with its own address (the default market's at the plain path, the others
// under /m/<market>), listed here once for the sidebar, the routes, the sitemap and the smoke test.

import type { MarketId } from "./config.ts";

export type AppSection = "auction" | "agents" | "proof" | "try";

export interface AppView {
  id: string;
  section: AppSection;
  /** The part after the section, "" for the section's own page. */
  slug: string;
  /** The default market's address. */
  path: string;
  label: string;
  /** Sidebar group. */
  group: "Views" | "Proof";
  /** One sentence, for the page's description. */
  description: string;
  /** The sidebar lists it for these markets only (the page itself is written for every market). */
  only?: readonly MarketId[];
}

export const APP_VIEWS: AppView[] = [
  { id: "round", section: "auction", slug: "", path: "/auction", label: "Round in progress", group: "Views", description: "The sealed round in progress: its phase, countdown, locked dollars and the series clock." },
  { id: "book", section: "auction", slug: "book", path: "/auction/book", label: "Sealed book", group: "Views", description: "Every commit of the round in progress: owner, hash, lock and state; sides and sizes once revealed." },
  { id: "clearings", section: "auction", slug: "clearings", path: "/auction/clearings", label: "Clearings", group: "Views", description: "Every cleared round of the series, with a round's two curves and its fills." },
  { id: "prints", section: "auction", slug: "prints", path: "/auction/prints", label: "Index prints", group: "Views", description: "The index prints, each with its reports, checked in your browser; the chart and the sources." },
  { id: "try", section: "try", slug: "", path: "/try", label: "Test bid", group: "Views", only: ["h100-fast"], description: "Place one sealed bid in the hourly market from this browser, with a throwaway testnet account and test dollars." },
  { id: "agents", section: "agents", slug: "", path: "/agents", label: "Agents", group: "Views", description: "The accounts trading on this market, their keys and latest actions, and how to give an agent a key that cannot withdraw." },
  { id: "contracts", section: "proof", slug: "", path: "/proof", label: "Contracts", group: "Proof", description: "The contracts, their keys and code, and the parameters set at deployment." },
  { id: "solvency", section: "proof", slug: "solvency", path: "/proof/solvency", label: "Solvency", group: "Proof", description: "What the contract owes, against the dollars it holds." },
  { id: "review", section: "proof", slug: "review", path: "/proof/review", label: "Review", group: "Proof", description: "The review's verdict, what you are trusting today, and every finding with its status." },
  { id: "record", section: "proof", slug: "record", path: "/proof/record", label: "Record", group: "Proof", description: "The deployment's transactions, grouped by what they did." },
];

/** The views the sidebar lists for a market. */
export const viewsFor = (market: MarketId): AppView[] => APP_VIEWS.filter((v) => !v.only || v.only.includes(market));

export const viewById = (id: string): AppView => APP_VIEWS.find((v) => v.id === id) ?? APP_VIEWS[0]!;

export const viewOf = (section: AppSection, slug: string | undefined): AppView | null => APP_VIEWS.find((v) => v.section === section && v.slug === (slug ?? "")) ?? null;

/** The view a path shows (/auction/book, /m/h200-weekly/proof/review); null for other pages. */
export function viewOfPage(page: string): AppView | null {
  return APP_VIEWS.find((v) => v.path === page) ?? null;
}

/**
 * Old addresses and anchors, from before the views: where their content lives now. A hash on a
 * section's page is forwarded in the browser (components/front/app/shell.tsx).
 */
export const MOVED_ANCHORS: Record<AppSection, Record<string, string>> = {
  auction: { series: "/auction#series", "book-h": "/auction/book", "recent-h": "/auction/clearings", "r-h": "/auction/clearings", "prev-h": "/auction/clearings" },
  agents: {},
  try: {},
  proof: { contracts: "/proof", params: "/proof#params", audited: "/proof/review", sandbox: "/proof/review#sandbox", solvency: "/proof/solvency", verifier: "/auction/prints#verifier", index: "/auction/prints#index", sources: "/auction/prints#sources", transactions: "/proof/record" },
};
