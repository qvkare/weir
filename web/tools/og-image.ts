/**
 * Renders public/opengraph-image.png (1200 x 630) and public/apple-icon.png (180 x 180) in the
 * site's style: paper, ink, and a step chart cleared by the engine. Run from web/:
 *
 *   CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node tools/og-image.ts
 *
 * Without CHROME it only writes the HTML to the temp folder. Chrome is not a dependency of the site.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { clearRound, type Order } from "@weir/engine";
import { stepGeometry } from "../lib/step.ts";

const web = fileURLToPath(new URL("..", import.meta.url));
const font = (name: string) => readFileSync(join(web, "app/fonts", name)).toString("base64");

// An example round, cleared by the engine: the picture is the mechanism, not a market reading.
const tick = 10_000;
const band = 80 * tick;
const orders: (Order & { owner: string })[] = [
  { seq: 0, owner: "a", side: "Long", size: 30, price: 52 * tick },
  { seq: 1, owner: "b", side: "Long", size: 25, price: 44 * tick },
  { seq: 2, owner: "c", side: "Long", size: 30, price: 36 * tick },
  { seq: 3, owner: "d", side: "Long", size: 20, price: 24 * tick },
  { seq: 4, owner: "e", side: "Short", size: 25, price: 20 * tick },
  { seq: 5, owner: "f", side: "Short", size: 30, price: 30 * tick },
  { seq: 6, owner: "g", side: "Short", size: 25, price: 40 * tick },
  { seq: 7, owner: "h", side: "Short", size: 30, price: 56 * tick },
];
const c = clearRound(orders, tick);
const g = stepGeometry({ orders: orders.map((o, i) => ({ ...o, filled: c.fills[i]! })), band, price: c.price, volume: c.volume, cleared: true, width: 560, height: 420 });
const seg = (s: { x1: number; y1: number; x2: number; y2: number }) => `M${s.x1},${s.y1}L${s.x2},${s.y2}`;
const thin = (list: typeof g.demand) => list.map(seg).join("");
const thick = (list: typeof g.demand) => list.filter((s) => s.filled).map(seg).join("");
const cl = g.clearing!;

const chart = `<svg width="560" height="420" viewBox="0 0 560 420">
  <rect x="${cl.longRect.x}" y="${cl.longRect.y}" width="${cl.longRect.w}" height="${cl.longRect.h}" fill="#EBD5C6"/>
  <rect x="${cl.shortRect.x}" y="${cl.shortRect.y}" width="${cl.shortRect.w}" height="${cl.shortRect.h}" fill="#C9DAD7"/>
  ${g.yTicks.map((t) => `<line x1="${g.plot.x0}" x2="${g.plot.x1}" y1="${t.y}" y2="${t.y}" stroke="#D6D0C2"/>`).join("")}
  <line x1="${g.plot.x0}" x2="${g.plot.x1}" y1="${g.plot.y1}" y2="${g.plot.y1}" stroke="#17150F"/>
  <path d="${thin(g.demand)}" stroke="#B23F0C" stroke-opacity=".5" fill="none"/>
  <path d="${thin(g.supply)}" stroke="#0A6670" stroke-opacity=".5" fill="none"/>
  <path d="${thick(g.demand)}" stroke="#B23F0C" stroke-width="5" fill="none"/>
  <path d="${thick(g.supply)}" stroke="#0A6670" stroke-width="5" fill="none"/>
  <line x1="${g.plot.x0}" x2="${g.plot.x1}" y1="${cl.y}" y2="${cl.y}" stroke="#17150F" stroke-width="3"/>
  <line x1="${cl.x}" x2="${cl.x}" y1="${g.plot.y0}" y2="${g.plot.y1}" stroke="#17150F" stroke-dasharray="6 5"/>
  <text x="${g.plot.x1}" y="${cl.y - 10}" text-anchor="end" class="lbl">One clearing price</text>
  <text x="${g.plot.x0 + 6}" y="${g.plot.y0 + 18}" class="lbl" fill="#B23F0C">Demand (LONG)</text>
  <text x="${g.plot.x0 + 6}" y="${g.plot.y1 - 12}" class="lbl" fill="#0A6670">Supply (SHORT)</text>
</svg>`;

const mark = `<svg width="56" height="56" viewBox="0 0 32 32"><rect x="1" y="1" width="30" height="30" rx="4" fill="#17150F"/><path d="M5 21h7l4-8 4 8h7" fill="none" stroke="#F7F5EF" stroke-width="2.5" stroke-linejoin="round"/><path d="M5 13h22" stroke="#B23F0C" stroke-width="2.5"/></svg>`;

const head = `<meta charset="utf-8"><style>
@font-face{font-family:A;src:url(data:font/woff2;base64,${font("archivo-latin-wdth-wght.woff2")}) format("woff2");font-weight:100 900;font-stretch:62% 125%}
@font-face{font-family:M;src:url(data:font/woff2;base64,${font("ibm-plex-mono-latin-400.woff2")}) format("woff2")}
*{margin:0;box-sizing:border-box}body{background:#F7F5EF;color:#17150F;font-family:A}
.lbl{font:600 17px A;fill:#17150F}
</style>`;

const og = `<!doctype html><html><head>${head}</head><body style="width:1200px;height:630px;overflow:hidden">
<div style="display:flex;height:630px;padding:56px 56px 48px;gap:40px;border-bottom:10px solid #17150F">
  <div style="flex:1;display:flex;flex-direction:column;justify-content:space-between">
    <div style="display:flex;align-items:center;gap:16px">${mark}<span style="font-size:44px;font-weight:800;font-stretch:125%">Weir</span>
      <span style="margin-left:12px;border:2px solid #17150F;border-radius:4px;padding:2px 10px;font-size:20px;font-weight:600">Testnet</span></div>
    <div>
      <div style="font-size:66px;line-height:1.02;font-weight:800;font-stretch:112%;letter-spacing:-0.02em">One price for next week&rsquo;s GPU-hour</div>
      <div style="font-size:25px;line-height:1.35;color:#5A5446;margin-top:22px;max-width:520px">Sealed rounds on the H100 index. Everyone filled pays the same price. Every position paid in full when it opens.</div>
    </div>
    <div style="font:18px M;color:#5A5446">weir:v1|series|round|account|side|size|price|salt</div>
  </div>
  <div style="width:560px;display:flex;align-items:center">${chart}</div>
</div></body></html>`;

const icon = `<!doctype html><html><head>${head}</head><body style="width:180px;height:180px;overflow:hidden;background:#17150F">
<svg width="180" height="180" viewBox="0 0 32 32"><rect width="32" height="32" fill="#17150F"/><path d="M5 21h7l4-8 4 8h7" fill="none" stroke="#F7F5EF" stroke-width="2.5" stroke-linejoin="round"/><path d="M5 13h22" stroke="#B23F0C" stroke-width="2.5"/></svg></body></html>`;

const out = (name: string, html: string, w: number, h: number) => {
  const file = join(tmpdir(), `weir-${name}.html`);
  writeFileSync(file, html);
  const chrome = process.env.CHROME;
  if (!chrome) return console.log(`wrote ${file}; set CHROME to render it`);
  execFileSync(chrome, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", `--window-size=${w},${h}`, `--screenshot=${join(web, "public", `${name}.png`)}`, `file://${file}`], { stdio: "inherit" });
  console.log(`rendered public/${name}.png`);
};

out("opengraph-image", og, 1200, 630);
out("apple-icon", icon, 180, 180);
writeFileSync(join(web, "public", "opengraph-image.alt.txt"), "Weir: one price for next week's GPU-hour. A step chart of an example sealed round: demand falls, supply rises, and one clearing price fills both sides.\n");
