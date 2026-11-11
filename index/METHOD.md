# H100-OD, method `weir-h100-od/1`

H100-OD is the US-dollar price of one NVIDIA H100 GPU-hour bought **on demand**: not
spot, not interruptible, not reserved. Any H100 form factor counts (SXM, PCIe, NVL). A
reporter computes it once per bucket, posts it on chain as `report(bucket, price, bundle)`
(see `docs/SPEC.md` section 9), and publishes the bundle so anyone can recompute it.

## What is measured

Every price is an integer number of **micro-USD per GPU-hour** (2.76 USD = `2760000`).

- A **constituent is a provider**, with one vote. A provider's **value** is the median of
  its qualifying offers' prices per GPU-hour.
- **Median**: sort; odd count takes the middle value; even count takes the mean of the two
  middle values rounded down to a micro-USD.
- **Conversion**: a source's decimal (a JSON string, or a JSON number read through its
  shortest round-trip text, e.g. `2.5355555555555553`) is turned into micro-USD with exact
  integer arithmetic, dividing by the GPU count (and by 100 for cents) in the same step,
  then **rounding half up**. No floating-point arithmetic touches a price, so the same
  response always gives the same numbers.

## Sources

Every call is public and keyless. Each one is made once per run with a 15-second timeout,
one retry after 2 seconds, and the User-Agent `weir-index/0.1 (H100 on-demand price index;
public keyless endpoints)`.

| id | kind | call | qualifying offers | price per GPU-hour |
|---|---|---|---|---|
| `vast` | open-market | `POST https://console.vast.ai/api/v0/bundles/`, `Content-Type: application/json`, body `{"gpu_name":{"in":["H100 SXM","H100 PCIE","H100 NVL"]},"rentable":{"eq":true},"type":"on-demand","limit":1000}` | `offers[]` with `verification == "verified"` and `reliability2 >= 0.95` | `dph_total / num_gpus` |
| `runpod` | rate-card | `POST https://api.runpod.io/graphql`, body `{"query":"query { gpuTypes { id displayName securePrice communityPrice } }"}` | every non-null `securePrice` and `communityPrice` of `gpuTypes[]` whose `displayName` contains `H100` | the price as given |
| `akash` | open-market | `GET https://console-api.akash.network/v1/gpu-prices` | `models[]` entries with `model == "h100"` | `price.med`, taken as the provider value; `availability` and `providerAvailability` are recorded in the provider's `note` |
| `lium` | open-market | `GET https://lium.io/api/executors` | entries whose `machine_name` contains `H100` | `price_per_gpu` |
| `verda` | rate-card | `GET https://api.verda.com/v1/instance-types` | entries with `model == "H100"` and `currency == "usd"` | `price_per_hour / gpu.number_of_gpus` (never `spot_price`) |
| `shadeform` | rate-card | `GET https://api.shadeform.ai/v1/instances/types?gpu_type=H100` | `instance_types[]` with `configuration.gpu_type == "H100"` and at least one `availability[]` entry with `rental_type == "on_demand"` | `hourly_price` (US **cents per instance**) `/ 100 / configuration.num_gpus` |

Special rules:

- **vast**: an offer's `sku` is `<host_id>/<offer id>`. Each host gets one price, the median
  of its qualifying offers, and the provider value is the median across hosts. Fewer than
  3 hosts: excluded, reason `too few hosts (n)`.
- **shadeform** resells many clouds. Each distinct `cloud` is its own provider (id = the
  cloud name, e.g. `lambdalabs`, `nebius`), valued at the median of that cloud's SKUs. A
  cloud that is the same company as a direct source (`vast`/`vastai`, `runpod`, `akash`,
  `lium`, `verda`/`datacrunch`) is dropped in favour of the direct source, always, even if
  the direct fetch failed; it appears as provider `shadeform:<cloud>`, excluded with reason
  `duplicate of <id>`.

## Rules

1. A provider is **excluded, with its reason in the bundle**, when its fetch fails
   (`fetch failed: …`), the body is not the expected shape (`unreadable response: …`), it
   has no qualifying offer, it fails a source rule above, or its value is outside 0.20 to
   50.00 USD inclusive. Nothing is carried forward from an earlier bucket and nothing is
   interpolated.
2. `vast`, `akash` and `lium` are `open-market` (anyone can list); the rest are `rate-card`.
3. The **index is the median of the included provider values**. It needs at least 6
   included providers, of which at least 3 are `rate-card`. Otherwise the bundle has
   `index: null` and a `reason`, and no price should be reported for that bucket.

## Bundle

One JSON document per run, written to `evidence/bundles/<bucket>-<first 12 hex of hash>.json`:

```
{ "method": "weir-h100-od/1", "bucket": <unix s, multiple of the interval>, "fetched_at": <unix s>,
  "providers": [ { "id", "kind", "source", "url", "status": "included"|"excluded", "reason"?,
                   "value"?: <micro-USD, included only>, "note"?: string,
                   "offers": [ { "sku", "price" } ], "raw_sha256" } ],
  "index": <micro-USD> | null, "reason"?: string }
```

- `offers` are the qualifying ones only, sorted by `sku` then `price`; `providers` are sorted
  by `id`. An excluded provider still lists the offers that were parsed, so the reason can
  be checked. `note` is an addition to the brief's format, used only for Akash availability.
- `raw_sha256` is the sha256 of the exact response body the offers came from (for a failed
  fetch, the sha256 of the empty string).
- **Canonical form**: UTF-8 JSON, object keys sorted by code unit, no insignificant
  whitespace, absent optional fields omitted. The **bundle hash**, which is the `bundle`
  argument of `report`, is the sha256 of the canonical form in lowercase hex. Through
  `raw_sha256` it commits to the raw responses too.
- The CLI also stores the raw bodies next to the bundle, in `<same name>.raw/<source>.json`.

## How to verify

`node index/src/cli.ts verify <bundle.json>` checks, and exits non-zero if any check fails:

- every included provider's value, recomputed from its offers (vast: host medians, at least 3 hosts);
- every excluded provider's reason holds: its offers really fail a rule, or it is a
  duplicate, or it has no offers (fetch or shape failure);
- kinds, sort order, integer prices, the method id, and the index recomputed from the values
  (or the reason there is none);
- that the file is in canonical form and its name matches its hash;
- if the `.raw` directory is present: each body's sha256 equals `raw_sha256`, and parsing it
  again gives exactly the provider entries in the bundle.

The same `verifyBundle` and `bundleHash` (in `src/bundle.ts`) run in a browser: they use only
standard JS and Web Crypto. Re-fetching cannot reproduce a past bundle, because prices
change; the raw bodies are what make a past bundle checkable.

## Differences from the brief, found on 2026-11-11

- Shadeform names Lambda `lambdalabs`, not `lambda`. It also lists `verda`, which is
  dropped as a duplicate. No `vastai`, `runpod`, `akash` or `datacrunch` rows appeared.
- Shadeform `availability[]` entries carry `rental_type` `on_demand` or `spot` per region,
  and `hourly_price` is per instance type, not per rental type. The method keeps a row if it
  is offered on demand anywhere (all 39 rows were, that day; Nebius also offers spot).
- Vast returns `{ "offers": [...], "truncated": false }` and sends `x-ratelimit-limit: 30.0`.
  It returned only 22 rentable H100 offers (7 to 10 qualifying, on 5 to 8 hosts).
- Akash has a single `h100` entry (`ram: "80Gi"`, `interface: "SXM5"`). If several appear,
  each one's `price.med` becomes an offer and the provider value is their median.
- Verda prices are JSON strings (`"5.087"`), so they are converted exactly from the text.
  The filter is `model == "H100"`, and the GPU count is `gpu.number_of_gpus`.
- Lium returns a bare JSON array; H100 executors are named `NVIDIA H100 80GB HBM3`.

## Limits

- These are **asking prices and rate cards, not trades**. Nothing here shows that anyone
  paid these prices, how much capacity was available at them, or what discounts were given.
- The **open-market sources are thin and anyone can list there**. Vast had only a handful
  of verified hosts; one host listing low or high moves its value. A seller could list
  H100s on Vast, Akash or Lium to nudge the index. Medians and one vote per provider limit
  the effect, they do not remove it.
- **Shadeform is a single upstream for many providers** (13 of the 18 included on the first
  run). An error, a markup change or an outage there moves or removes most rate cards at
  once, and its prices may differ from each cloud's own published rates.
- **Rate cards move in steps** and can stay stale for weeks; a GPU listed at a rate card
  may be unavailable at that price.
- **A provider can change its API** at any time: a renamed field excludes the provider
  (shape error) or, worse, silently changes what a filter matches. Bundles carry the raw
  hash so such changes can be found after the fact.
- The index is computed by each reporter separately. Two reporters fetching a few seconds
  apart can see different offers on the open-market sources; the on-chain median of
  reports absorbs this, but bundles from different reporters will not be identical.

## Cross-checks

Two independent public figures to compare against by eye. They are **not** used in the index.

- Ornn OCPI-H100 transaction index, `https://data.ornn.com/api/public-index/gpu/H100%20SXM/index-history`:
  latest point 2026-11-10, **3.10 USD** (3.37 on 11-08, 3.30 on 11-09).
- 500.farm Vast median of rented, verified machines, `https://500.farm/vastai-exporter/gpu-stats`,
  at 2026-11-11 19:26 UTC: H100 SXM **2.86 USD** (101 rented), H100 PCIE 2.84 (25), H100 NVL 3.12 (26).

On the same day H100-OD read **2.76 USD** (first print, bucket 1794423600), and its `vast`
value was 2.60 USD. Ours sits below both: it is a median of list prices over many smaller
clouds, whereas Ornn measures transactions and 500.farm measures what was actually rented
(its median for verified H100 SXM machines still available was 2.675 USD, close to ours).
