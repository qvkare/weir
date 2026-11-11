# @weir/index

H100-OD: the on-demand price of one NVIDIA H100 GPU-hour, the index Weir settles on.
This package fetches six public, keyless sources, computes the index in micro-USD,
writes an evidence bundle, and lets anyone recompute both. The method, its sources and
its limits are in [METHOD.md](METHOD.md).

Needs Node 22.18 or later (it runs the `.ts` files directly). No runtime dependencies.

## Run

From the repository root:

```sh
node index/src/cli.ts fetch                      # bucket = current hour
node index/src/cli.ts fetch --bucket 1794423600 --interval 3600 --out evidence/bundles
```

It prints one row per provider (kind, value in USD, offer count, status or reason) and the
index, then writes `evidence/bundles/<bucket>-<hash12>.json` in canonical form, plus the raw
bodies in `<bucket>-<hash12>.raw/` (skip with `--no-raw`). The full 64-hex hash it prints is the `bundle` argument
of `report(bucket, price, bundle)`; `index` in the file is the `price`.

## Verify

```sh
node index/src/cli.ts verify evidence/bundles/1794423600-1c0e2cb8b9c8.json
```

Prints every check and exits 1 if any fails. With the `.raw` directory present it also
re-parses each raw body and checks its sha256.

## Test

```sh
cd index
pnpm test        # node --test, offline, against real responses in test/fixtures/
pnpm typecheck   # tsc --noEmit
pnpm run fetch   # CLI fetch into ../evidence/bundles (`pnpm fetch` is a pnpm built-in)
pnpm run verify ../evidence/bundles/<file>.json
```

## Use from code

```ts
import { makeBundle, bundleHash, verifyBundle } from "@weir/index"; // browser-safe
import { fetchAll } from "@weir/index/fetch";                       // does the HTTP
import { SOURCES } from "@weir/index";

const bundle = makeBundle(bucket, Math.floor(Date.now() / 1000), await fetchAll(SOURCES));
if (bundle.index !== null) report(bucket, bundle.index, await bundleHash(bundle));
```

## Layout

- `src/method.ts`: prices, medians, provider rules, the index rule, `makeBundle`
- `src/bundle.ts`: canonical JSON, `bundleHash`, `verifyBundle`, `verifyRaw`
- `src/sources/*.ts`: one pure `parse` per source, plus its call
- `src/fetch.ts`: HTTP (15 s timeout, one retry); `src/cli.ts`: the command line
