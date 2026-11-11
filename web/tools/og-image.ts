/**
 * Renders the identity's raster files from the same geometry the site uses:
 *   public/icon.svg            favicon (compact mark on a tile; swaps for dark tab bars)
 *   public/icon-32.png         favicon fallback
 *   public/apple-icon.png      180 x 180
 *   public/icon-512.png        512 x 512 (manifests, app stores, slides)
 *   public/opengraph-image.png 1200 x 630, with the hero film's final frame
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
import { MARK } from "../lib/logo.ts";
import { buildFilm } from "../lib/film.ts";
import { dollarsOfPrice } from "../lib/format.ts";
import { stepGeometry } from "../lib/step.ts";

const web = fileURLToPath(new URL("..", import.meta.url));
const font = (name: string) => readFileSync(join(web, "app/fonts", name)).toString("base64");
const C = { paper: "#F7F5EF", panel: "#EDEAE1", rule: "#D6D0C2", ink: "#17150F", ink2: "#5A5446", long: "#B23F0C", short: "#0A6670", longSoft: "#EBD5C6", shortSoft: "#C9DAD7", darkInk: "#EEEAE0" };

// The tile: compact mark at 22/24 of a 32 tile, centred on its strokes.
const tilePath = `<path d="${MARK.compact.d}" transform="translate(5 5.2) scale(0.9167)" fill="none" stroke-width="${MARK.compact.stroke}" stroke-miterlimit="2"/>`;
// PNG tiles are full-bleed squares: iOS and most launchers round the corners themselves.
const tile = (bg: string, fg: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="${bg}"/><g stroke="${fg}">${tilePath}</g></svg>`;
const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><style>.t{fill:${C.ink}}.m{stroke:${C.paper}}@media (prefers-color-scheme:dark){.t{fill:${C.darkInk}}.m{stroke:${C.ink}}}</style><rect class="t" width="32" height="32" rx="7"/><g class="m">${tilePath}</g></svg>\n`;
writeFileSync(join(web, "public", "icon.svg"), iconSvg);

const wide = (h: number, colour: string) => `<svg width="${(h * 32) / 14.25}" height="${h}" viewBox="${MARK.wide.crop}" overflow="visible"><path d="${MARK.wide.d}" fill="none" stroke="${colour}" stroke-width="${MARK.wide.stroke}" stroke-miterlimit="2"/></svg>`;

// The hero film's last frame, from the same engine clearing.
const film = buildFilm();
const W = 560;
const H = 380;
const g = stepGeometry({ orders: film.tickets, band: film.band, price: film.price, volume: film.volume, cleared: true, width: W, height: H });
const cl = g.clearing!;
const seg = (s: { x1: number; y1: number; x2: number; y2: number }) => `M${s.x1},${s.y1}L${s.x2},${s.y2}`;
const thin = (list: typeof g.demand) => list.map(seg).join("");
const thick = (list: typeof g.demand) => list.filter((s) => s.filled).map(seg).join("");
const p = dollarsOfPrice(film.price, film.tick);

const chart = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" overflow="visible">
  <rect x="${cl.longRect.x}" y="${cl.longRect.y}" width="${cl.longRect.w}" height="${cl.longRect.h}" fill="${C.longSoft}"/>
  <rect x="${cl.shortRect.x}" y="${cl.shortRect.y}" width="${cl.shortRect.w}" height="${cl.shortRect.h}" fill="${C.shortSoft}"/>
  ${g.yTicks.map((t) => `<line x1="${g.plot.x0}" x2="${g.plot.x1}" y1="${t.y}" y2="${t.y}" stroke="${C.rule}"/>`).join("")}
  <line x1="${g.plot.x0}" x2="${g.plot.x1}" y1="${g.plot.y1}" y2="${g.plot.y1}" stroke="${C.ink}"/>
  <path d="${thin(g.demand)}" stroke="${C.long}" stroke-opacity=".55" stroke-width="2" fill="none"/>
  <path d="${thin(g.supply)}" stroke="${C.short}" stroke-opacity=".55" stroke-width="2" fill="none"/>
  <path d="${thick(g.demand)}" stroke="${C.long}" stroke-width="6" fill="none"/>
  <path d="${thick(g.supply)}" stroke="${C.short}" stroke-width="6" fill="none"/>
  <line x1="${cl.x}" x2="${cl.x}" y1="${cl.y}" y2="${g.plot.y1}" stroke="${C.ink}" stroke-dasharray="5 5" stroke-width="1.5"/>
  <line x1="${g.plot.x0}" x2="${W + 80}" y1="${cl.y}" y2="${cl.y}" stroke="${C.ink}" stroke-width="3.5"/>
  <circle cx="${cl.x}" cy="${cl.y}" r="9" fill="${C.paper}" stroke="${C.ink}" stroke-width="3.5"/>
  <text x="${g.plot.x1 - 4}" y="${cl.y - 14}" text-anchor="end" class="lbl">One price ${p}</text>
  <text x="${g.plot.x0 + 8}" y="${g.steps.find((s) => s.side === "Long")!.y - 14}" class="lbl" style="fill:${C.long}">Demand, LONG</text>
  <text x="${g.plot.x0 + 8}" y="${g.steps.find((s) => s.side === "Short")!.y + 28}" class="lbl" style="fill:${C.short}">Supply, SHORT</text>
</svg>`;

const head = `<meta charset="utf-8"><style>
@font-face{font-family:A;src:url(data:font/woff2;base64,${font("archivo-latin-wdth-wght.woff2")}) format("woff2");font-weight:100 900;font-stretch:62% 125%}
@font-face{font-family:M;src:url(data:font/woff2;base64,${font("ibm-plex-mono-latin-400.woff2")}) format("woff2")}
*{margin:0;box-sizing:border-box}body{background:${C.paper};color:${C.ink};font-family:A}
.lbl{font:650 18px A;fill:${C.ink}}
</style>`;

const og = `<!doctype html><html><head>${head}</head><body style="width:1200px;height:630px;overflow:hidden;position:relative">
<div style="position:absolute;inset:0;padding:56px 64px;display:flex;flex-direction:column;justify-content:space-between">
  <div style="display:flex;align-items:baseline;gap:14px;font-size:44px;line-height:1">${wide(31.5, C.ink)}<span style="font-weight:800;font-stretch:125%;letter-spacing:-0.02em">Weir</span>
    <span style="margin-left:auto;align-self:center;border:2px solid ${C.ink};border-radius:4px;padding:4px 12px;font-size:20px;font-weight:600;letter-spacing:0">NEAR testnet</span></div>
  <div style="max-width:520px">
    <div style="font-size:70px;line-height:0.98;font-weight:800;font-stretch:112%;letter-spacing:-0.03em">One price for next week&rsquo;s GPU-hour</div>
    <div style="font-size:25px;line-height:1.35;color:${C.ink2};margin-top:24px">Sealed rounds on the H100 index. Everyone filled pays the same price. Every position is paid in full when it opens.</div>
  </div>
  <div style="font:17px M;color:${C.ink2}">Example round, cleared by the Weir engine: ${p} for ${film.volume} GPU-h</div>
</div>
<div style="position:absolute;right:64px;top:150px">${chart}</div>
</body></html>`;

const iconPage = (size: number) => `<!doctype html><html><head>${head}</head><body style="width:${size}px;height:${size}px;overflow:hidden;background:${C.ink}">${tile(C.ink, C.paper).replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`;

const chrome = process.env.CHROME;
const out = (name: string, html: string, w: number, h: number) => {
  const file = join(tmpdir(), `weir-${name}.html`);
  writeFileSync(file, html);
  if (!chrome) return console.log(`wrote ${file}; set CHROME to render it`);
  execFileSync(chrome, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", "--default-background-color=00000000", `--window-size=${w},${h}`, `--screenshot=${join(web, "public", `${name}.png`)}`, `file://${file}`], { stdio: "ignore" });
  console.log(`rendered public/${name}.png`);
};

out("opengraph-image", og, 1200, 630);
out("apple-icon", iconPage(180), 180, 180);
out("icon-512", iconPage(512), 512, 512);
if (chrome) {
  execFileSync("sips", ["-z", "32", "32", join(web, "public", "icon-512.png"), "--out", join(web, "public", "icon-32.png")], { stdio: "ignore" });
  console.log("reduced public/icon-32.png");
}
writeFileSync(
  join(web, "public", "opengraph-image.alt.txt"),
  `Weir: one price for next week's GPU-hour. The final frame of an example sealed round cleared by the Weir engine: demand steps down, supply steps up, and one clearing price of ${p} fills both sides.\n`,
);
