# Evidence

What Weir has recorded, kept so that anyone can check it without trusting the authors. Nothing here holds a secret key.

## What is here

| Path | What | Produced by | Verified by |
|---|---|---|---|
| `bundles/1794423600-1c0e2cb8b9c8.json` | The first H100 print, 2026-11-11 19:00 UTC bucket, method `weir-h100-od/1`: 2.76 USD | `node index/src/cli.ts fetch` as it was then | `make verify-index` (113 checks) |
| `bundles/1794423600-1c0e2cb8b9c8.raw/` | The six raw responses behind that print, one file per source | the same run | the same: each file's sha256 against the bundle, then re-parsed |
| `bundles/<chip>/<bucket>-<hash12>.json` | One bundle per chip per run, method `weir-gpu-od/2`. `<chip>` is `h100`, `h200` or `a100-80` | `node index/src/cli.ts fetch --chip all --out evidence/bundles`, or `make index OUT=evidence/bundles` | `make verify-index`, or `node index/src/cli.ts verify <file>` |
| `bundles/raw/<sha256>.json` | Every raw response body of version-2 runs, stored once by its own sha256, however many chips share it | the same fetch | the verifier finds each body by the `raw_sha256` in the bundle and checks it |
| `deploy/` | Not present yet. Deployment records from `node deploy/src/cli.ts apply` (`record.json`: accounts, code hashes, parameters as read from chain, public keys, transaction hashes) | the deploy tool, then copied here by hand | `make verify-deploy`, which today prints "no deployment recorded yet" and fails if a record appears before a read-back is wired in |

Recorded today: the version-1 H100 print and one version-2 run of all three chips (bucket 1794430800, 2026-11-11 21:00 UTC, fetched 21:54 UTC): H100-OD 2.90 USD, H200-OD 4.25 USD, A100-80-OD 1.55125 USD, with 8 raw bodies (1.2 MB).

## What a bundle is

A bundle is the canonical JSON of one index computation: every provider with its offers, dropped placeholders, value or reason for exclusion, the sha256 of the raw response it came from, and the index. The bundle's own sha256 is the `bundle` argument a reporter posts on chain with `report(bucket, price, bundle)`, and `index` is the `price`. The method is in `index/METHOD.md`.

## What verification shows, and what it does not

`node index/src/cli.ts verify <bundle>` recomputes every provider value and the index from the offers, checks the placeholder rule, the exclusions, sorting and canonical form, that the file name matches its hash, and, with the raw bodies present, that each body hashes to its `raw_sha256` and parses to exactly the offers in the bundle. It exits 1 if any check fails.

It cannot show that the raw bodies are what the sources really served at that time: they were fetched by the authors. Re-fetching gives today's prices, not the recorded ones. What makes a past print checkable is that its bundle hash, once posted on chain, fixes these files.

## What is not here yet

- Deployment records and run records from a public network: nothing is deployed.
- Records of transactions. When they exist, the site reads any JSON file under `evidence/` outside `bundles/` that lists objects with a transaction hash (`web/lib/evidence.ts`).
