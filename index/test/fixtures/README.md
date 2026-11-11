# Fixtures

One real response per source, fetched once with curl on 2026-11-11 at about 19:25 UTC
with the exact calls in `../../METHOD.md`. The tests run offline against these files.

| File | Source call | Stored as |
|---|---|---|
| `vast.json` | `POST console.vast.ai/api/v0/bundles/` | exact body, untouched (sha256 `547cb1ca…89a7`) |
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

The expected values in `../parsers.test.ts` were worked out by hand from these files.
