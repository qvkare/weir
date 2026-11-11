#!/usr/bin/env bash
# Builds both contracts to contracts/target/near/. See contracts/README.md.
#
# This has to be cargo-near: it sets `--cfg near`, which selects near-sdk's host
# functions. A plain wasm32 build compiles, but near-sdk says it is not for chain use.
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v cargo-near >/dev/null 2>&1; then
  echo "cargo-near is required: cargo install --locked cargo-near" >&2
  exit 1
fi

cargo near build non-reproducible-wasm --no-abi --locked --manifest-path weir/Cargo.toml
cargo near build non-reproducible-wasm --no-abi --locked --manifest-path mock-usdc/Cargo.toml

# cargo-near leaves the old file in place when the bytes come out the same, as they do
# after a test-only edit. The sandbox tests refuse a wasm older than its source, so
# record that these are current.
touch target/near/weir/weir.wasm target/near/mock_usdc/mock_usdc.wasm
