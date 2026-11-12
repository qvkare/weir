// The hero's backdrop (ours): a dusk landscape whose three ridgelines are the backtest's weekly
// H100 band cap, weekly average and band floor (lib/backdrop.ts). Static SVG, no script, no image
// file; grain from an SVG filter. Colours follow the theme.
import { BACKDROP, ridges } from "@/lib/backdrop.ts";

export function Backdrop({ series, id = "bd" }: { series: number[][]; /** Prefix for the SVG ids, so two backdrops can share a page. */ id?: string }) {
  const list = ridges(series);
  const { width: W, height: H } = BACKDROP;
  const u = (n: string) => `url(#${id}-${n})`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMax slice" className="h-full w-full" aria-hidden="true" focusable="false">
      <defs>
        {/* Dusk: a warm glow low in the sky, strongest just above the far ridge (app/site.css sets the colours per theme). */}
        <radialGradient id={`${id}-glow`} cx="50%" cy="40%" r="62%" fx="50%" fy="40%">
          <stop offset="0%" style={{ stopColor: "var(--dusk-1)", stopOpacity: "var(--dusk-a)" }} />
          <stop offset="28%" style={{ stopColor: "var(--dusk-2)", stopOpacity: "calc(var(--dusk-a) * 0.55)" }} />
          <stop offset="62%" style={{ stopColor: "var(--dusk-3)", stopOpacity: "calc(var(--dusk-a) * 0.16)" }} />
          <stop offset="100%" style={{ stopColor: "var(--dusk-3)", stopOpacity: 0 }} />
        </radialGradient>
        <linearGradient id={`${id}-fade`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#fff" stopOpacity="0" />
          <stop offset="20%" stopColor="#fff" stopOpacity="1" />
          <stop offset="80%" stopColor="#fff" stopOpacity="1" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <mask id={`${id}-mask`} maskUnits="userSpaceOnUse" x="0" y="0" width={W} height={H}>
          <rect width={W} height={H} fill={u("fade")} />
        </mask>
        <filter id={`${id}-grain`} x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
          <feComponentTransfer>
            <feFuncA type="linear" slope="0.09" />
          </feComponentTransfer>
        </filter>
      </defs>
      <g mask={u("mask")}>
        <rect width={W} height={H} fill={u("glow")} />
        {list.map((r) => (
          <g key={r.depth}>
            <path d={r.d} style={{ fill: `var(--ridge-${r.depth})` }} />
            {/* The crest, lit from the glow behind. */}
            <path d={r.d.split("L")[0]} fill="none" style={{ stroke: "var(--dusk-1)", strokeOpacity: `calc(var(--crest-a) * ${1 - r.depth * 0.3})` }} strokeWidth={1.4} />
          </g>
        ))}
        <rect width={W} height={H} filter={u("grain")} />
      </g>
    </svg>
  );
}
