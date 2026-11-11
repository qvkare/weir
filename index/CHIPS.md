# Which chips can carry an index today

> **This is the study that led to method version 2 (`weir-gpu-od/2`, see METHOD.md),** which
> prices H100, H200 and A100 80 GB. It is kept as written on 2026-11-11 at 21:20 UTC, except
> where marked; the section "Re-check before version 2" below lists what a second look, 25
> minutes later, confirmed or contradicted.

A research note, not a method. It applies the rule of `weir-h100-od/1` (METHOD.md) unchanged to
other chips: one provider, one vote; a provider's value is the median of its qualifying on-demand
offers; the Vast 3-host rule; the 0.20 to 50.00 USD range; Shadeform clouds that are a direct source
dropped as duplicates; and the index is the median of the included values, given at least 6
providers of which at least 3 are rate-card (Vast, Akash and Lium are open-market).

The numbers below were computed by feeding the saved responses through `index/src/method.ts` itself
(`makeBundle`, so the rounding, medians and duplicate rule are exactly the method's), with per-chip
filters in place of the H100 ones. No change was made to `index/src/`.

## When

All calls on **2026-11-11, 21:20:08 to 21:21:24 UTC**, keyless, one request per source except:

- Shadeform: one unfiltered call to `/v1/instances/types` (it returns every GPU type, 265 kB), then
  six filtered calls to confirm the `gpu_type` spellings.
- Vast: eight `POST /api/v0/bundles/` calls (rate limit is 30). Vast **returns at most 64 offers per
  call** whatever `limit` says: an unfiltered call gave 64, a 24-name call gave 64, and the RTX 5090
  and RTX 4090 calls gave exactly 64 even with `verified` and `reliability2 >= 0.95` added to the
  query. The 5090 and 4090 Vast values are therefore medians of a 64-offer sample (45 and 43 hosts),
  not of the whole market. Every other chip came back under 64.
- One extra keyless call to Vultr's public plans API for the AMD question (not a method source).

The H100 run reproduces the first print: **2.76 USD, 18 providers (15 rate-card)**, which is a check
that the per-chip harness behaves like the CLI.

## Summary

"Slack" = how many included providers can drop out before the index is lost, i.e.
min(providers − 5, rate-card − 2). Values are USD per GPU-hour, not rounded.

| chip | providers (rate-card) | rule met | index | slack | Shadeform clouds among included | spread of values |
|---|---|---|---|---|---|---|
| H100 (baseline) | 18 (15) | yes | 2.76 | 13 | 13 | 1.89 to 5.99 |
| A100 80 GB | 12 (10) | yes | 1.55125 | 7 | 8 | 1.35 to 3.23 |
| RTX PRO 6000 Blackwell, any edition | 11 (8) | yes | 1.74 | 6 | 7 | 0.99 to 2.75 |
| RTX PRO 6000 Blackwell, Server Edition only | 10 (8) | yes | 1.97 | 5 | 7 | 0.99 to 2.75 |
| H200 | 9 (7) | yes | 4.34375 | 4 | 5 | 3.00 to 6.50 |
| L40S | 9 (8) | yes | 0.94 | 4 | 6 | 0.38 to 2.00 |
| B200 | 8 (6) | yes | 7.3525 | 3 | 4 | 3.74 to 10.00 |
| RTX A6000 | 8 (7) | yes | 0.535 | 3 | 5 | 0.42 to 1.93 |
| RTX 4090 | 7 (4) | yes | 0.49 | 2 | 3 | 0.36 to 0.615 |
| B300 | 7 (5) | yes, but see Akash | 9.0075 | 2 | 3 | 0.23 to 12.29 |
| RTX 6000 Ada | 6 (5) | yes | 0.94 | 1 | 3 | 0.60 to 1.56 |
| RTX 5090 | 6 (3) | yes, exactly | 0.70 | 1 | 2 | 0.58 to 0.94 |
| GB200 | 0 | no | none | – | 0 | Vast only, 1 host |
| AMD MI300X | 1 (1) | no | none | – | 0 | RunPod only |
| AMD MI325X, MI355X, any other AMD | 0 | no | none | – | 0 | listed nowhere |

**Every chip, H100 included, depends on Shadeform.** Without it the only rate-cards left are RunPod
and Verda (2, below the 3 needed), and at most 5 providers remain. One Shadeform outage removes every
index at once.

## Exact filter strings

| chip | vast `gpu_name` (in the body's `in` list) | runpod `displayName` | akash `model` | lium `machine_name` | verda `model` | shadeform `gpu_type` |
|---|---|---|---|---|---|---|
| H100 | `H100 SXM`, `H100 PCIE`, `H100 NVL` | `H100 SXM`, `H100 NVL`, `H100 PCIe` | `h100` | `NVIDIA H100 80GB HBM3`, `NVIDIA H100 PCIe` | `H100` | `H100` (also exists: `H100_nvl`, which version 1 did not match; version 2 does) |
| H200 | `H200`, `H200 NVL` | `H200 SXM`, `H200 NVL` | none | `NVIDIA H200`, `NVIDIA H200 NVL` | `H200` | `H200` |
| B200 | `B200` | `B200` | none | `NVIDIA B200` | `B200` (not `B200 CC`) | `B200` |
| GB200 | `GB200` | none | none | none | none (Verda lists `GB300`) | none (`GH200` is a different chip) |
| B300 | `B300` | `B300` | `b300` | `NVIDIA B300 SXM6 PC` | `B300` (not `B300 CC`) | `B300` |
| A100 80 GB | `A100 SXM4`, `A100 PCIE` **and `gpu_ram >= 70000`** (the names cover 40 and 80 GB) | `A100 PCIe`, `A100 SXM` (not `A100 SXM 40GB`) | `a100` with `ram == "80Gi"` | none listed | `A100 80GB` | `A100_80G` |
| L40S | `L40S` | `L40S` | none | `NVIDIA L40S` | `L40S` | `L40S` |
| RTX 5090 | `RTX 5090` (not `RTX 5090D`) | `RTX 5090` | `rtx5090` | `NVIDIA GeForce RTX 5090` | none | `RTX5090` |
| RTX 4090 | `RTX 4090` | `RTX 4090` | `rtx4090` | `NVIDIA GeForce RTX 4090` | none | `RTX4090` |
| RTX PRO 6000 | `RTX PRO 6000 S`, `RTX PRO 6000 WS` (also `RTX PRO 6000 Max-Q`) | `RTX PRO 6000`, `RTX PRO 6000 WK`, `RTX PRO 6000 MaxQ` (not the `PRO 6000 MIG` slices) | `pro6000se`, `pro6000we` | `NVIDIA RTX PRO 6000 Blackwell Server Edition`, `... Workstation Edition`, `... Max-Q Workstation Edition` | `RTX PRO 6000` | `RTXPro6000` |
| RTX A6000 | `RTX A6000` (none seen) | `RTX A6000` | none | `NVIDIA RTX A6000` | `RTX A6000` | `A6000` |
| RTX 6000 Ada | `RTX 6000Ada` | `RTX 6000 Ada` | none | `NVIDIA RTX 6000 Ada Generation` | `RTX 6000 Ada` | `RTX6000Ada` |
| MI300X | `MI300X` tried, 0 offers | `MI300X` (id `AMD Instinct MI300X OAM`) | none (all models are `vendor: nvidia`) | none | none | `MI300X` tried, empty list |

Shadeform has no endpoint that lists `gpu_type` values; the unfiltered `GET /v1/instances/types`
returns all of them. Values seen: `H100`, `H100_nvl`, `H200`, `GH200`, `B200`, `B300`, `A100`,
`A100_80G`, `A6000`, `A5000`, `A4000`, `A40`, `A30`, `A16`, `A10`, `L40S`, `L40`, `L4`, `RTXPro6000`,
`RTX6000Ada`, `RTX6000`, `RTX4000Ada`, `RTX5090`, `RTX4090`, `V100`, `V100_32G`, `GAUDI2`, `CPU`.
No AMD type. Using the unfiltered call (one request for all chips) would also be gentler than one
call per chip.

## Per chip

Kind: RC = rate-card, OM = open-market. "via SF" = a Shadeform cloud.

### H100 (baseline): 18 included, 15 rate-card, index 2.76, slack 13

akash OM 2.56 · denvr RC 2.50 · digitalocean RC 4.41 · excesssupply RC 3.00 · horizon RC 1.95 ·
hyperstack RC 2.50 · imwt RC 2.48 · lambdalabs RC 4.19 · latitude RC 1.89125 · lium OM 2.90 ·
massedcompute RC 2.73 · nebius RC 3.923125 · paperspace RC 5.99 · runpod RC 2.79 · scaleway RC 3.30 ·
vast OM 2.535 (3 hosts, at the 3-host limit) · verda RC 5.087 · voltagepark RC 1.99.
Excluded: shadeform:verda (duplicate).

### A100 80 GB: 12 included, 10 rate-card, index 1.55125, slack 7

| provider | kind | value | offers |
|---|---|---|---|
| akash | OM | 1.49 | 1 (32/200 GPUs available, 3/4 providers) |
| crusoe | RC via SF | 2.00 | 5 |
| denvr | RC via SF | 1.5125 | 2 |
| excesssupply | RC via SF | 1.35 | 3 |
| hyperstack | RC via SF | 1.35 | 5 |
| lambdalabs | RC via SF | 2.79 | 1 (8x only) |
| massedcompute | RC via SF | 1.365 | 8 |
| paperspace | RC via SF | 3.23 | 4 |
| runpod | RC | 1.59 | 4 |
| vast | OM | 1.359111 | 3 offers, 3 hosts (at the limit) |
| verda | RC | 2.339 | 4 |
| vultr | RC via SF | 2.60 | 1 |

Lium lists no A100. Vast's A100 offers were 34, of which 14 were 80 GB and only 3 verified with
reliability >= 0.95, one per host: Vast is one host away from exclusion.

### H200: 9 included, 7 rate-card, index 4.34375, slack 4

| provider | kind | value | offers |
|---|---|---|---|
| boostrun | RC via SF | 4.25 | 1 (8x) |
| digitalocean | RC via SF | 4.47 | 2 |
| excesssupply | RC via SF | 4.51625 | 7 |
| horizon | RC via SF | 3.00 | 1 (8x) |
| lium | OM | 4.14 | 12 |
| nebius | RC via SF | 4.573125 | 2 |
| runpod | RC | 3.69 | 4, **one of them `H200 NVL` community at 0.50** |
| vast | OM | 4.34375 | 7 offers, 5 hosts |
| verda | RC | 6.5045 | 4 |

RunPod's 0.50 looks like a placeholder, not a price (0.50 also appears for MI300X community, RTX PRO
6000 Max-Q secure, RTX 2000 Ada community and RTX A2000 secure, sometimes above the secure price).
Dropping it makes RunPod 4.44 and the index **4.44** instead of 4.34375. Either way the rule is met.

### L40S: 9 included, 8 rate-card, index 0.94, slack 4

boostrun RC 0.69 (8x only) · crusoe RC 1.50 · digitalocean RC 1.57 · latitude RC 0.805625 ·
lium OM 0.38 (**one executor**) · massedcompute RC 0.88 · runpod RC 0.94 · scaleway RC 1.70 ·
verda RC 1.998. Excluded: vast (1 host, 1 offer), shadeform:verda (duplicate). Six of the eight
rate-cards come through Shadeform; the open-market side is effectively absent.

### RTX PRO 6000 Blackwell: 11 included (8 RC), index 1.74, slack 6; Server Edition only: 10 (8), 1.97, slack 5

Any edition: akash OM 1.795 (SE 2.13 and WE 1.46) · boostrun RC 0.99 · excesssupply RC 1.35 ·
hyperstack RC 1.85 · imwt RC 1.25 · latitude RC 2.655 · lium OM 1.725 · massedcompute RC 2.19 ·
runpod RC 1.69 (includes a 0.50 Max-Q secure placeholder) · vast OM 1.74 (3 hosts) · verda RC 2.75225.
Server Edition only: Vast drops to 2 hosts and is excluded; Akash 2.13, Lium 1.70, RunPod 2.09; index
1.97. The 0.23 USD gap between the two definitions shows the chip has to be defined before launch
(the Max-Q and Workstation cards are different products at different prices).

### B200: 8 included, 6 rate-card, index 7.3525, slack 3

| provider | kind | value | offers |
|---|---|---|---|
| boostrun | RC via SF | 3.74 | 1 (8x) |
| excesssupply | RC via SF | 4.51375 | 1 (8x) |
| lambdalabs | RC via SF | 6.84 | 4 |
| lium | OM | 7.72 | 8 |
| nebius | RC via SF | 9.50 | 1 (8x) |
| runpod | RC | 6.985 | 2 |
| vast | OM | 10.001562 | 6 offers, 4 hosts |
| verda | RC | 9.2295 | 4 |

Values run from 3.74 to 10.00, a factor of 2.7. The two lowest are single 8x listings from small
Shadeform resellers. The index is the mean of the two middle values (6.985 and 7.72), so it moves
with any one of six providers.

### RTX A6000: 8 included, 7 rate-card, index 0.535, slack 3

hyperstack RC 0.50 · imwt RC 0.49 · lambdalabs RC 1.09 · lium OM 0.42 · massedcompute RC 0.57 ·
paperspace RC 1.93 · runpod RC 0.46 · verda RC 0.861. Vast showed none (not queried by name; the
unfiltered sample had none). An old chip; a market on it is unlikely to interest anyone.

### RTX 4090: 7 included, 4 rate-card, index 0.49, slack 2

akash OM 0.36 (**0 of 2 GPUs available**) · boostrun RC 0.49 (8x) · excesssupply RC 0.60 ·
lium OM 0.465 · phyntec RC 0.40 (8x) · runpod RC 0.615 · vast OM 0.494815 (64-offer cap, 43 hosts).
Three of four rate-cards come through Shadeform from small resellers. Losing two rate-cards loses it.

### B300: 7 included, 5 rate-card, index 9.0075, slack 2

akash OM **0.23** (0 of 16 GPUs available, 0 of 2 providers; a 1/40th-of-market price that passes the
0.20 floor) · excesssupply RC 8.50 · lium OM 12.285 · nebius RC 11.00 · runpod RC 7.965 ·
scaleway RC 9.0075 · verda RC 12.05. Excluded: vast (1 host). Without the Akash figure only 6 remain,
slack 1. Not launchable.

### RTX 6000 Ada: 6 included, 5 rate-card, index 0.94, slack 1

boostrun RC 0.60 · digitalocean RC 1.57 · lium OM 0.91 · massedcompute RC 0.97 · runpod RC 0.865 ·
verda RC 1.558. Excluded: vast (1 host).

### RTX 5090: 6 included, 3 rate-card, index 0.70, slack 1

| provider | kind | value | offers |
|---|---|---|---|
| akash | OM | 0.58 | 1 (1 of 2 GPUs available, 1 provider) |
| excesssupply | RC via SF | 0.65 | 5 |
| lium | OM | 0.70 | 46 |
| phyntec | RC via SF | 0.70 | 1 (8x) |
| runpod | RC | 0.94 | 2 |
| vast | OM | 0.73363 | 64 (cap), 45 hosts |

Exactly at the threshold on both counts. Deep open-market supply (Vast and Lium have more 5090 offers
than any other chip), but the rate-card leg is three providers, two of them small Shadeform resellers.
Any single rate-card dropping out, or Akash's one provider going quiet, kills it.

### GB200: no index

Only Vast lists it (3 offers, 1 host, excluded). No source lists GB200 NVL72 capacity by the GPU-hour.

### AMD: no index

- **MI300X**: RunPod only (secure 2.39, community 0.50 placeholder; value 1.445). One provider.
- **MI325X, MI355X, MI250, anything AMD**: none of the six sources lists them. Akash's catalogue is
  all `vendor: nvidia`; Vast returned 0 offers for `MI300X`/`MI325X`; Shadeform returned an empty list
  for `gpu_type=MI300X` and has no AMD type at all; Lium and Verda list none.

Where AMD GPU time is rented today (quick search, not exhaustive): Vultr, DigitalOcean, TensorWave,
Crusoe, Hot Aisle, Oracle OCI and Azure (8-GPU nodes), RunPod, and smaller resellers. Third-party
trackers put MI300X on-demand at roughly 1.7 to 2.9 USD per GPU-hour and 6.00 at the hyperscalers.
Machine-readable without a key: **Vultr** does publish it, in `GET https://api.vultr.com/v2/plans-metal`
(checked: `vbm-256c-2048gb-8-mi300x-gpu` 31.92 USD/h = **3.99** per GPU-hour, `...-8-mi325x-gpu`
36.92 = **4.615**, `...-8-mi355x-gpu` 20.72 = **2.59**, all 8-GPU bare metal). RunPod's GraphQL is
keyless. DigitalOcean's sizes API needs a token; TensorWave, Crusoe, Hot Aisle, Oracle and Azure were
not checked for keyless machine-readable prices (Azure has a public retail-prices API, Oracle a
public price list; neither checked here). So an AMD index would need **new sources**, and even then
reaching 3 rate-cards plus 6 providers looks unlikely without hyperscaler list prices, which are the
stalest numbers there are.

## What the code change would be (made in version 2, differently in places)

Done in `weir-gpu-od/2`. Where it differs from the sketch below: there is **one** method id
for every chip (`weir-gpu-od/2`, with `chip` and `index_name` in the bundle) rather than
`weir-<chip>-od/1`; Shadeform is one unfiltered call shared by all chips; the value range
stays 0.20 to 50.00 for every chip; and the placeholder question is settled by a rule (an
offer below 25 % of the bundle's median offer is dropped and recorded).

The method itself (`median`, `assess`, `computeIndex`, `providersFrom`, `makeBundle`, the bundle
format and the verifier's logic) is chip-agnostic. The H100 assumptions are in the filters:

| file | today | change | rough lines |
|---|---|---|---|
| new `src/chips.ts` | – | a table per chip: method id (`weir-<chip>-od/1`), and per source the exact filter strings above (Vast names plus optional `gpu_ram` bound, RunPod display names, Akash model plus optional ram, Lium names, Verda models, Shadeform `gpu_type`s) | 60–90 |
| `src/sources/vast.ts` | `GPU_NAMES` constant in the body and the filter | `make(chip)`; add the `gpu_ram` check for A100 80 GB; consider adding `verified`/`reliability2` to the query because of the 64-row cap | ~10 |
| `src/sources/runpod.ts` | `displayName.includes("H100")` | exact `displayName` list (substring matching would take `A100 SXM 40GB`, whose secure price is **0**); decide what to do with 0 and 0.50 placeholders | ~8 |
| `src/sources/akash.ts` | `m.model !== "h100"`, sku literal `"h100"` | model (and ram) from the chip | ~5 |
| `src/sources/lium.ts` | `machine_name.includes("H100")` | exact name list from the chip | ~4 |
| `src/sources/verda.ts` | `t.model !== "H100"` | model list from the chip (keep `B200 CC`/`B300 CC` out) | ~3 |
| `src/sources/shadeform.ts` | URL `?gpu_type=H100`, `toUpperCase() !== "H100"` | URL and type list from the chip (or one unfiltered fetch shared by all chips) | ~6 |
| `src/sources/mod.ts` | `SOURCES` constant, `sourceById(id)` | `sourcesFor(chip)`, `sourceById(id, chip)` | ~10 |
| `src/method.ts` | `METHOD_ID = "weir-h100-od/1"`, used by `makeBundle` | `makeBundle(chip, ...)`; possibly a per-chip value range (the 0.20 floor sits close to 4090/5090 prices and let Akash's 0.23 B300 through) | ~6 |
| `src/bundle.ts` | checks `bundle.method === METHOD_ID`, looks sources up by id | derive the chip from `bundle.method` and verify against that chip's sources | ~10 |
| `src/cli.ts` | fetches `SOURCES` | `--chip` flag, chip in the output path | ~10 |
| `src/fetch.ts` | User-Agent says H100 | generic text | 1 |

About **120 to 160 lines** in `src/`, most of it the new table; every parser is touched but none needs
a new shape. Tests and fixtures (`test/parsers.test.ts` names H100 throughout, `test/fixtures/*` are
H100 responses, though most of them are full catalogues) need a per-chip pass, perhaps as many lines
again. METHOD.md becomes one method per chip, or one method with a chip table. Outside `index/`, the
`method` id is posted on chain with each report, so the contracts and web side need to know which
market a method id belongs to (not examined).

## Re-check before version 2 (2026-11-11, 21:46 UTC)

One call per source (Shadeform unfiltered) plus one Vast call per chip with the version-2
query (verified and `reliability2 >= 0.95` in the query), then the live CLI run at 21:54 UTC.

Confirmed:

- Every filter string above for H100, H200, A100 80 GB and B200 still matches the same names.
  Verda's body was byte-identical to the 19:25 one.
- **B200** still spans **3.74 to 10.00** (boostrun 3.74, excesssupply 4.51375, lambdalabs 6.84,
  runpod 6.985, lium 8.88, verda 9.2295, nebius 9.50, vast 10.00; 8 included, 6 rate-card,
  index 7.9325). Left out of version 2 for the reason given in the recommendation.
- RunPod still lists `H200 NVL` community at 0.50; version 2's placeholder rule drops it.
- No AMD type appeared anywhere new.

Contradicted or changed:

- **Vast's 64-offer cap was not reached** by any chip once the query asks only for qualifying
  offers: H100 1 to 3 offers, H200 12 to 14, A100 80 GB 2 to 3, B200 9. The cap matters for
  the RTX cards (not built), not for these three.
- **Vast H100 had one verified host** at 21:46 and two at 21:54 (three at 19:25), so it is
  excluded from H100-OD by the 3-host rule. The "baseline" row above counted it.
- **H100 numbers**: with `H100_nvl` matched, massedcompute is 2.935 (was 2.73), and with Vast
  out H100-OD is **2.90 from 17 providers (15 rate-card)**, not 2.76 from 18.
- **H200**: Lium has 13 H200 executors (one `H200 NVL` at 3.85); Vast returned 12 to 14
  qualifying offers (8 hosts at 21:46). With only the 0.50 offer dropped, RunPod is 3.79, not
  4.44 (4.44 is the mean of 3.59 and 5.29, i.e. what dropping the whole H200 NVL type gives,
  secure 3.79 included), and **H200-OD is 4.25**, 9 providers (7 rate-card).
- **A100 80 GB**: Vast had 2 qualifying hosts at 21:46 (excluded) and 3 at 21:54 (included,
  1.308889); **A100-80-OD was 1.55125**, 12 providers (10 rate-card), as above.
- Lium now lists one `NVIDIA H100 PCIe` executor (1.90), matched by the H100 rule.

## Recommendation

Launchable beside H100 with an honest index today, in this order:

1. **A100 80 GB**: 12 providers, 10 rate-card, slack 7, index 1.55125. The most robust after H100.
   Caveats: 8 of the 12 come through Shadeform; Vast is at its 3-host limit; it is an older chip whose
   rate cards change rarely.
2. **H200**: 9 providers, 7 rate-card, slack 4, index 4.34375 (4.44 if RunPod's 0.50 placeholder is
   excluded, which the method should decide before launch). The chip people actually trade next to
   H100.
3. **RTX PRO 6000 Blackwell (Server Edition)** or **L40S**, as a third: both have 8 rate-cards and
   slack 4 to 6. RTX PRO 6000 needs a product definition first (editions differ by 0.23 USD in the
   index). L40S has almost no open-market leg (one Lium executor) and 6 of 8 rate-cards via Shadeform.

Not today:

- **B200** meets the rule (8, 6 RC, slack 3) but its values span 3.74 to 10.00 and two of the six
  rate-cards are single 8x listings from small resellers; the index is too sensitive to one listing.
  Revisit as coverage grows.
- **RTX 5090** (6/3, slack 1) and **RTX 6000 Ada** (6/5, slack 1): one dropout from no index.
- **RTX 4090** (7/4, slack 2) and **B300** (7/5, slack 2, and one of the seven is Akash's 0.23 with
  nothing available): too thin.
- **GB200**: one Vast host. **AMD (all)**: one provider for MI300X, none for anything else.

Risks common to all of them, larger than for H100:

- **Single upstream**: Shadeform supplies 33 % (RTX 5090) to 72 % (H100) of each chip's included providers and every chip's third
  and later rate-card. A Shadeform outage or API change takes every market's index to null at once.
- **Who the "rate-card" providers are**: several Shadeform clouds (excesssupply, boostrun, phyntec,
  imwt, horizon) are small resellers listing a single 8x box; excesssupply's instance names look like
  marketplace listings. They count as rate-cards under the method but are closer to open-market sellers.
- **Placeholders and junk inside the range**: RunPod 0 and 0.50 entries, Akash prices for models with
  zero availability (B300 0.23, RTX 4090 0.36). The 0.20 floor does not catch them.
- **Verda's own API vs Shadeform's Verda rows disagree**: H100 5.087 vs 3.31, H200 6.50 vs 4.41,
  A100 2.339 vs 1.85, L40S 1.998 vs 1.43. The method uses the direct figure; it is one of the highest
  values for every chip and worth understanding before more markets depend on it.
- **List prices that never move**: most rate-cards are identical across 1x to 8x shapes and flat
  week to week; a week-ahead market on A100 or L40S may see very little index movement, and real
  price changes will show up first in the open-market legs, which are the thinnest.
- **Vast's 64-offer cap** means the 5090 and 4090 Vast values are samples, and for every other chip
  Vast sits at or near the 3-host minimum.
