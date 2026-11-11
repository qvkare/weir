# @weir/web

The Weir site: Next.js App Router on Cloudflare Workers through OpenNext. It reads the Weir
contract views over NEAR JSON-RPC, re-checks index bundles in the browser, runs the agents'
simulation in a Web Worker and draws every chart in hand-written SVG. Design brief: `DESIGN.md`.

## Run

```sh
pnpm install                              # from the repository root
pnpm --filter @weir/web dev:model         # model mode: every view answered by the engine, no chain
pnpm --filter @weir/web dev               # chain mode: reads the markets in deployments.json
pnpm --filter @weir/web test              # unit tests (node --test), lib/**/*.test.ts
pnpm --filter @weir/web typecheck
pnpm --filter @weir/web smoke             # next build, then every page and API route in model mode and with no markets
```

## Where the data comes from

| Source | When | How |
|---|---|---|
| Contract views | a market is listed in `../deployments.json` | `lib/near.ts`, JSON-RPC `call_function`, failing over across the `rpc` list; 4 s per-isolate cache, last good value kept for the error state |
| Model | `WEIR_MODEL=1` | `lib/model.ts`: the engine `Market` with the agents' presets, driven by a fixed script against the wall clock, answered through `callView`. A ribbon on every page says so |
| Nothing | neither | every live block says the market is not deployed yet; the rest of the site works |
| Index bundles | `bundles_base` set | fetched as `<base>/<hash>.json`, hashed with SubtleCrypto in the browser on `/proof` |
| Recorded bundle | always | the newest `../evidence/bundles/*.json`, inlined at build; fixture and fallback, labelled with its date |
| Transactions | JSON in `../evidence/` | tolerant reader in `lib/evidence.ts`, inlined at build |
| Backtest | `../backtest/results/site.json`, `summary.json`, `summary.md` | inlined at build; "Backtest file missing" when absent |
| Simulation | always | `@weir/agents/sim` in `lib/sim-worker.ts` |
| Quotes | `GET /api/quote` | `@weir/chain` IntentsClient, dry 1Click quotes on mainnet, server-side |

A Worker has no file system, so `next.config.ts` reads the repository files once at build
(`lib/build-data.ts`) and inlines them as `WEIR_BUILD`. Rebuild after `deployments.json`,
`evidence/` or `backtest/results/` change.

Environment: `WEIR_MODEL=1` (model mode), `WEIR_SITE_URL` (absolute address for link previews,
read at build), `WEIR_QUOTE_RECIPIENT` (NEAR mainnet account used in dry quotes; default a 64-hex
placeholder; nothing is ever sent to it).

## JSON endpoints

- `GET /api/status?m=weekly|fast`: `get_status`, `get_params`, last print, live series with floor, band and last clearing. `max-age=2`.
- `GET /api/round?m=…&series=…&round=…`: sealed book or result. `max-age=60` once cleared.
- `GET /api/quote?from=arbitrum|ethereum|solana|base&amount=20`: dry NEAR Intents quote.

Errors are `{ "error": { "code", "message" } }` with 400, 404 (`not_deployed`, `no_round`), 502 or 503.

## Deploy to Cloudflare Workers (not run here)

```sh
cd web
npx wrangler login
WEIR_SITE_URL=https://weir.<your-subdomain>.workers.dev pnpm run deploy   # opennextjs-cloudflare build && deploy
pnpm run preview                                                         # local Workers runtime on :8787
```

The Worker is named `weir`, `workers_dev` is on and there is no custom domain. pnpm skipped the
build scripts of `esbuild` and `workerd`; if `opennextjs-cloudflare` complains, run
`pnpm approve-builds` at the root first. Model mode on a Worker needs `WEIR_MODEL=1` as a Worker
variable.

## Regenerate the icons and the link preview

```sh
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node tools/og-image.ts
```

Writes `public/icon.svg`, `icon-32.png`, `apple-icon.png`, `icon-512.png` and
`opengraph-image.png` from the mark's geometry (`lib/logo.ts`) and the hero film's clearing
(`lib/film.ts`). Logo concepts, construction and usage rules: `DESIGN.md` section 3, files in `brand/`.

## Not built

- Wallet connection and the order form (scope: read-only first). `/auction` links to `/agents` instead.
- The fills table's refund column (not readable from views; see DESIGN.md section 10).
- No end-to-end test against a deployed contract: `deployments.json` lists no market yet, so chain mode is tested only for its "not deployed" state.
- Accessibility was checked by script (one `h1`, landmarks, labels, names, duplicate ids, heading order) and by hand at 375 px, not with axe or a screen reader.
