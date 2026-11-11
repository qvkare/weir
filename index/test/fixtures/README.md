# Fixtures

Real responses, fetched with curl. The tests run offline against these files.

## First day: 2026-11-11 about 19:25 UTC (H100, method version 1's calls)

Fetched once with the exact calls of `weir-h100-od/1` (see the end of `../../METHOD.md`). The
keeper's tests also read these files, by source id, so they stay as they are.

| File | Source call | Stored as |
|---|---|---|
| `vast.json` | `POST console.vast.ai/api/v0/bundles/` (H100 names, no verified filter) | exact body, untouched (sha256 `547cb1ca…89a7`) |
| `runpod.json` | `POST api.runpod.io/graphql` | exact body, untouched (`a265dd40…682a`) |
| `akash.json` | `GET console-api.akash.network/v1/gpu-prices` | exact body, untouched (`19719959…9324`) |
| `lium.json` | `GET lium.io/api/executors` | **trimmed**, see below |
| `verda.json` | `GET api.verda.com/v1/instance-types` | exact body, untouched (`44784650…bb69`) |
| `shadeform.json` | `GET api.shadeform.ai/v1/instances/types?gpu_type=H100` | exact body, untouched (`50250b7f…4de2`) |

`lium.json` is trimmed. The full body was 684,072 bytes with 152 executors (sha256
`6d31a33c3aff06e0a1b477efda7de3a56adb6f1897319827a610a9048606f31b`). The fixture keeps,
unchanged and in their original order, the 9 executors whose `machine_name` contains `H100`
and the first 2 that do not (so the filter is exercised), and is re-serialised with Python's `json.dumps`
(default separators). Nothing inside an entry was edited.

## Second day, `v2/`: 2026-11-11 about 21:46 UTC (every chip, version 2's calls)

One call per source with the calls of `weir-gpu-od/2`, plus one Vast call per chip.

| File | Source call | Stored as |
|---|---|---|
| `v2/vast-h100.json` | Vast, H100 query of `src/sources/vast.ts` | exact body (`829d4be9…03e9`) |
| `v2/vast-h200.json` | Vast, H200 query | exact body (`78f75a11…376d`) |
| `v2/vast-a100-80.json` | Vast, A100 80 GB query (with `gpu_ram >= 70000`) | exact body (`38999446…64cb3`) |
| `v2/runpod.json` | RunPod GraphQL | exact body (`b22c6eb3…95df`) |
| `v2/akash.json` | Akash gpu-prices | exact body (`3542ae07…60c8`) |
| (none) | Verda instance-types | **byte-identical** to the first day's `verda.json` (`44784650…bb69`), so that file serves both |
| `v2/lium.json` | Lium executors | **trimmed** |
| `v2/shadeform.json` | Shadeform `instances/types`, unfiltered | **trimmed** |

- `v2/lium.json`: the full body was 716,103 bytes with 161 executors (sha256
  `5032f6ab4aa9af5e44259d9e670353ff1ce785ef24e8dd01b20b669bd284f2f6`). Kept, unchanged and in
  order: the 22 executors named `NVIDIA H100 80GB HBM3`, `NVIDIA H100 PCIe`, `NVIDIA H200` or
  `NVIDIA H200 NVL`, and the first 2 others (an RTX 4090 and an RTX 4070 Ti SUPER).
- `v2/shadeform.json`: the full body was 265,243 bytes with 304 instance types (sha256
  `5afba134970db50bef17f8597364cb31a0b47f315ebc396dd02fd41eb69a320e`). Kept, unchanged and in
  order: the 109 rows whose `gpu_type` is `H100`, `H100_nvl`, `H200`, `A100_80G` or `A100`
  (the 40 GB type, so the A100 filter is exercised), and the first 2 others.

Both trimmed files are re-serialised with Python's `json.dumps` (default separators); nothing
inside an entry was edited. The expected values in `../parsers.test.ts` and
`../method.test.ts` were worked out by hand from these files, and the H200 placeholder
reference (the median of all 50 H200 offers, 4.25) was checked with a separate Python script.
