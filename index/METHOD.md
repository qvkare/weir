# GPU on-demand indexes, method `weir-gpu-od/2`

Each index is the US-dollar price of one GPU-hour of one chip bought **on demand**: not spot,
not interruptible, not reserved. Every form factor of the chip counts (SXM, PCIe, NVL). A
reporter computes it once per bucket per chip, posts it on chain as `report(bucket, price,
bundle)` (see `docs/SPEC.md` section 9), and publishes the bundle so anyone can recompute it.

| chip id | chip | index |
|---|---|---|
| `h100` | NVIDIA H100 | `H100-OD` |
| `h200` | NVIDIA H200 | `H200-OD` |
| `a100-80` | NVIDIA A100 80GB | `A100-80-OD` |

The chip is a parameter: `src/chips.ts` is the only place a chip is defined. The rule below is
the same for every chip. Version 1 (`weir-h100-od/1`, H100 only) is described at the end; its
bundles stay valid under it.

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

Every call is public and keyless, with a 15-second timeout, one retry after 2 seconds, and the
User-Agent `weir-index/0.2 (GPU on-demand price index; public keyless endpoints)`. Identical
requests are made once per run: RunPod, Akash, Lium, Verda and Shadeform each return every
model in one response, so one run makes **6 requests for one chip and 8 for all three** (Vast
is asked once per chip), plus one retry per failed request.

| id | kind | call | qualifying offers | price per GPU-hour |
|---|---|---|---|---|
| `vast` | open-market | `POST https://console.vast.ai/api/v0/bundles/`, `Content-Type: application/json`, body `{"gpu_name":{"in":<names>},["gpu_ram":{"gte":<MB>},]"rentable":{"eq":true},"verified":{"eq":true},"reliability2":{"gte":0.95},"type":"on-demand","limit":64}`, one call per chip | `offers[]` with `verification == "verified"`, `reliability2 >= 0.95`, `gpu_name` in the names and, if the chip has one, `gpu_ram` at least the bound | `dph_total / num_gpus` |
| `runpod` | rate-card | `POST https://api.runpod.io/graphql`, body `{"query":"query { gpuTypes { id displayName securePrice communityPrice } }"}` | every non-null `securePrice` and `communityPrice` of `gpuTypes[]` whose `displayName` is one of the chip's | the price as given |
| `akash` | open-market | `GET https://console-api.akash.network/v1/gpu-prices` | `models[]` entries with the chip's `model` (and `ram`, if the chip names one) | `price.med`, one offer per entry; `availability` and `providerAvailability` go in the provider's `note` |
| `lium` | open-market | `GET https://lium.io/api/executors` | entries whose `machine_name` is one of the chip's | `price_per_gpu` |
| `verda` | rate-card | `GET https://api.verda.com/v1/instance-types` | entries whose `model` is one of the chip's, with `currency == "usd"` | `price_per_hour / gpu.number_of_gpus` (never `spot_price`) |
| `shadeform` | rate-card | `GET https://api.shadeform.ai/v1/instances/types` (unfiltered: every GPU type) | `instance_types[]` whose `configuration.gpu_type` is one of the chip's, with at least one `availability[]` entry with `rental_type == "on_demand"` | `hourly_price` (US **cents per instance**) `/ 100 / configuration.num_gpus` |

Names are matched **exactly**, never by substring. The names, as each source spelled them on
2026-11-11:

| chip | vast `gpu_name` | runpod `displayName` | akash `model` | lium `machine_name` | verda `model` | shadeform `gpu_type` |
|---|---|---|---|---|---|---|
| `h100` | `H100 SXM`, `H100 PCIE`, `H100 NVL` | `H100 SXM`, `H100 PCIe`, `H100 NVL` | `h100` | `NVIDIA H100 80GB HBM3`, `NVIDIA H100 PCIe` | `H100` | `H100`, `H100_nvl` |
| `h200` | `H200`, `H200 NVL` | `H200 SXM`, `H200 NVL` | `h200` (none listed) | `NVIDIA H200`, `NVIDIA H200 NVL` | `H200` | `H200` |
| `a100-80` | `A100 SXM4`, `A100 PCIE`, with `gpu_ram >= 70000` | `A100 SXM`, `A100 PCIe` (not `A100 SXM 40GB`) | `a100` with `ram == "80Gi"` | none (Lium lists no A100) | `A100 80GB` | `A100_80G` |

A name is added to the table only once a source has been seen to use it (Akash's `h200` is the
one exception: it follows Akash's lower-case naming, so an H200 listing would be picked up).

Source rules:

- **vast**: an offer's `sku` is `<host_id>/<offer id>`. Each host gets one price, the median
  of its qualifying offers, and the provider value is the median across hosts. Fewer than
  3 hosts: excluded, reason `too few hosts (n)`.
- **vast returns at most 64 offers per call**, whatever `limit` says. The query therefore
  asks for exactly what qualifies (the chip's names and memory, verified, `reliability2 >=
  0.95`, rentable, on demand), so that the 64 are qualifying offers and not the first 64 of
  everything. The provider's `note` records how many offers came back and whether the cap
  was hit (`… the 64-offer cap was hit, so these are a sample`). When it is hit, the value is
  the median of a sample chosen by Vast's default ordering, not of the whole market. On
  2026-11-11 no chip came near it (H100 3 offers, H200 14, A100 80 GB 3).
- **shadeform** resells many clouds. Each distinct `cloud` is its own provider (id = the
  cloud name, e.g. `lambdalabs`, `nebius`), valued at the median of that cloud's SKUs. A
  cloud that is the same company as a direct source (`vast`/`vastai`, `runpod`, `akash`,
  `lium`, `verda`/`datacrunch`) appears as provider `shadeform:<cloud>` and is excluded with
  reason `duplicate of <id>`: the direct source wins, because the two prices differ (Verda
  direct H100 5.087, through Shadeform 3.31).
- **Fallback to the reseller**: when that direct source gave no usable response (`fetch
  failed: …` or `unreadable response: …`), the `shadeform:<cloud>` rows are not dropped but
  priced like any other provider, and its `note` says `stands in for <id>, whose direct
  response could not be used`. The company keeps one vote either way. A direct source that
  answered but lists no qualifying offer does not trigger the fallback. Only Verda appears
  in Shadeform today.

## Rules

1. **Placeholder offers.** Let the reference be the median of every offer parsed for the chip
   in this bundle, across all providers (excluded ones and duplicates included). An offer with
   `price × 4 < reference` (below 25 % of it) is a placeholder: it is moved from the provider's
   `offers` to its `dropped` list with the reason `placeholder: below 25% of the median offer
   <reference> USD`, and takes no part in the provider's value. Everything here is recomputable
   from the bundle: the reference is the median of all `offers` and `dropped` it holds.
2. A provider is **excluded, with its reason in the bundle**, when its fetch fails
   (`fetch failed: …`), the body is not the expected shape (`unreadable response: …`), it
   has no qualifying offer left, it fails a source rule above, or its value is outside 0.20 to
   50.00 USD inclusive. Nothing is carried forward from an earlier bucket and nothing is
   interpolated.
3. `vast`, `akash` and `lium` are `open-market` (anyone can list); the rest are `rate-card`.
4. The **index is the median of the included provider values**. Every chip needs at least 6
   included providers, of which at least 3 are `rate-card`. Otherwise the bundle has
   `index: null` and a `reason`, and no price should be reported for that bucket.

What the placeholder rule does and does not do:

- It catches prices that are not prices: RunPod lists `0` (A100 SXM 40GB secure) and `0.50`
  (H200 NVL community, MI300X community, and others, sometimes above the secure price). On
  2026-11-11 it dropped exactly one offer across the three chips: RunPod's H200 NVL community
  at 0.50 (reference 4.25), which moved RunPod's H200 value from 3.69 to 3.79 (the H200 index
  stayed 4.25).
- It is **one-sided**: a placeholder set too high is not caught (the 50.00 cap is far away).
- It catches only gross outliers: a placeholder above 25 % of the median stays (a 0.50 on a
  chip whose median is under 2.00, such as an RTX card, would not be dropped).
- The reference is a median of offers, not of providers, so a source with many offers (Lium,
  Vast) weighs more in it; a seller listing many cheap offers could move it, but would need
  to drag the median of all offers down by a factor of 4 to protect a placeholder.
- It does not catch prices for capacity that does not exist (Akash entries with zero
  availability keep their `price.med`).

## Bundle

One JSON document per chip per run, written to `evidence/bundles/<chip>/<bucket>-<first 12 hex of hash>.json`:

```
{ "method": "weir-gpu-od/2", "chip": "h100"|"h200"|"a100-80", "index_name": "H100-OD"|…,
  "bucket": <unix s, multiple of the interval>, "fetched_at": <unix s>,
  "providers": [ { "id", "kind", "source", "url", "status": "included"|"excluded", "reason"?,
                   "value"?: <micro-USD, included only>, "note"?: string,
                   "offers": [ { "sku", "price" } ],
                   "dropped"?: [ { "sku", "price", "reason" } ], "raw_sha256" } ],
  "index": <micro-USD> | null, "reason"?: string }
```

- `offers` are the qualifying ones only and `dropped` the placeholders (present only when not
  empty), each sorted by `sku` then `price`; `providers` are sorted by `id`. An excluded
  provider still lists the offers that were parsed, so the reason can be checked. `note`
  carries Akash availability, the Vast offer count and cap, and the fallback.
- `raw_sha256` is the sha256 of the exact response body the offers came from (for a failed
  fetch, the sha256 of the empty string). Sources shared by several chips have the same
  `raw_sha256` in each chip's bundle.
- **Canonical form**: UTF-8 JSON, object keys sorted by code unit, no insignificant
  whitespace, absent optional fields omitted. The **bundle hash**, which is the `bundle`
  argument of `report`, is the sha256 of the canonical form in lowercase hex. Through
  `chip` it commits to the market, and through `raw_sha256` to the raw responses.
- The CLI stores each raw body once, by content, in `evidence/bundles/raw/<sha256>.json`,
  however many chips (or later buckets) share it.

## How to verify

`node index/src/cli.ts verify <bundle.json>` checks, and exits non-zero if any check fails.
`verifyBundle` dispatches on `method`: a `weir-h100-od/1` bundle is checked under version 1, a
`weir-gpu-od/2` bundle under version 2, anything else fails.

- the method id; for version 2, that `chip` is supported and `index_name` is its index;
  for version 1, that neither field nor any `dropped` list is present;
- every provider entry re-derived from its offers (kept and dropped together): the split into
  `offers` and `dropped` against the recomputed reference, the value (vast: host medians, at
  least 3 hosts), the exclusion reason, the duplicate or fallback status of reseller rows;
- a provider whose source failed holds no offers, and a failed fetch carries the empty-body hash;
- kinds, sort order, integer prices, and the index recomputed from the values (or the reason
  there is none);
- that the file is in canonical form, its name matches its hash, and (version 2) its
  directory is its chip;
- if the raw bodies are present (`<name>.raw/<source>.json` for version 1,
  `evidence/bundles/raw/<sha256>.json` for version 2, or `--raw <dir>`): each body's sha256
  equals `raw_sha256`, and parsing it again under the bundle's method and chip gives exactly
  the provider entries in the bundle.

What verification cannot show without the raw bodies: that a failed fetch really failed (a
bundle can claim Verda failed to bring in its Shadeform rows), and that `chip` and
`index_name` were not changed together (the offers would still be self-consistent). Both
change the bundle hash, so they cannot pass for a bundle whose hash is on chain, and the raw
bodies expose both.

The same `verifyBundle` and `bundleHash` (in `src/bundle.ts`) run in a browser: they use only
standard JS and Web Crypto. Re-fetching cannot reproduce a past bundle, because prices
change; the raw bodies are what make a past bundle checkable.

## Changes from version 1 (`weir-h100-od/1`)

- **The chip is a parameter** (`chips.ts`); H200 and A100 80 GB are new markets. The method
  id is `weir-gpu-od/2` for every chip, and the bundle carries `chip` and `index_name`.
- **Exact names** instead of substrings for RunPod (`displayName` contained `H100`) and Lium
  (`machine_name` contained `H100`). For H100 they select the same offers on every body seen.
- **Shadeform**: one unfiltered call shared by all chips instead of `?gpu_type=H100`; H100
  now also takes `gpu_type` `H100_nvl` (version 1 compared `gpu_type` to `H100` ignoring
  case, which missed it). On 2026-11-11 this added massedcompute's three NVL rows at 3.16,
  moving its H100 value from 2.73 to 2.935.
- **Vast** asks for verified offers with `reliability2 >= 0.95` (and the chip's memory) in the
  query, `limit` 64, and notes the count and the cap.
- **Placeholder rule** (rule 1) and the `dropped` field are new.
- **Fallback to the reseller** when a direct source fails is new; version 1 always dropped
  the reseller's rows.
- User-Agent `weir-index/0.2 (GPU …)` instead of `weir-index/0.1 (H100 …)`.

The value range, the median rules, the Vast host rule, the 6-provider and 3-rate-card minimums
and the bundle hash are unchanged. **A version-1 bundle stays valid under version 1**: the
verifier keeps the version-1 calls and filters (`SOURCES_V1`, `H100_V1`) and checks such a
bundle, and re-parses its raw bodies, exactly as version 1 did. The first print,
`evidence/bundles/1794423600-1c0e2cb8b9c8.json` (H100-OD 2.76 USD), stays where it was, at the
top of `evidence/bundles/`, with its `.raw/` directory, and passes 113 of 113 checks.

## First version-2 prints (bucket 1794430800, 2026-11-11 21:54 UTC)

| index | value | included (rate-card + open-market) | excluded | file |
|---|---|---|---|---|
| H100-OD | **2.90** | 17 (15 + 2) | vast: too few hosts (2); shadeform:verda: duplicate | `h100/1794430800-778ad1c29b90.json` |
| H200-OD | **4.25** | 9 (7 + 2) | akash: no qualifying offer; shadeform:verda: duplicate | `h200/1794430800-9eb06ccea683.json` |
| A100-80-OD | **1.55125** | 12 (10 + 2) | lium: no qualifying offer; shadeform:verda: duplicate | `a100-80/1794430800-501e30c4ce8e.json` |

One run, 8 HTTP requests, 8 distinct raw bodies (1.2 MB). H100-OD rose from 2.76 to 2.90
in two hours mostly because Vast lost the verified hosts that kept it in (2.60 on the first
print), so the median moved one place up, and the massedcompute NVL rows were added.

## Not built

- **B200**: it meets the rule (8 providers, 6 rate-card on the re-check), but its provider
  values run from 3.74 to 10.00, a factor of 2.7, and the two lowest are single 8-GPU listings
  from small Shadeform resellers. The index (the mean of the 4th and 5th of 8) moves with any
  one of them. Not a market to settle on yet; revisit as coverage grows.
- **AMD (MI300X, MI325X, MI355X, any other)**: not built, needs new sources. Of the six
  sources only RunPod lists one (MI300X), and one provider cannot make an index. See CHIPS.md.
- The other chips in CHIPS.md (L40S, RTX PRO 6000, RTX 4090/5090, RTX 6000 Ada, A6000, B300,
  GB200): not built.

## Limits

- These are **asking prices and rate cards, not trades**. Nothing here shows that anyone
  paid these prices, how much capacity was available at them, or what discounts were given.
- The **open-market sources are thin and anyone can list there**. Vast had one or two
  verified H100 hosts on 2026-11-11 and was in and out of the H100 index within two hours;
  Akash has one H100 and one A100 80 GB entry and no H200; Lium lists no A100. Each index had
  only 2 open-market providers on the first version-2 print. A seller could list on Vast,
  Akash or Lium to nudge an index. Medians and one vote per provider limit the effect, they
  do not remove it.
- **Shadeform is a single upstream for many providers** (13 of 17 included for H100, 5 of 9
  for H200, 8 of 12 for A100 80 GB). Without it no chip has 6 providers, so one Shadeform
  outage or API change takes every index to null at once. Its prices may also differ from
  each cloud's own published rates (Verda: 3.31 there against 5.087 direct for H100).
- **Several Shadeform "rate cards" are small resellers** listing one 8-GPU box (excesssupply,
  boostrun, horizon, imwt). They count as rate cards under the method but behave more like
  open-market sellers; H200 depends on them more than H100 does.
- **Placeholders and junk inside the range**: see the limits of rule 1 above.
- **Vast's 64-offer cap**: when it is hit the Vast value is a sample (see the source rules).
- **Rate cards move in steps** and can stay stale for weeks; a GPU listed at a rate card
  may be unavailable at that price.
- **A provider can change its API** at any time: a renamed field excludes the provider
  (shape error); a renamed model **silently drops** it from a chip, because names are matched
  exactly. Bundles carry the raw hash so such changes can be found after the fact.
- The index is computed by each reporter separately. Two reporters fetching a few seconds
  apart can see different offers on the open-market sources; the on-chain median of
  reports absorbs this, but bundles from different reporters will not be identical.

## Version 1 (`weir-h100-od/1`), as recorded on 2026-11-11

H100 only. As version 2 for H100, except: RunPod `displayName` and Lium `machine_name`
**contained** `H100`; Shadeform was called as `GET https://api.shadeform.ai/v1/instances/types?gpu_type=H100`
and a row qualified when `configuration.gpu_type` upper-cased was `H100`; the Vast body was
`{"gpu_name":{"in":["H100 SXM","H100 PCIE","H100 NVL"]},"rentable":{"eq":true},"type":"on-demand","limit":1000}`
with no note; no placeholder rule and no `dropped`; reseller rows of a direct source were
always excluded as duplicates, even when the direct fetch failed; the bundle had no `chip` or
`index_name`; the CLI wrote `evidence/bundles/<bucket>-<hash12>.json` with raw bodies in
`<same name>.raw/<source>.json`.

