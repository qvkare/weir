import Link from "next/link";
import { LINKS } from "@/lib/nav.ts";

export default function NotFound() {
  return (
    <main id="main">
      <div className="wrap">
        <section className="lost">
          <div className="lost-text">
            <span className="eyebrow">404</span>
            <h1>No page at this address</h1>
            <p className="sub">The level runs out here. Every page on the site is listed below; the index is the place to start.</p>
          </div>
          <svg className="lost-art" viewBox="0 0 480 170" aria-hidden="true" focusable="false">
            <path className="lost-level" pathLength={1} d="M0 40H150L162.5 81.7L175 40L187.5 81.7L200 40H320" fill="none" stroke="var(--ink)" strokeWidth={8} strokeMiterlimit={2} />
            <path className="lost-drop" d="M320 40V150H480" fill="none" stroke="var(--ink-3)" strokeWidth={2} strokeDasharray="4 6" />
            <text x="336" y="138" className="lost-404">
              404
            </text>
          </svg>
        </section>
        <nav aria-label="All pages" className="lost-links">
          <ul>
            {LINKS.map((l) => (
              <li key={l.href}>
                <Link href={l.href}>
                  <span>{l.label}</span>
                  <span aria-hidden="true">&rarr;</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </main>
  );
}
