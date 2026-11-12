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
| `src/near.ts` | `NearRpc`: `query` views (`call_function`, args base64, result decoded from bytes), `view_account`, `view_access_key`, latest block hash, `send_tx` waited on until `FINAL`. Failover, cooldowns and rate-limit waits are described under "RPC endpoints" below. `decodeOutcome` gives `{ ok, result, logs, error, tx_hash, gas_burnt }`. `NearAccount` signs and sends one call at a time per instance, so nonces never collide, and on `InvalidNonce` retries up to three times (`NONCE_RETRIES`) with a fresh nonce, starting above the `ak_nonce` the refusal names. |
| `src/weir.ts` | `WeirPort`, typed by `@weir/engine`'s wire types (`ViewMethods`, `ChangeMethods`), never redefined here. `ChainWeir` (over `near.ts`) and `ModelWeir` (over an engine `Market` through `callView`/`callChange`, settable clock, plus a synchronous `sync` face). A failed chain call throws `CallFailed`, whose message is the contract's bare panic text, the same text `ModelWeir` throws. `paramsFromWire` turns `get_params` JSON into engine `Params`. Function-call key method lists: `AGENT_KEY_METHODS` (SPEC section 15: `commit, reveal, clear, mint, merge, settle, redeem`), `KEEPER_KEY_METHODS` (those plus `finalize_print`, `prune_print`, `prune_result`) and `REPORTER_KEY_METHODS` (`report`, `finalize_print`). The port covers spec 0.4: `set_guard(guard?, max_round_lock?)`, `finalize_print`, `prune_print`, `get_pending_prints`, and the 0.4 shapes (totals with `burned`, print `state`, commit `fee`, result `fees`). |
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
chain client parses. One test runs the same 50-step scenario (reports, an early `finalize_print`, registration,
deposits including one to an unregistered account, commits, reveals, clearing, mint,
merge, transfer, guard, withdrawals, void settlement, redemption, pruning a result and a print, eight expected
refusals, each checked against the engine's `ERR` text, which is the contract's) through `ModelWeir` and through `ChainWeir` over a fake RPC that executes the
signed transactions on a second `Market`, and requires identical transcripts.

### Gas and deposits

| Method | Gas | Attached |
|---|---|---|
| `register` | 10 Tgas | 0.02 NEAR (`REGISTRATION_FEE`; the contract refunds any excess) |
| `deposit` (`ft_transfer_call` on the token) | 100 Tgas | 1 yoctoNEAR |
| `withdraw` | 50 Tgas | 1 yoctoNEAR |
| `set_guard` | 10 Tgas | 1 yoctoNEAR |
| `transfer_position` | 10 Tgas | 1 yoctoNEAR |
| `commit`, `reveal`, `settle` | 15 Tgas | none |
| `mint`, `merge`, `report`, `finalize_print`, `prune_print`, `redeem`, `prune_result` | 10 Tgas | none |
| `clear` | 150 Tgas | none |
| token `storage_deposit` | 10 Tgas | 0.00125 NEAR, `registration_only: true` |
| token `mint` | 10 Tgas | none |

The gas is one table, `GAS_TGAS` in `src/weir.ts`, from the sandbox measurements in
`integration/RESULTS.md`: every simple method burns at most 3.7 Tgas (10 leaves 2.7x);
`clear` burns 25.5 Tgas at 64 commits and 51.25 at 128 (150 leaves 2.9x at the maximum);
`withdraw` needs 24 (50); the deposit stays at 100 because the real USDC's needs are
unmeasured. `commit` gets 15 because evicting from a full round burnt 4.11 Tgas (only 2.4x
at 10). `reveal` gets 15 because a reveal into a round of 128 commits burnt 4.61 Tgas (2.17x
at 10; 3.25x at 15). `settle` gets 15: deciding two pending buckets burnt 3.12 Tgas, but the worst case, a
settle that decides many pending buckets of a delivery window, is not measured. Unused gas is refunded, and a key's
allowance is charged about the gas burnt.

## RPC endpoints

The testnet endpoints in use are `https://test.rpc.fastnear.com` and
`https://near-testnet.drpc.org` (root `deployments.json`). `rpc.testnet.near.org` is
deprecated and answers every call with HTTP 429, so it is not listed.

**Finding, 2026-11-12, about 01:00 UTC.** On live testnet the keeper logged
`report: RPC error: null`, `commit: RPC error: null` and `reveal: RPC error: null` (20 failed
entries in 14 ticks), and agents forfeited orders they could not reveal. Two provider
refusals that are not in NEAR's error shape were measured with curl:

- fastnear, over its free limit (a second tool on the same IP was also calling it), HTTP 429:
  `{"jsonrpc": "2.0", "error": {"code": -429, "message": "Rate limits exceeded. For higher rate limits get a subscription at https://fastnear.com"}, "id": "1"}`
- dRPC, for a method it does not serve (`broadcast_tx_commit`), HTTP 400:
  `{"id":2,"jsonrpc":"2.0","error":{"message":"method is not available","code":-32601}}`

The client built the message from `cause.name` and `data`, which these bodies do not have,
so the text became `RPC error: null`. It also treated any JSON-RPC error body as the node's
final answer, so a provider's refusal stopped the call instead of moving to the next
endpoint. Which refusal the keeper actually received is not known: its log only kept "null".

Error shapes seen live the same morning (`chain/test/failover.test.ts` replays them):

| Request | fastnear | dRPC |
|---|---|---|
| `tx` with an unknown hash | 200, `HANDLER_ERROR` / `UNKNOWN_TRANSACTION` | 200, the same |
| `query` of an unknown account | 200, `HANDLER_ERROR` / `UNKNOWN_ACCOUNT` | 200, the same |
| malformed `send_tx` | **400**, `REQUEST_VALIDATION_ERROR` / `PARSE_ERROR` | 200, the same |
| unknown method | 400, `REQUEST_VALIDATION_ERROR` / `METHOD_NOT_FOUND` | 400, `{"message":"method is not available","code":-32601}` |
| over the rate limit | 429, the body above | not seen |

What the client does now (`NearRpc.call`):

- **Answer or outage.** An error with NEAR's shape (`name` or `cause.name`) is the node's
  answer, whatever the HTTP status (fastnear sends some with 400), and is thrown as
  `RpcError` without trying another endpoint; `INTERNAL_ERROR` and `TIMEOUT_ERROR` are the
  exceptions. Everything else is that endpoint failing (`EndpointError`) and the next one is
  tried: no response, a timeout, HTTP 429 or 5xx, any other 4xx, an error body not in NEAR's
  shape (also with HTTP 200), or a 2xx without a result.
- **Messages.** An endpoint failure names the host, the HTTP status, and the provider's
  `message` and `code`, e.g. `test.rpc.fastnear.com answered HTTP 429: Rate limits exceeded.
  ... (code -429)`. When every endpoint fails, `RpcUnavailable` lists each one.
- **Cooldown.** An endpoint that refused or faulted goes to the back of the line for 10 s
  (`cooldownMs`), or for its `retry-after` when that is positive (at most 60 s); one that was
  only slow does not. Endpoints are otherwise tried in the order given, so the first one is
  used again once its cooldown ends. The cooldowns live in an `EndpointHealth`; clients that
  share one (`new NearRpc({ ..., health })`) steer each other.
- **Rate-limit wait.** When every endpoint refused a call for rate (HTTP 429 or code -429),
  the call waits once, for the shortest `retry-after` (1 s if none), and tries them all once
  more, but only if that wait is at most 2 s (`maxRateWaitMs`). Otherwise, and on later calls
  while all endpoints are still refusing, it fails at once without sending a request. The 2 s
  bound is the authors' choice, not a measurement: the keeper ticks once a minute with up to
  about 40 requests, and the shortest reveal window is 120 s (fast preset), so one call may
  pause briefly, but a tick cannot be stretched by a pause per request.
- **Every attempt is a request through the `fetch` passed in**, so a caller that meters its
  requests (the keeper's budget) is charged for each one; a call that fails at once during a
  cooldown sends nothing.

`sendTx` and a transaction that may already have landed: the same signed bytes are one
transaction with one hash, so sending them again can only end in that transaction's
outcome. If an endpoint fails after the request may have reached a node (no response, a
timeout, a 5xx, a node `TIMEOUT_ERROR` or `INTERNAL_ERROR`), the next endpoint gets the same
bytes. If every endpoint fails that way, the client polls `tx` for the hash; if no endpoint
knows it, it resends the same bytes once and keeps polling. `InvalidNonce` from one endpoint
after another may have delivered the transaction is checked with `tx` first: found, it is our
own transaction and its outcome is returned; unknown, the refusal stands and `NearAccount`
re-signs with a fresh nonce. An answer saying the transaction is "already known" or a
"duplicate" is read as pending and polled. A send refused everywhere for rate (429) was not
delivered and is thrown without polling. The duplicate wording is matched by pattern; no
provider was seen sending it.

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
  `send_tx` at `FINAL`; nonces under concurrency, after `InvalidNonce`, and three retries then the refusal; polling `tx` after
  a `send_tx` timeout.
- `weir.test.ts`: every state change sends the spec's argument names (SPEC sections 5 to 14)
  with the gas and deposit above, every view sends the spec's argument names, the
  model/chain transcript test, `CallFailed`, `ModelWeir` copies and shared clock.
- `tx_actions.test.ts`: 200 random transactions mixing the setup actions with function calls
  (random keys, code, deposits, allowances, method lists) encoded and signed byte-identically
  to `@near-js`; out-of-range values refused.
- `failover.test.ts`: the provider refusals above, byte for byte: fastnear's 429 fails over
  to dRPC, cools down and is used again after the cooldown; the error text names each host,
  status, message and code and never says null; dRPC's 400 fails over; a 200 with an error
  not in NEAR's shape, or without a result, fails over; a NEAR-shaped error on HTTP 400 is an
  answer and is not retried; both endpoints rate-limited, one 1 s wait and one retry; both
  rate-limited for 30 s, no wait and later calls fail without a request; and `sendTx` when the
  first endpoint hangs (same bytes to the next), when every endpoint may have delivered (polled
  to one outcome), when nobody knows the hash (one resend), `InvalidNonce` after a possible
  delivery (our own transaction), a real `InvalidNonce`, "already known", and a send refused
  for rate everywhere (thrown, not polled); two clients sharing an `EndpointHealth` share a
  cooldown.
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

Offline, the tests prove the bytes of every transaction (against `@near-js`), the method
names, argument names and JSON shapes against the spec, the gas and deposits we attach, and
identical behaviour to the model when a fake RPC executes our transactions on the engine.
`integration/` has since run `ChainWeir` and `Token` against the real contract wasm on a local
near-sandbox node, with the model alongside, and found no client bug; what that proved, the
measured gas and what it cannot prove are in `integration/RESULTS.md`. Still unproven here:
the 0.4 additions against the real contract (`finalize_print`, `prune_print`,
`get_pending_prints`, `max_round_lock`, the fee shapes) unless that run covered them; `settle`'s
gas when it decides a whole window of buckets; the official testnet USDC's
`ft_transfer_call`; RPC behaviour under real `send_tx` timeouts and nonce races on a public
network. The only live call this package's tests make is the read-only `ft_metadata` above.
