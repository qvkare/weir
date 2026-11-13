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
| `src/near.ts` | `NearRpc`: `query` views (`call_function`, args base64, result decoded from bytes), `view_account`, `view_access_key`, latest block hash, `send_tx` waited on until `FINAL`. Failover, cooldowns and rate-limit waits are described under "RPC endpoints" below. `decodeOutcome` gives `{ ok, result, logs, error, tx_hash, gas_burnt }`. `NearAccount` signs and sends one transaction at a time per instance (`functionCall`, or `functionCalls` for several calls to one receiver in one transaction), so nonces never collide, and on `InvalidNonce` retries up to three times (`NONCE_RETRIES`) with a fresh nonce, starting above the `ak_nonce` the refusal names. |
| `src/weir.ts` | `WeirPort`, typed by `@weir/engine`'s wire types (`ViewMethods`, `ChangeMethods`), never redefined here. `ChainWeir` (over `near.ts`) and `ModelWeir` (over an engine `Market` through `callView`/`callChange`, settable clock, plus a synchronous `sync` face). A failed chain call throws `CallFailed`, whose message is the contract's bare panic text, the same text `ModelWeir` throws. `paramsFromWire` turns `get_params` JSON into engine `Params`. Function-call key method lists: `AGENT_KEY_METHODS` (SPEC section 15: `commit, reveal, clear, mint, merge, settle, redeem`), `KEEPER_KEY_METHODS` (those plus `finalize_print`, `prune_print`, `prune_result`) and `REPORTER_KEY_METHODS` (`report`, `finalize_print`). The port covers spec 0.4: `set_guard(guard?, max_round_lock?)`, `finalize_print`, `prune_print`, `get_pending_prints`, and the 0.4 shapes (totals with `burned`, print `state`, commit `fee`, result `fees`). |
| `src/token.ts` | `Token`: `storage_deposit`, `ft_balance_of`, `storage_balance_of`, `ft_transfer_call` into Weir (the optional beneficiary goes in `msg`, SPEC section 5) and the test token's open `mint(account_id, amount)`. |
| `src/intents.ts` | NEAR Intents 1Click client, quotes only: `POST /v0/quote` with `dry: true` (it refuses anything else) and `GET /v0/tokens`. USDC asset ids for Base, Arbitrum, Ethereum, Solana and NEAR. |
| `src/faucet.ts` | The testnet faucet client (`createWithFaucet`): the same request and retry rule as `deploy/src/chain.ts`'s `faucetCreator`, with the transport, clock and sleep passed in so it runs in a browser. The deploy tool keeps its own copy, unchanged, so its tested path did not move the day before the deadline. |
| `src/guest.ts` | The guest path: a throwaway account places one sealed bid. See "One sealed bid by a guest" below. |
| `src/cli.ts` | Node only. `quote --from arbitrum\|ethereum\|solana\|base --amount 20 --to <near account>`, and `try` (the guest path). |
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
`report: RPC error: null`, `commit: RPC error: null` and `reveal: RPC error: null`: 24 failed
log entries for 12 transactions in 5 ticks, 00:52 to 01:01 UTC (counted from the keeper's log;
`keeper/README.md`, "First night on testnet"). Every one of them that was then looked up on
chain had landed: both rounds held their 7 commits, nothing was forfeited, and the 01:00 prints
held all 3 reports. So the transactions were accepted and the client reported a failure; that
the refusal came after delivery is inferred from this, not observed. Two provider
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
  only slow (a timeout, or HTTP 408, 504 or 524) does not. Endpoints are otherwise tried in the order given, so the first one is
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
- **The caller's own errors.** Every error the passed-in `fetch` throws, of any class, is
  that endpoint failing: runtimes differ (Node throws `TypeError: fetch failed`; Cloudflare
  Workers may throw a plain `Error`, such as "Network connection lost."), so the class cannot
  be relied on. A caller whose `fetch` throws errors of its own (the keeper's
  `BudgetExhausted`) names them with `isCallerError`: those go up unchanged, with no failover
  and no cooldown, and if one interrupts the lookups of a transaction that may have landed,
  it comes back as `TxStatusUnknown`, never as a failure.

**Second finding, 2026-11-12, 19:00 UTC.** With the messages above in place, the live
keeper logged, for each of 4 report transactions on two markets in one tick:

> report for bucket 1794510000 failed: every RPC endpoint failed for send_tx:
> near-testnet.drpc.org answered HTTP 408: Request timeout on the free plan, please upgrade
> to paid plan (code 30); test.rpc.fastnear.com answered HTTP 429: Rate limits exceeded.
> For higher rate limits get a subscription at https://fastnear.com (code -429)

fastnear rate-limits at the top of the hour, when the keeper reports for four markets in one
tick; the send then went to dRPC, whose free plan gives up on a `send_tx` that waits for
`FINAL` and answers 408. The keeper's log analysis found that every such transaction it
looked up had landed (`keeper/README.md`, "First night on testnet"): dRPC forwards the
transaction, then times out its own HTTP request. The client classified 408 as a refusal
(a 4xx, not delivered), so it did not look the transaction up and reported a landed
transaction as failed. That was the fault.

dRPC's free plan and `tx`, measured the same evening for a final transaction
(`5Hekok9D...`, signer `keeper.weir-ops-w1.testnet`, from `evidence/deploy/testnet-w1.json`),
one request each, 5 s apart: `wait_until` `NONE` 138 ms, `INCLUDED` 119 ms, `INCLUDED_FINAL`
129 ms, `EXECUTED_OPTIMISTIC` 162 ms, `EXECUTED` 125 ms, `FINAL` 150 ms, all HTTP 200 with
the full outcome and `final_execution_status: "FINAL"`. A transaction that is final is
therefore answered at once at every level. What it answers for a transaction still in
flight was not measured (that needs a transaction to be sent).

What the client does now:

- **408, 504 and 524** are a gateway timing out its own request: the transaction may have
  been delivered (`maybeDelivered`), and the endpoint is slow, not refusing (`timeout`): no
  cooldown, so it still serves the lookups and the reads that follow. A view that gets a 408
  fails over to the next endpoint.
- **Sending.** The first attempt waits for `FINAL` (`send_tx`), so the common case is one
  request, two with the keeper's access-key read. If it fails, the next endpoints get the same
  signed bytes with `wait_until: NONE`, which returns as soon as the node has them. Then, and
  whenever any endpoint may have delivered the transaction, it is looked up with `tx` by hash
  and signer at `wait_until: NONE`, every 1 s, up to 8 times, until it is executed in final
  blocks (`EXECUTED` or `FINAL`). If no endpoint knows the hash after two lookups, the same
  bytes are sent once more without waiting; the same bytes can only land once. If it is still
  not final after the 8 lookups, the error is `TxStatusUnknown`: the transaction may yet land,
  so it must be reported as unknown, not as failed, and not signed again.
- **Cost per transaction, in requests**, counting the access-key read: 2 in the common case;
  in the 19:00 case 1 + 2 sends + the lookups, typically 2 to 4 (a lookup a second until
  finality): 5 to 7, and at most 1 + 2 + 8 + 2 = 13 when nothing is known. Each lookup waits
  1 s first, so such a transaction takes a few seconds.

The rest of `sendTx`: `InvalidNonce` from one endpoint after another may have delivered the
transaction is checked with `tx` first: found, it is our own transaction and its outcome is
returned; unknown everywhere, the refusal stands and `NearAccount` re-signs with a fresh
nonce. An answer saying the transaction is "already known" or a "duplicate" is read as
pending and looked up. A send refused everywhere for rate (429) was not delivered and is
thrown without a lookup. The duplicate wording is matched by pattern; no provider was seen
sending it.

## One sealed bid by a guest

`make try` (or `node chain/src/cli.ts try`) has a new throwaway testnet account place one sealed
bid in the hourly demo market `weir-h100-fast-w1.testnet`, by itself, with no wallet and no keys
from the person running it. `make try TRY_ARGS=--plan` reads the chain, prints the series, round,
phase and the order it would place, and sends nothing.

What `src/guest.ts` does, in two phases:

- **Setup** (`Guest.setup()`, throwaway accounts only): a random 32-byte key (`secretKeyFromSeed`),
  the account `weir-try-<12 hex>.testnet` from the faucet, then the transactions of
  `setupTransactions`: `register {}` to Weir with 0.02 NEAR, then one transaction to the test dollar
  with `storage_deposit`, `mint` and `ft_transfer_call` (enough for size x band + the commit fee,
  in whole dollars). A wallet can sign the same two transactions. If Weir sends the deposit back
  because the registration had not landed (SPEC section 5), `depositRefunded` sees it and the
  next run deposits again.
- **Trading** (`Guest.trade()`, or `Guest.forAccount(config, deps, { accountId, secretKey })` for
  an account a wallet set up): LONG 5 GPU-hours at the last clearing price of the series (else the
  reference price from the last print) plus 15% of the band, at most band - tick, on the tick. A
  commit phase with less than 30 s left is skipped for the next round. The order and its salt are
  stored before `commit` is sent; the local hash is compared with the contract's `commit_hash`
  first. Then it reveals when the reveal phase opens, waits 20 s after the round for the keeper and
  clears the round itself if nobody has, and reads `get_result` and `get_position`. `settle()`
  later settles the series and redeems. Trading attaches no deposit and calls no token, so a
  function-call key for `AGENT_KEY_METHODS` is enough; when such a key's allowance is below the
  0.155 NEAR a `clear` needs, it waits two more minutes for the keeper and then stops in plain words.

Every step reads the chain before it acts, so a run that stopped (a crash, a page reload) resumes
from storage: it does not create, register or deposit twice, finds its own commit by hash instead
of committing again, and reveals the stored order. It stops before creating anything when no
series is in auction or the index is stale. No commit is started after the time limit (15 min);
a commit already made is always revealed and cleared. Views are polled every 5 s at most, and
requests are at least 1 s apart. Events (`step`, `done`, `tx` with its nearblocks link,
`refused` with the contract's text verbatim, `wait`) are what a page or the terminal prints.

The CLI keeps its state, which holds the throwaway key, in a new `mktemp`-style directory under
the system's temporary directory (outside the repository), mode 600, and never prints the key.
It prints the account name, each step and transaction link, the clearing price, the fill and
the total time, and exits 1 with the reason on failure.

`try --plan` against testnet on 2026-11-13 at 19:17 UTC (5 views, 5 s apart, 20 s):

```
  last index print  2.8625 USD per GPU-hour, bucket 2026-11-13T19:15:00.000Z (126 s old)
  series, round     43, 4  phase Commit, ends in 54 s
  status            ready: series 43, round 4: 54 s of the commit phase left
  band              floor 2.386 USD, width 0.842 USD, tick 0.001 USD (series open)
  last clearing     round 3: 2.774 USD
  suggested order   LONG 5 GPU-hours at most 2.90 USD per GPU-hour (514000 above the floor); lock 2.57 USD + fee 0.10 USD
  would fund        up to 4.31 USD (size x band + fee), minted on the test dollar weir-usdc-w1.testnet
```

Tests: `test/guest.test.ts`, 12 tests on the fake RPC (the engine executes the signed
transactions) and a fake faucet: the whole path to a filled order; a restart between commit and
reveal; a restart after the commit landed but before its seq was stored (no second commit); the
faucet's 429 then success, and its refusal; less than 30 s left; a round nobody clears; refusals
with the contract's text (a full round, a clear that lost the race to the keeper, a stale index);
a deposit refunded because the registration had not landed, deposited again; an account set up
elsewhere trading with commit and reveal only; a key without allowance for clear.

**Run on testnet, once.** `make try` on 2026-11-13 from 19:20 UTC, on an Apple-silicon laptop:
the faucet created `weir-try-070943795d17.testnet` in 10 s; it registered, then minted and
deposited 5.00 USD in the one three-action transaction; it committed LONG 5 GPU-hours at most
2.90 USD in round 5 of series 43, revealed when the reveal phase opened, waited 24 s after the
round for the keeper, cleared the round itself, and was filled 5 of 5 at 2.838 USD per GPU-hour.
341 s in all, 6 transactions:
[create_account](https://testnet.nearblocks.io/txns/EQGmc2tPWjS9rcmqbWCmUoQ28cJX26FZC9sHBTjpryoD),
[register](https://testnet.nearblocks.io/txns/H3uvbGL2tL9goxoFiFRq4uivmsauTLimLNzqKfeP5DgC),
[storage_deposit, mint and ft_transfer_call](https://testnet.nearblocks.io/txns/Hp8s2sQ5gvuwsHsvroqqjU6eZDvEJJ7eAyXdJ8Kv5De5),
[commit](https://testnet.nearblocks.io/txns/79uUqx9Tbm14sb3bjpGYQSdCH14CW14nkTkkDnAXzxjB),
[reveal](https://testnet.nearblocks.io/txns/DJfDxkbpJjMSgH8ib14rZn3Wuy2zZon1d9H2iMS3wKEM),
[clear](https://testnet.nearblocks.io/txns/MMfP6B53Znc51GUHeWAGGBEMTx8g6aeQSm7jZEhxxdn).
Read back afterwards with one `get_result` call through fastnear: series 43, round 5, price
452000 above the floor of 2.386 USD, volume 35, and in `fills` the guest's order with `filled: 5`.

`--settle` for that account ran once, at 21:03 UTC the same day, three minutes after series 43's
delivery hour ended: it sent
[settle](https://testnet.nearblocks.io/txns/CAS1SKb7ctXPpvtGh9wXZFSrHMWbpDmjVDmf2Z4EzF87) itself and
[redeem](https://testnet.nearblocks.io/txns/HTBtX1x9JnRCXXF8jD8K2vjwMfSmezJkQG9K2D9ecGaJ) in 12 s,
and the account's free balance in the market went from 2.64 USD to 5.13708 USD (5.00 USD had been
deposited; LONG 5 bought at 0.452 USD above the floor was paid 0.499416 USD each).

A browser has since run the module, from a local preview and from the deployed site, where the
faucet answered the page's cross-origin request ([`web/README.md`](../web/README.md)).

**Not proven.** From the terminal, one run is one run: how often the faucet rate-limits, and how
the run behaves at the top of the hour, are not known. The
allowance refusal text (`NotEnoughAllowance`) is matched by pattern and was not seen live. If a
commit's outcome is unknown and the commit lands more than about 10 s later, a restart in the same
commit phase plans a new order with a new salt; the late commit is then not revealed and loses
1% of its lock at clearing (about 0.03 USD for the suggested order).

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
  cooldown; the 19:00 case (fastnear 429, dRPC's exact 408) with the transaction found by `tx`
  (one success, four requests after the access key) and unknown everywhere (one resend of the
  same bytes, then `TxStatusUnknown`, never a failure); a 408 on a view (fails over, no
  cooldown); every class a fetch throws (plain `Error`, `TypeError`, abort error) fails over; an error
  `isCallerError` accepts goes up unchanged before a send, with no cooldown, and as
  `TxStatusUnknown` after one.
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
