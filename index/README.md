# @weir/index

On-demand GPU-hour price indexes, the prices Weir settles on: `H100-OD`, `H200-OD` and
`A100-80-OD`. This package fetches six public, keyless sources, computes each index in
micro-USD, writes an evidence bundle per chip, and lets anyone recompute both. The method
(`weir-gpu-od/2`), its sources and its limits are in [METHOD.md](METHOD.md); the study that
led to it is [CHIPS.md](CHIPS.md).

Needs Node 22.18 or later (it runs the `.ts` files directly). No runtime dependencies.

## Run

From the repository root:

```sh
node index/src/cli.ts fetch --chip all            # h100, h200 and a100-80, bucket = current hour
node index/src/cli.ts fetch --chip h200 --bucket 1794430800 --interval 3600 --out evidence/bundles
```

`--chip` is `h100` (the default), `h200`, `a100-80` or `all`. For each chip it prints one row
per provider (kind, value in USD, offer count and dropped placeholders, status or reason) and
the index, then writes `evidence/bundles/<chip>/<bucket>-<hash12>.json` in canonical form. Raw
bodies go to `evidence/bundles/raw/<sha256>.json`, one file per distinct body however many
chips share it (skip with `--no-raw`). It ends with the number of HTTP requests made: 6 for one
chip, 8 for all three (plus retries). The full 64-hex hash it prints is the `bundle` argument
of `report(bucket, price, bundle)`; `index` in the file is the `price`.

## Verify

```sh
node index/src/cli.ts verify evidence/bundles/h200/1794430800-9eb06ccea683.json
node index/src/cli.ts verify evidence/bundles/1794423600-1c0e2cb8b9c8.json   # version 1
```

Works for both method versions (`weir-h100-od/1` and `weir-gpu-od/2`, chosen by the bundle's
`method`). Prints every check and exits 1 if any fails. With the raw bodies present
(`<name>.raw/` for version 1, `../raw/` beside the chip directory for version 2, or
`--raw <dir>`) it also re-parses each body and checks its sha256.

The version-1 H100 first print stays at the top of `evidence/bundles/` with its `.raw/`
directory: the site (`web/`) reads that file by name.

## Test

```sh
cd index
pnpm test        # node --test, offline, against real responses in test/fixtures/
pnpm typecheck   # tsc --noEmit
pnpm run fetch   # CLI fetch (H100) into ../evidence/bundles (`pnpm fetch` is a pnpm built-in)
pnpm run verify ../evidence/bundles/<chip>/<file>.json
```

## Use from code

```ts
import { CHIPS, makeBundle, bundleHash, verifyBundle } from "@weir/index"; // browser-safe
import { fetchChips } from "@weir/index/fetch";                          // does the HTTP

for (const { chip, outcomes } of await fetchChips([CHIPS.h100, CHIPS.h200])) {
  const bundle = makeBundle(bucket, Math.floor(Date.now() / 1000), outcomes, chip);
  if (bundle.index !== null) report(chip.index_name, bucket, bundle.index, await bundleHash(bundle));
}
```

Callers written for H100 only keep working: `SOURCES` is `sourcesFor(CHIPS.h100)`, and
`makeBundle(bucket, fetched_at, outcomes)` defaults to H100 (it now writes a version-2 bundle).

### The fetcher

```ts
fetchAll(sources: readonly Source[], options?: FetchOptions): Promise<Fetched[]>
fetchChips(chips: readonly Chip[], options?: FetchOptions): Promise<{ chip: Chip; outcomes: Fetched[] }[]>
fetchSource(source: Source, options?: FetchOptions): Promise<Fetched>

interface FetchOptions {
  fetch?: (url: string, init: RequestInit) => Promise<Response>; // default: global fetch
  timeoutMs?: number;    // per attempt, default 15000
  retryDelayMs?: number; // default 2000
  retries?: number;      // default 1
}
```

- `fetch` is called once per attempt with the URL and a complete `RequestInit` (method,
  headers with `USER_AGENT`, body, and an abort `signal` for the timeout). Pass a metered,
  fake or scheduled function; a function shaped like the global `fetch` fits.
- Requests with the same `requestKey(source)` (method, URL, body) are made once per call and
  their body is shared, so `fetchAll` over several chips' sources, or `fetchChips`, does not
  multiply the load on sources that return every model at once.
- Nothing throws: a failed source is an outcome with `body: null` and an `error`, which
  `makeBundle` turns into an excluded provider (and, for Verda, the Shadeform fallback).
- `requestInit(source)` gives the request without the signal, for callers that send it
  themselves.

The keeper's own fetcher (one request per source, no retry, its metered `Fetch`) is
`fetchAll(sources, { fetch: meteredFetch, retries: 0 })` with this API.

## Layout

- `src/chips.ts`: the chip table (ids, names, index names, per-source matching rules), and `H100_V1`
- `src/method.ts`: prices, medians, the placeholder rule, provider rules, the fallback, the index rule, `makeBundle`
- `src/bundle.ts`: canonical JSON, `bundleHash`, `verifyBundle` and `verifyRaw` for both versions
- `src/sources/*.ts`: one pure `parse(json, chip)` per source, plus its call (`source(chip)`; `sourceV1` where version 1 differed)
- `src/fetch.ts`: HTTP with injectable fetch, timeout and retries, shared requests; `src/cli.ts`: the command line
- `test/fixtures/`: real responses of 2026-11-11 (the first day's at the top, the second set in `v2/`)
