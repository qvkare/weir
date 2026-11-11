# @weir/integration

The end-to-end test of Weir (specification 0.4) on a local NEAR sandbox node: the real `weir.wasm` and
`mock_usdc.wasm`, the TypeScript chain client (`ChainWeir`, `Token`), the trading agents and
the keeper, with the engine's `ModelWeir` run alongside and compared call by call. Nothing
here touches testnet or mainnet: no account, key or transaction leaves the machine.

Results of the last run, the gas table and every finding: [`RESULTS.md`](RESULTS.md).
The machine-readable record of a run goes to `out/run.json` (git-ignored).

## What it needs

| | |
|---|---|
| Node | 22.18 or later (runs the `.ts` files directly) |
| Rust, `cargo-near` | to build the wasm: `contracts/build.sh` (output in `contracts/target/near/`). A wasm older than its sources is refused, as the Rust sandbox tests do |
| near-sandbox 2.14.0 | the binary the Rust `near-sandbox` crate (0.4) downloads the first time the contract's sandbox tests run, into `contracts/target/<profile>/build/near-sandbox-*/out/.near/near-sandbox-2.14.0/near-sandbox`. Found there automatically, or in `~/.near/near-sandbox-2.14.0/`, or wherever `NEAR_SANDBOX_BIN_PATH` points (the crate's own override). macOS arm64 and Linux only, as the crate |
| Ports | 33031 (RPC) and 33032 (network) on 127.0.0.1 |

```sh
contracts/build.sh
cargo test --manifest-path contracts/Cargo.toml -p weir --test sandbox   # once, downloads the sandbox binary
pnpm --filter @weir/integration run e2e      # everything
node integration/src/e2e.ts                  # the same, without pnpm
WEIR_E2E_ONLY=lifecycle node integration/src/e2e.ts   # one scenario: lifecycle, full-book, swarm
WEIR_E2E_SECOND=0 node integration/src/e2e.ts         # the keeper with the h100-fast market only
WEIR_E2E_VERBOSE=1 node integration/src/e2e.ts        # prints every keeper tick
pnpm --dir integration test                  # offline tests of the harness itself
```

A full run takes about seven and a half minutes on an Apple-silicon laptop (lifecycle 100 s,
full book 37 s, the keeper 320 s). It exits non-zero if any check fails or the contract and the
model differ anywhere, refusal texts included. See `RESULTS.md` for the last run's outcome.

## How it works

- `src/sandbox.ts` starts `near-sandbox` with a fresh home directory in the system temp
  directory (`init --fast`), waits until RPC answers, and kills it and removes the directory
  at the end, on failure and on Ctrl-C. It changes three settings: `min_block_production_delay`
  to 0.06 s (half the default, so a transaction is final in about 0.3 s),
  `max_block_production_delay` so that one fast-forwarded block moves the clock about 2 s
  instead of 0.3 s (an hour of market time then costs about 1,800 blocks, a few seconds), and the genesis
  `epoch_length` to one million, because with the first change 2.14.0 stopped producing blocks
  at an epoch boundary after a few fast-forwards (seen twice). `warpTo` moves the clock with
  `sandbox_fast_forward`, overshooting by at most about one block, and fails the run if the
  node stops producing blocks.
- `src/accounts.ts` creates accounts (full-access or function-call keys) and deploys
  contracts from the root account `test.near`, with the create-account, transfer, add-key and
  deploy actions that `chain/src/tx.ts` now encodes. Every call to Weir and to the token goes
  through `ChainWeir` and `Token`.
- `src/twin.ts` is the parity harness. Each state change goes to the contract through
  `ChainWeir`; the harness reads the block in which the contract ran it, sets a `ModelWeir`'s
  clock to that block's time and makes the same call there, then compares the return value
  or panic message and the NEP-297 events the contract logged against the model's `eventLog`
  output. Concurrent calls are replayed on the model in the order the chain ran them.
  `checkpoint` compares every view of SPEC section 12 (about 90 to 130 per checkpoint).
- Scenarios: `src/lifecycle.ts` (whole life with exact balances; commit fees, the round lock
  limit, a guard changed after commit; every way a bucket is decided: all three reporters,
  `finalize_print`, a later report, disagreement, below quorum, `settle`; `prune_result` and
  `prune_print` with the contract's storage read before and after; every refusal; the
  function-call-key agent; minimal gas of the cross-contract calls), `src/fullbook.ts` (a round
  at `max_commits`, eviction returning lock and fee, the fullest clear, the cap on sets reached
  with real test money, nonces under concurrency, a void settlement), `src/swarm.ts` (the
  keeper's `runTick` with its own `nearChain` for a whole `h100-fast` series: three reporters,
  six agents, a housekeeping account, one bucket with a reporter missing; and, for the first
  hour and a half, an `h200-weekly` market alongside).
  `src/gas.ts` builds the gas table from every outcome.

## Workspace

`integration` is listed in the root `pnpm-workspace.yaml`. The sources import the other
packages by relative path (`../../chain/src/mod.ts`), so no install is needed.
