// The site's pages, in header order.
export const LINKS = [
  { href: "/", label: "Index" },
  { href: "/auction", label: "Auction" },
  { href: "/simulate", label: "Simulate" },
  { href: "/backtest", label: "Backtest" },
  { href: "/how", label: "How it works" },
  { href: "/proof", label: "Proof" },
  { href: "/agents", label: "Agents" },
] as const;

/** The header's links; the auction is its button. */
export const HEADER_LINKS = [
  { href: "/how", label: "How it works" },
  { href: "/simulate", label: "Simulate" },
  { href: "/backtest", label: "Backtest" },
  { href: "/proof", label: "Proof" },
  { href: "/agents", label: "Agents" },
] as const;
