# @weir/web

The Weir site: Next.js App Router, exported as static files and served by Cloudflare Workers
(free plan) with a small Worker for `/api` and old `?m=` links. Pages carry the figures the build
read from the Weir contracts, labelled with the build time; the browser then reads the contract
views itself over NEAR JSON-RPC. It re-checks index bundles in the browser, runs the agents'
simulation in a Web Worker and draws every chart in hand-written SVG; the wafer on the first
screen is a canvas cleared by the engine. Design brief: `DESIGN.md`. The homepage, header and footer use Tailwind v4 and five components adapted from Ruixen UI (MIT; `THIRD_PARTY_NOTICES.md`).

## Run

```sh
pnpm install                              # from the repository root
pnpm --filter @weir/web dev:model         # model mode: every view answered by the engine, no chain
pnpm --filter @weir/web dev               # chain mode: reads the markets in deployments.json
pnpm --filter @weir/web test              # unit tests (node --test), lib/**/*.test.ts
pnpm --filter @weir/web typecheck
pnpm --filter @weir/web smoke             # model build, then every page, redirect and API route through the Worker's routing
```

## Where the data comes from

| Source | When | How |
|---|---|---|
| Contract views | a market is listed in `../deployments.json` (`{ id, label, chip, contract, usdc }`, ids `h100-weekly`, `h100-fast`, `h200-weekly`, `a100-80-weekly`) | `lib/near.ts`, JSON-RPC `call_function`: once at build (the static figures), then from the visitor's browser. dRPC first, fastnear second (`rpcOrder`), whatever order `deployments.json` gives; a 429, 408, other HTTP error or 6 s timeout moves to the next, and when all fail the page says which endpoint said what and offers a retry (`lib/near.test.ts`) |
| Model | `WEIR_MODEL=1` at build | `lib/model.ts`: one engine `Market` per market of the agents' `MARKETS` (all four), driven by a fixed script, read once at build through `callView`. A ribbon on every page says so; nothing changes in the browser |
| Nothing | neither | every live block says the market is not deployed yet; the rest of the site works |
| Index bundles | `bundles_base` set | fetched as `<base>/<hash>.json`, hashed with SubtleCrypto in the browser on `/proof` |
| Recorded bundles | always | the newest bundle of each chip (`../evidence/bundles/<chip>/`, and the version-1 H100 file at the top level), inlined at build; fixture and fallback for the selected chip, labelled with its date |
| Specification, review record | always | `../docs/SPEC.md` and `../docs/AUDIT.md`, inlined at build and rendered at `/spec` and `/audit` |
| Transactions | JSON in `../evidence/` | tolerant reader in `lib/evidence.ts`, inlined at build |
| Backtest | `../backtest/results/site.json`, `summary.json`, `summary.md` | inlined at build; "Backtest file missing" when absent |
| Simulation | always | `@weir/agents/sim` in `lib/sim-worker.ts` |
| Quotes | `GET /api/quote` | `@weir/chain` IntentsClient, dry 1Click quotes on mainnet, server-side |

`next.config.ts` reads the repository files once at build (`lib/build-data.ts`) and hands them to
the server components as `WEIR_BUILD`; no client file imports them (the client chunks hold no
build data). Rebuild after `deployments.json`, `evidence/` or `backtest/results/` change.

Environment, at build: `WEIR_MODEL=1` (model mode), `WEIR_MODEL_NOW` (Unix seconds: pins the model's clock; the tests and the smoke script set it so they do not depend on the time of day), `WEIR_SITE_URL` (the site's address for
`metadataBase`, canonical links, the link preview, `robots.txt`, `sitemap.xml` and the code on
`/agents`; default `https://tryweir.com`, `lib/site.ts`). On the Worker, optional:
`WEIR_QUOTE_RECIPIENT` (NEAR mainnet account named in dry quotes; default a 64-hex placeholder;
nothing is ever sent to it). The site holds no secret.

## How it is served

`next build` writes `out/` (`output: "export"`): every page of the default market at its plain
path, every page of the other three at `/m/<market>/...`, plus `site.json` (RPC order, contracts,
security headers, all public) and `_headers` (the same headers for the assets Cloudflare serves
directly). The Worker (`worker/index.ts`, routing in `worker/route.ts`) runs only for the paths in
`run_worker_first` (`wrangler.jsonc`): the six per-market pages, to redirect `?m=<market>` (302 to
`/m/<market>/...`, other parameters kept), `/api/*`, and `/m/h100-weekly`, `/m/weekly`, `/m/fast`.

Measured on 13 Nov 2026 with a chain build of four markets (`wc -c` and `gzip -9` on `out/`). Homepage JS: 249,056 bytes gzipped (260,054 before the landscape and the four views replaced the price backdrop and the scroll text); `/auction` 235,327; `/simulate` 204,535. Homepage HTML: 328,794 bytes, 41,731 gzipped. The landscape adds no image files (inline SVG).

| Route | Served by | HTML, bytes (gzip) | Live data in the browser | Polls |
|---|---|---|---|---|
| `/`, `/m/<market>` | Worker, then asset; `/m/...` asset | 256,308 (38,143) | yes, about 15 views and 1 bundle on open | the round, the last print and the book's size every 30 s (hourly market 15 s) while visible |
| `/auction` (Round in progress) | Worker, then asset | 164,396 (25,946) | yes | the round and its book every 30 s (hourly 15 s) while visible |
| `/auction/book` | Worker, then asset | 101,074 (16,274) | yes | the book every 30 s (hourly 15 s) while visible |
| `/auction/clearings` | Worker, then asset | 119,555 (18,460) | yes, all rounds of the series | none: read once, and again when a round is picked |
| `/auction/prints` | Worker, then asset | 161,167 (22,650) | yes: 8 prints, each report's bundle fetched and hashed here | none: read once |
| `/agents` | Worker, then asset | 131,889 (22,563) | yes: each recorded account's balance, position, latest action | none: read once |
| `/proof`, `/proof/solvency` | Worker, then asset | 106,683 (16,662); 94,397 (15,481) | yes: keys, code hash, totals, the token balance | none: read once |
| `/proof/review`, `/proof/record` | Worker, then asset | 158,554 (26,477); 570,721 (51,340) | no: the review record and the deployment record as published | none |
| `/how` | Worker, then asset | 178,887 (35,204) | no: parameters and series as published, labelled | none |
| `/simulate` | Worker, then asset | 106,386 (15,868) | no: the state after setup is in the page; then it runs in a Web Worker | none |
| `/spec`, `/audit`, `/backtest` | asset | 184,268; 139,105; 269,681 | no | none |
| `/api/status`, `/api/round`, `/api/quote` | Worker | JSON, about 2 KB | reads the chain per request | none |

`/proof/record` is the largest: the 258 recorded transactions are in the HTML and again in Next's
inline page data. Every market page is one of nine views of one application frame (`lib/app-views.ts`,
`components/front/app/`); the other markets' are under `/m/<market>/...`. Polling stops while the tab is hidden (`components/live.tsx`).

Worker CPU, measured in Node 22.23 on an Apple M1 with the RPC answers replayed from memory
(network waiting is not CPU time): `route()` 0.39 ms on the first call, 3.7 µs after;
`/api/status` 0.45 ms on the first call, 0.07 ms after; `/api/round` 0.05 ms. Not measured on
Cloudflare. The free plan allows 10 ms of CPU per request.

## JSON endpoints

Served by the Worker (`lib/api-handlers.ts`), reading the chain from Cloudflare on each request.

- `GET /api/status?m=h100-weekly|h100-fast|h200-weekly|a100-80-weekly` (`weekly` and `fast` still accepted): `get_status`, `get_params`, last print, live series with floor, band and last clearing. `max-age=2`.
- `GET /api/round?m=…&series=…&round=…`: sealed book or result. `max-age=60` once cleared.
- `GET /api/quote?from=arbitrum|ethereum|solana|base&amount=20`: dry NEAR Intents quote.

Errors are `{ "error": { "code", "message" } }` with 400, 404 (`not_deployed`, `no_round`), 502 or 503.

## Deploy to Cloudflare Workers, free plan

```sh
cd web
npx wrangler login
pnpm run deploy   # next build && wrangler deploy
pnpm run preview  # next build && wrangler dev on :8787
```

The build reads the four markets from the chain once (dRPC first). The Worker is named `weir`,
`workers_dev` is on, preview URLs are off, and `wrangler.jsonc` attaches the custom domains
`tryweir.com` and `www.tryweir.com` (since 13 Nov 2026, 08:14 UTC). First deployed on 12 Nov 2026 at
20:14 UTC at https://weir.qvkare.workers.dev, which still answers. The first attempt to attach
the domain was refused because the registrar's parking records were still in the zone; they were
deleted and the second attempt went through. The bundle address stays on the keeper's
workers.dev host, because some network filters block newly registered domains for a while. `wrangler deploy
--dry-run` on 12 Nov 2026: Worker 22.67 KiB, 8.23 KiB gzipped; 245 asset files, 17 MB. Before
(OpenNext, every page rendered per request): 7079.72 KiB, 1577.73 KiB gzipped. A model build
(`WEIR_MODEL=1`) deploys the same way and shows model figures as of the build.

What the free plan does not show here: the request counts. Each view of a per-market page is
one Worker request (100,000 a day on the free plan); assets, including every `/m/...` page, are
not. The browser's RPC reads go from the visitor's address, so fastnear's per-IP limit applies to
each visitor, not to the site.

## Regenerate the icons and the link preview

```sh
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node tools/og-image.ts
```

Writes `public/icon.svg`, `icon-32.png`, `apple-icon.png`, `icon-512.png` and
`opengraph-image.png` from the mark's geometry (`lib/logo.ts`) and the homepage's headline and sentence. Mark construction and usage: `DESIGN.md` section 3, exports in
`brand/`. The three art-direction boards the identity came from are in `brand/proposals/`.

## Not built

- Wallet connection and the order form (scope: read-only first). `/auction` links to `/agents` instead.
- The fills table's refund column (not readable from views; see DESIGN.md section 10).
- The smoke test (`node scripts/smoke.ts`) sees the static HTML only: every page, every view of every market, the `?m=` redirects, every internal anchor, and that each item of the homepage window's sidebar opens a page showing that view. What the browser reads after load is covered by the loader tests (`lib/pages.test.ts`, on the model) and by one local Workers run against testnet on 12 Nov 2026 (`wrangler dev`): every page of the four markets, `?m=` redirects, a past round, at 375 px in both colour schemes. In that run the contracts each still held one full-access key, and the bundle host answered 404 for reports made before 12 Nov 2026, 19:15 UTC; Index prints counts those as "not published", apart from matched and did not match (`lib/verify.ts`, `summarizeChecks`, tested in `lib/verify.test.ts`).
- The error state with both RPC endpoints down was tested in Node (`lib/near.test.ts`), not in a browser.
- Accessibility was checked by script (one `h1`, landmarks, labels, names, duplicate ids, heading order) and by hand at 375 px, not with axe or a screen reader.
