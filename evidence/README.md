# Evidence

What Weir has recorded, kept so that anyone can check it without trusting the authors. Nothing here holds a secret key.

## What is here

| Path | What | Produced by | Verified by |
|---|---|---|---|
| `bundles/1794423600-1c0e2cb8b9c8.json` | The first H100 print, 2026-11-11 19:00 UTC bucket, method `weir-h100-od/1`: 2.76 USD | `node index/src/cli.ts fetch` as it was then | `make verify-index` (113 checks) |
| `bundles/1794423600-1c0e2cb8b9c8.raw/` | The six raw responses behind that print, one file per source | the same run | the same: each file's sha256 against the bundle, then re-parsed |
| `bundles/<chip>/<bucket>-<hash12>.json` | One bundle per chip per run, method `weir-gpu-od/2`. `<chip>` is `h100`, `h200` or `a100-80` | `node index/src/cli.ts fetch --chip all --out evidence/bundles`, or `make index OUT=evidence/bundles` | `make verify-index`, or `node index/src/cli.ts verify <file>` |
| `bundles/raw/<sha256>.json` | Every raw response body of version-2 runs, stored once by its own sha256, however many chips share it | the same fetch | the verifier finds each body by the `raw_sha256` in the bundle and checks it |
| `deploy/<network>-<suffix>.json` | A deployment record (below) | `node deploy/src/cli.ts apply`, which writes `deploy/out/<network>/record.json`; copied here by hand | `make verify-deploy`, or `node deploy/src/cli.ts verify <file>`: read back from the public chain with no keys |

Recorded today: the version-1 H100 print and one version-2 run of all three chips (bucket 1794430800, 2026-11-11 21:00 UTC, fetched 21:54 UTC): H100-OD 2.90 USD, H200-OD 4.25 USD, A100-80-OD 1.55125 USD, with 8 raw bodies (1.2 MB).

## What a bundle is

A bundle is the canonical JSON of one index computation: every provider with its offers, dropped placeholders, value or reason for exclusion, the sha256 of the raw response it came from, and the index. The bundle's own sha256 is the `bundle` argument a reporter posts on chain with `report(bucket, price, bundle)`, and `index` is the `price`. The method is in `index/METHOD.md`.

## What verification shows, and what it does not

`node index/src/cli.ts verify <bundle>` recomputes every provider value and the index from the offers, checks the placeholder rule, the exclusions, sorting and canonical form, that the file name matches its hash, and, with the raw bodies present, that each body hashes to its `raw_sha256` and parses to exactly the offers in the bundle. It exits 1 if any check fails.

It cannot show that the raw bodies are what the sources really served at that time: they were fetched by the authors. Re-fetching gives today's prices, not the recorded ones. What makes a past print checkable is that its bundle hash, once posted on chain, fixes these files.

## deploy/: deployment records

A record is the `record.json` the deploy tool writes when `apply` finishes: the tool version, the
sha256 and NEAR code hash of each wasm it deployed, every account it created and why, each market's
parameters as read from the chain, every public key with its kind (full access, or function call
with its receiver contract, method list and allowance), the agents' deposits and limits, and
every transaction hash with its purpose. It holds no secret key (`apply` refuses to write one).

```sh
node deploy/src/cli.ts verify evidence/deploy/<file>.json          # what make verify-deploy runs for each file
node deploy/src/cli.ts verify evidence/deploy/<file>.json --txs    # also looks up every transaction hash
```

`verify` reads the chain and checks code hashes, parameters, reporters and every function-call key
against the record, and says whether each contract is sealed. It does not show that the reporters
are honest, that the keeper is running, or that the code was built from this source unless you
build the wasm yourself; `deploy/README.md`, "Reading a record back", says what it shows and what
it does not. A record is a snapshot: after a key rotation or a seal, the new `record.json` must be
copied here again.

## What is not here yet

- Run records (trading, settlement) from a public network.
- Records of transactions beyond those in the deployment records. When they exist, the site reads any JSON file under `evidence/` outside `bundles/` that lists objects with a transaction hash (`web/lib/evidence.ts`).
