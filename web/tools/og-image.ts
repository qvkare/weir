/**
 * Renders the identity's raster files from the same geometry the site uses:
 *   public/icon.svg            favicon: the small cut on an ink tile (a paper tile in dark tab bars)
 *   public/icon-32.png         favicon fallback, the small cut
 *   public/apple-icon.png      180 x 180, the full mark
 *   public/icon-512.png        512 x 512, the full mark
 *   public/opengraph-image.png 1200 x 630: lockup, the headline, and a still of the wafer
 * Run from web/:
 *
 *   CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node tools/og-image.ts
 *
 * Without CHROME it writes icon.svg and the HTML to the temp folder only. Chrome is not a
 * dependency of the site. The 32 px icon is drawn at 512 and reduced with macOS `sips`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dotPath, ROWS } from "../lib/dotmatrix.ts";
import { dollarsOfPrice, fmtInt } from "../lib/format.ts";
import { MARK } from "../lib/logo.ts";
import { dieLook, layoutDies, WAFER_T, WAFER_TICK, waferBook, waferProgress } from "../lib/wafer.ts";

const web = fileURLToPath(new URL("..", import.meta.url));
const font = (name: string) => readFileSync(join(web, "app/fonts", name)).toString("base64");
// The light theme's tokens (app/globals.css).
const C = { paper: "#ECECE8", sheet: "#F7F7F4", panel: "#E2E2DD", rule: "#C8C8C1", die: "#D3D3CC", ink: "#111214", ink2: "#4A4B50", long: "#2D43C4", lit: "#C99200", dark: "#0B0B0C", darkInk: "#EDEDEA" };

// Tiles: the mark at 3/4 of the tile, centred on its ink.
const mark = (cut: keyof typeof MARK, size: number, fg: string) => `<svg width="${size}" height="${size}" viewBox="${MARK[cut].viewBox}"><path d="${MARK[cut].d}" fill="${fg}" fill-rule="evenodd"/></svg>`;
const smallTile = `<path d="${MARK.small.d}" fill-rule="evenodd" transform="translate(4 4) scale(1)"/>`;
// The favicon is a 32 tile with the small cut drawn at 24 units, centred.
const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><style>.t{fill:${C.ink}}.m{fill:${C.paper}}@media (prefers-color-scheme:dark){.t{fill:${C.darkInk}}.m{fill:${C.ink}}}</style><rect class="t" width="32" height="32" rx="7"/><g class="m">${smallTile}</g></svg>\n`;
writeFileSync(join(web, "public", "icon.svg"), iconSvg);

// A still of the wafer, from the same engine clearing as the site's first screen.
const geom = { cx: 960, cy: 330, r: 300, pitch: 18 };
const dies = layoutDies(geom, { w: 1220, h: 650 });
const book = waferBook(dies, 20261112, 2_760_000, WAFER_TICK);
const t = WAFER_T.still;
const prog = waferProgress(t, geom);
const s = geom.pitch - 2.6;
const fills: Record<string, string[]> = {};
const hatch: string[] = [];
dies.forEach((d, k) => {
  const o = book.orders[k]!;
  const look = dieLook(t, d, geom.pitch, book.fill[k]!, o.size, prog);
  const long = o.side === "Long";
  const c = look === "sealed" || look === "out" ? C.die : long ? C.long : C.lit;
  const x = d.x + 1.3;
  const y = d.y + 1.3;
  (fills[c] ??= []).push(`M${x.toFixed(1)} ${y.toFixed(1)}h${s}v${s}h-${s}z`);
  if (!long && look !== "sealed" && look !== "out") hatch.push(`M${x.toFixed(1)} ${(y + s / 2).toFixed(1)}l${s / 2} -${s / 2}M${(x + s / 2).toFixed(1)} ${(y + s).toFixed(1)}l${s / 2} -${s / 2}`);
});
const wafer = `<svg width="1200" height="630" viewBox="0 0 1200 630" style="position:absolute;inset:0">
  <circle cx="${geom.cx}" cy="${geom.cy}" r="${geom.r}" fill="${C.sheet}" stroke="${C.rule}"/>
  ${Object.entries(fills).map(([c, d]) => `<path d="${d.join("")}" fill="${c}"/>`).join("")}
  <path d="${hatch.join("")}" stroke="${C.paper}" stroke-width="1.4" opacity=".8"/>
</svg>`;
const dots = (text: string, h: number, colour: string) => {
  const { width, d } = dotPath(text);
  return `<svg height="${h}" width="${(h * width) / ROWS}" viewBox="0 0 ${width} ${ROWS}" style="vertical-align:${-h * 0.22}px"><path d="${d}" fill="${colour}"/></svg>`;
};
const p = book.clearing.price === null ? "no trade" : `${dollarsOfPrice(book.clearing.price, WAFER_TICK)} /GPU-h`;

const head = `<meta charset="utf-8"><style>
@font-face{font-family:G;src:url(data:font/woff2;base64,${font("geist-latin-wght.woff2")}) format("woff2");font-weight:100 900}
@font-face{font-family:M;src:url(data:font/woff2;base64,${font("geist-mono-latin-wght.woff2")}) format("woff2");font-weight:100 900}
*{margin:0;box-sizing:border-box}body{background:${C.paper};color:${C.ink};font-family:G}
</style>`;

const og = `<!doctype html><html><head>${head}</head><body style="width:1200px;height:630px;overflow:hidden;position:relative">
${wafer}
<div style="position:absolute;inset:0;background:linear-gradient(90deg,${C.paper} 0 44%,transparent 64%)"></div>
<div style="position:absolute;inset:0;padding:56px 64px;display:flex;flex-direction:column;justify-content:space-between">
  <div style="display:flex;align-items:center;gap:14px;font-size:42px;line-height:1;font-weight:600;letter-spacing:-0.045em">${mark("full", 50, C.ink).replace("viewBox=\"0 0 48 48\"", `viewBox="${MARK.full.crop}"`)}<span>Weir</span></div>
  <div style="max-width:620px">
    <div style="font:600 80px/0.94 G;letter-spacing:-0.055em">Take the heat out of your ${dots("GPU bill.", 76, C.ink)}</div>
    <div style="font:400 26px/1.4 G;color:${C.ink2};margin-top:26px;max-width:520px">Sealed, single-price auctions on next week&rsquo;s H100 GPU-hour. NEAR testnet.</div>
  </div>
  <div style="font:400 16px M;color:${C.ink2};text-transform:uppercase;letter-spacing:.04em">Simulated round: ${fmtInt(dies.length)} sealed orders, cleared by the Weir engine at ${p}</div>
</div>
</body></html>`;

const iconPage = (size: number, cut: keyof typeof MARK) => `<!doctype html><html><head>${head}</head><body style="width:${size}px;height:${size}px;overflow:hidden;background:${C.ink};display:grid;place-items:center">${mark(cut, Math.round(size * 0.78), C.paper)}</body></html>`;

const chrome = process.env.CHROME;
const out = (name: string, html: string, w: number, h: number, dir = join(web, "public")) => {
  const file = join(tmpdir(), `weir-${name}.html`);
  writeFileSync(file, html);
  if (!chrome) return console.log(`wrote ${file}; set CHROME to render it`);
  execFileSync(chrome, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", "--default-background-color=00000000", `--window-size=${w},${h}`, `--screenshot=${join(dir, `${name}.png`)}`, `file://${file}`], { stdio: "ignore" });
  console.log(`rendered ${name}.png`);
};

out("opengraph-image", og, 1200, 630);
out("apple-icon", iconPage(180, "full"), 180, 180);
out("icon-512", iconPage(512, "full"), 512, 512);
if (chrome) {
  out("icon-small-512", iconPage(512, "small"), 512, 512, tmpdir());
  execFileSync("sips", ["-z", "32", "32", join(tmpdir(), "icon-small-512.png"), "--out", join(web, "public", "icon-32.png")], { stdio: "ignore" });
  console.log("reduced public/icon-32.png");
}
writeFileSync(
  join(web, "public", "opengraph-image.alt.txt"),
  `Weir: take the heat out of your GPU bill. The heatsink mark, the headline, and a wafer map of one simulated sealed round of ${fmtInt(dies.length)} orders, cleared by the Weir engine at ${p}: filled buyers lit in blue, filled sellers in hatched gold.\n`,
);
