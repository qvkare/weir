/**
 * Renders the identity's raster files from the same geometry the site uses:
 *   public/icon.svg            favicon: the small cut on an ink tile (a paper tile in dark tab bars)
 *   public/icon-32.png         favicon fallback, the small cut
 *   public/apple-icon.png      180 x 180, the full mark
 *   public/icon-512.png        512 x 512, the full mark
 *   public/opengraph-image.png 1200 x 630: lockup, the homepage headline and one sentence
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

const head = `<meta charset="utf-8"><style>
@font-face{font-family:G;src:url(data:font/woff2;base64,${font("geist-latin-wght.woff2")}) format("woff2");font-weight:100 900}
@font-face{font-family:M;src:url(data:font/woff2;base64,${font("geist-mono-latin-wght.woff2")}) format("woff2");font-weight:100 900}
*{margin:0;box-sizing:border-box}body{background:${C.paper};color:${C.ink};font-family:G}
</style>`;

// The link preview follows the homepage: the lockup, the headline in two tones, one sentence.
const og = `<!doctype html><html><head>${head}</head><body style="width:1200px;height:630px;overflow:hidden;position:relative;background:${C.dark};color:${C.darkInk}">
<div style="position:absolute;left:50%;top:330px;width:900px;height:300px;transform:translate(-50%,-50%);border-radius:50%;background:${C.darkInk};opacity:.06;filter:blur(80px)"></div>
<div style="position:absolute;inset:0;padding:56px 64px;display:flex;flex-direction:column;justify-content:space-between;align-items:center;text-align:center">
  <div style="align-self:flex-start;display:flex;align-items:center;gap:12px;font-size:34px;line-height:1;font-weight:600;letter-spacing:-0.045em">${mark("full", 40, C.darkInk).replace("viewBox=\"0 0 48 48\"", `viewBox="${MARK.full.crop}"`)}<span>Weir</span></div>
  <div>
    <div style="font:500 76px/1.04 G;letter-spacing:-0.035em">Next week&rsquo;s GPU hours,<br><span style="color:#A3A4A9">priced today.</span></div>
    <div style="font:400 26px/1.45 G;color:#A3A4A9;margin:28px auto 0;max-width:820px">Bid once, sealed. One price clears for everyone filled, and every position is paid in full when it opens.</div>
  </div>
  <div style="font:400 18px G;color:#A3A4A9">H100, H200 and A100 80 GB markets on NEAR testnet, with test dollars</div>
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
  "Weir. The mark and wordmark, the headline Next week’s GPU hours, priced today, one sentence on how a round clears, and the line: H100, H200 and A100 80 GB markets on NEAR testnet, with test dollars.\n",
);
