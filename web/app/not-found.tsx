import Link from "next/link";
import type { CSSProperties } from "react";
import { Mark } from "@/components/logo.tsx";
import { layoutDies } from "@/lib/wafer.ts";
import { layoutDots } from "@/lib/dotmatrix.ts";
import { LINKS } from "@/lib/nav.ts";

// The 404: a wafer under test where the only dies that pass spell 404, and the heatsink looks
// up from behind it. The dies light once, one after another; under reduced motion they are lit.
const G = { cx: 240, cy: 132, r: 126, pitch: 12 };
const DIES = layoutDies(G);
const LIT = (() => {
  const { width, dots } = layoutDots("404");
  // Grid cell (i, j) relative to the wafer's centre, the text centred on it.
  return new Set(dots.map(([c, r]) => `${c - Math.floor(width / 2)}:${r - 3}`));
})();

export default function NotFound() {
  let i = 0;
  return (
    <main id="main">
      <div className="wrap">
        <section className="lost">
          <div className="lost-text">
            <span className="eyebrow">404 · No such page</span>
            <h1>No page at this address</h1>
            <p className="sub">Every die on this wafer was probed and none of them is the page you asked for. Every page on the site is listed below; the index is the place to start.</p>
          </div>
          <svg className="lost-art" viewBox="100 2 324 264" aria-hidden="true" focusable="false">
            <circle cx={G.cx} cy={G.cy} r={G.r} fill="var(--sheet)" stroke="var(--rule)" />
            {DIES.map((d) => {
              const key = `${Math.round((d.x + G.pitch / 2 - G.cx) / G.pitch)}:${Math.round((d.y + G.pitch / 2 - G.cy) / G.pitch)}`;
              const on = LIT.has(key);
              return <rect key={key} x={d.x + 1.2} y={d.y + 1.2} width={G.pitch - 2.4} height={G.pitch - 2.4} className={on ? "die-on" : "die-off"} style={on ? ({ "--i": i++ } as CSSProperties) : undefined} />;
            })}
            <g className="lost-sink" color="var(--ink)">
              <Mark x={340} y={190} width={72} height={72} size={72} />
            </g>
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
