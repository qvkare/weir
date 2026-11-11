import type { ReactNode } from "react";
import { ExternalIcon } from "./icons.tsx";

/** A link that leaves the site, marked with the external icon and opened in a new tab. */
export function ExtLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} className={className} target="_blank" rel="noopener noreferrer">
      {children} <ExternalIcon />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
