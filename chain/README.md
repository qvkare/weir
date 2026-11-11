# @weir/chain

How Weir code talks to NEAR: a minimal JSON-RPC client that signs its own transactions,
`WeirPort` (one typed method per contract method) with an on-chain and an in-memory
implementation, the USDC token calls, and a quote-only client for NEAR Intents.

Everything in `src/` except `cli.ts` uses only `fetch`, `AbortController`, `TextEncoder`,
`btoa`/`atob` and Web Crypto, so it runs unchanged in Node 22.18+, browsers and Cloudflare
Workers. A test checks that no file but the CLI imports a Node built-in.

## Files

| File | What it is |
|---|---|
| `src/tx.ts` | Base58, base64, `KeyPair` from a NEAR secret key `ed25519:<base58>` (64-byte or 32-byte form), the borsh encoding of a transaction of function-call actions, and `signTransaction` (ed25519 over `sha256(borsh(tx))`). `AnyTransaction` may also carry the account-setup actions (create account, deploy contract, transfer, add a full-access or function-call key), which the integration test uses to set up the sandbox; nothing in `src/` sends them. |
| `src/near.ts` | `NearRpc`: `query` views (`call_function`, args base64, result decoded from bytes), `view_account`, `view_access_key`, latest block hash, `send_tx` waited on until `FINAL` (polling `tx` if the node times out). Fails over between URLs on network errors, per-call timeouts, HTTP 429/5xx and node `INTERNAL_ERROR`/`TIMEOUT_ERROR`; any other JSON-RPC error is an answer and is thrown at once. `decodeOutcome` gives `{ ok, result, logs, error, tx_hash, gas_burnt }`. `NearAccount` signs and sends one call at a time per instance, so nonces never collide, and rereads the nonce once on `InvalidNonce`. |
| `src/weir.ts` | `WeirPort`, typed by `@weir/engine`'s wire types (`ViewMethods`, `ChangeMethods`), never redefined here. `ChainWeir` (over `near.ts`) and `ModelWeir` (over an engine `Market` through `callView`/`callChange`, settable clock, plus a synchronous `sync` face). A failed chain call throws `CallFailed`, whose message is the contract's bare panic text, the same text `ModelWeir` throws. `paramsFromWire` turns `get_params` JSON into engine `Params`. `AGENT_KEY_METHODS` is what an agent's function-call key may call (SPEC section 15): `commit, reveal, clear, mint, merge, settle, redeem`. |
| `src/token.ts` | `Token`: `storage_deposit`, `ft_balance_of`, `storage_balance_of`, `ft_transfer_call` into Weir (the optional beneficiary goes in `msg`, SPEC section 5) and the test token's open `mint(account_id, amount)`. |
| `src/intents.ts` | NEAR Intents 1Click client, quotes only: `POST /v0/quote` with `dry: true` (it refuses anything else) and `GET /v0/tokens`. USDC asset ids for Base, Arbitrum, Ethereum, Solana and NEAR. |
| `src/cli.ts` | Node only. `quote --from arbitrum\|ethereum\|solana\|base --amount 20 --to <near account>`. |
| `src/mod.ts` | Re-exports. |

### WeirPort

Methods carry the contract's own names and JSON shapes, `port.commit({ series, hash, lock })`,
`port.get_round({ series, round })`, and the generic `port.view(name, args)` and
`port.change(name, args)`. One method differs from the contract: `deposit({ amount, msg? })`
is what a user does to deposit, an `ft_transfer_call` of `amount` USDC to Weir. On chain it
goes to the token; on the model it calls the engine's `ft_on_transfer` as the token would.
It returns the amount Weir kept, as `ft_transfer_call` does (`"0"` when the account to credit
is not registered).

`ModelWeir` passes every argument and result through JSON, so it hands back exactly what a
chain client parses. One test runs the same 45-step scenario (reports, registration,
deposits including one to an unregistered account, commits, reveals, clearing, mint,
merge, transfer, guard, withdrawals, void settlement, redemption, prune, seven expected
panics) through `ModelWeir` and through `ChainWeir` over a fake RPC that executes the
signed transactions on a second `Market`, and requires identical transcripts.

### Gas and deposits

| Method | Gas | Attached |
|---|---|---|
| `register` | 30 Tgas | 0.02 NEAR (`REGISTRATION_FEE`; the contract refunds any excess) |
| `deposit` (`ft_transfer_call` on the token) | 100 Tgas | 1 yoctoNEAR |
| `withdraw` | 100 Tgas | 1 yoctoNEAR |
| `set_guard` | 30 Tgas | 1 yoctoNEAR |
| `transfer_position` | 50 Tgas | 1 yoctoNEAR |
| `commit`, `reveal`, `mint`, `merge`, `report`, `redeem`, `prune_result` | 50 Tgas | none |
| `settle` | 100 Tgas | none |
| `clear` | 300 Tgas | none |
| token `storage_deposit` | 30 Tgas | 0.00125 NEAR, `registration_only: true` |
| token `mint` | 30 Tgas | none |

The gas figures are generous guesses, not measurements: unused gas is refunded, and `clear`
gets the 300 Tgas a full round must fit in (SPEC section 14). They should be replaced by the
contract's sandbox measurements.

## Dependencies

| Package | Version | Kind | Why |
|---|---|---|---|
| `@noble/ed25519` | 3.2.0 (exact) | runtime | ed25519 signing. Audited, zero dependencies, about 500 lines; its async API uses Web Crypto's SHA-512, so it works in Workers and browsers. Writing curve arithmetic ourselves would be the wrong kind of small. |
| `@weir/engine` | workspace | runtime | The wire types, `callView`/`callChange`, and the synchronous SHA-256 used for transaction hashes. |
| `@near-js/transactions`, `@near-js/crypto` | 2.5.1 (exact) | dev only | An independent implementation: the tests check our borsh encoding, hashes and signatures against it, and decode our signed transactions with it in the fake RPC. Never imported by `src/`. |
| `@types/node` | 22.18.0 | dev only | Types for the tests and the CLI. |
| `typescript` | ^5.9.3 (as `engine/`) | dev only | `tsc --noEmit`. |

`near-api-js` is not used at all.

## Tests

```sh
pnpm --filter @weir/chain test          # offline, node:test
pnpm --filter @weir/chain typecheck     # tsc --noEmit
WEIR_LIVE=1 pnpm --filter @weir/chain test   # adds one read-only call to NEAR testnet
```

- `tx.test.ts`: base58 and base64 edge cases; both secret-key forms; 300 random signed
  transactions (random signers, receivers, nonces, block hashes, 1 to 4 function calls with
  random method names, JSON or binary args, u64 gas and u128 deposits) encoded, hashed and
  signed byte-identically to `@near-js`; out-of-range values refused.
- `near.test.ts`: failover on network errors, 5xx, 429 and timeouts; handler errors not
  retried; view request shape and decoding; both panic shapes; outcome decoding; signing and
  `send_tx` at `FINAL`; nonces under concurrency and after `InvalidNonce`; polling `tx` after
  a `send_tx` timeout.
- `weir.test.ts`: every state change sends the spec's argument names (SPEC sections 5 to 14)
  with the gas and deposit above, every view sends the spec's argument names, the
  model/chain transcript test, `CallFailed`, `ModelWeir` copies and shared clock.
- `tx_actions.test.ts`: 200 random transactions mixing the setup actions with function calls
  (random keys, code, deposits, allowances, method lists) encoded and signed byte-identically
  to `@near-js`; out-of-range values refused.
- `token.test.ts`, `intents.test.ts` (against real 1Click responses saved in
  `test/fixtures/` on 2026-11-11), `portable.test.ts`, `live.test.ts`.

The live test calls `ft_metadata` on testnet USDC
(`3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af`) through
`https://test.rpc.fastnear.com`. On 2026-11-11 it returned
`{"spec":"ft-1.0.0","name":"USDC","symbol":"USDC","decimals":6}` (plus an icon).

## Dry quote

```sh
node chain/src/cli.ts quote --from arbitrum --amount 20 --to near
```

```
Dry 1Click quote: USDC on arbitrum -> USDC on NEAR for near (nothing was sent)
  amount in        20.000000 USDC
  amount out       19.996160 USDC
  minimum out      19.796198 USDC  (slippage tolerance 100 bps)
  time estimate    25 s
  refund address   0x2222222222222222222222222222222222222222  (placeholder for the dry quote, not a real wallet)
```

What the API did on 2026-11-11: Arbitrum, Ethereum (45 s) and Solana (20 s) quoted about
19.996 USDC out for 20 in. Base answered `Quoting for this pair is not available` for part
of the day and quoted normally later (19.997652 out, 35 s). When a pair is unavailable the
CLI says so plainly and suggests `--from arbitrum`. The recipient must be an existing NEAR
mainnet account or a 64-hex implicit account; an unknown named account gets
`Internal server error`, and the CLI says so. Intents runs on mainnet only; a dry quote
moves nothing.

## Not proven

`ChainWeir` has never touched a real Weir contract. Proven offline: the bytes of every
transaction (against `@near-js`), the method names, argument names and JSON shapes against
the spec, the gas and deposits we attach, and identical behaviour to the model when a fake
RPC executes our transactions on the engine. Not proven: that the Rust contract accepts
these JSON shapes (for example `Option` fields left out, u128 as strings, `side` as
`"Long"`), that its panic messages are exactly the spec's, that the gas figures suffice, the
`ft_transfer_call` round trip through a real token, function-call-key permissions, and the
RPC behaviour under real `send_tx` timeouts and nonce races. The only live call made is the
read-only `ft_metadata` above.

Since 2026-11-12, `integration/` runs `ChainWeir` and `Token` against the real wasm on a local
near-sandbox node, with the model alongside; what that proved, and what it cannot, is in
`integration/RESULTS.md`.
