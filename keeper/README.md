# @weir/keeper

The scheduled job that keeps a live Weir market running. Once a minute it fetches the
H100 index (at most once per five minutes), has the reporters post it on chain, runs the
trading agents, clears rounds, settles series and redeems the agents' positions.

It is one platform-neutral function, `runTick(env, now)` in `src/keeper.ts`, with two thin
adapters: a Cloudflare Worker (`src/worker.ts`) and a Node loop (`src/node.ts`). It imports
`@weir/index`, `@weir/agents`, `@weir/chain` and `@weir/engine` and copies none of their code.

**One operator.** Every reporter configured here is run by this one keeper, from the same
fetch of the same sources. The quorum of reporters therefore protects against a failed
transaction, not against a wrong price. `/status` says so in `operator_note`.

## Each minute

For every market in `deployments.json`, in this order of priority (the order in which the
request budget is spent; each step runs across all markets before the next starts):

| Step | What it does |
|---|---|
| plan | `get_status` (and `get_params` once per contract, then kept in the store). Moves the "settled" mark over series that have been settled. |
| urgent reveals | If a reveal phase ends within 90 s (before the next tick), the swarm reveals now. |
| index and reports | If no fetch was made in this five-minute window: one request to each of the six sources, `makeBundle`, and, if an index formed, the canonical bundle stored under `bundles/<hash>.json` and remembered as the latest. Then for the market's bucket `floor(now / print_interval_secs) * print_interval_secs`, each configured reporter that has not reported (read with `get_print`) sends `report(bucket, index, hash)`, but only if the latest bundle was fetched inside that bucket. Reporting stops once a report makes the print final. |
| reveals and clears | The other reveals, and `clear` for every round that is over. |
| commits | New sealed orders from the agents (`tick` from `@weir/agents` with its `OrderStore` in the store). Not started with fewer than 9 requests left: one commit cannot cost less. |
| settle and redeem | `settle` for series whose delivery and report window are over, then `redeem` for every agent with a position, remembering per series who is done. |

The index is never fabricated, carried forward or interpolated: if the sources do not form
an index, nothing is stored, the reason is logged, and no reporter reports for that bucket,
even though an older bundle exists.

`runTick` returns a `TickReport`: every entry (done, skipped and why, failed and why), every
transaction with its hash, every request made and the step it was spent on, and what was left
undone. The last 200 entries are kept in the store.

**Safe to repeat and to miss.** Every decision is read from chain state: who has reported,
which commits are still unrevealed, which rounds are over, which series are settled. Sealed
orders are written to the store before they are committed. A missed reveal window is logged
as a forfeit when the round is cleared, and the keeper carries on. A run first takes a lease
in the store (write, wait 1 s on the Worker and 0.2 s in the Node loop, read back); a second run that finds it held does
nothing. On Cloudflare KV, which is eventually consistent, the lease is best effort; without
it the contract still refuses a second report and a second reveal (tested), but two runs
could in principle both commit for the same agent and round.

**Failures stay local.** A market whose status cannot be read is skipped; a failed
transaction is logged and the step goes on; an agent with a bad key is left out.

**Request budget.** At most `BUDGET` outbound requests per tick (default 40; the free
Workers plan allows 50 subrequests per invocation). Every request is charged before it is
made and refused once the budget is spent, so a tick never makes one more: a view costs 1, a
transaction 2 (access key, then `send_tx`), each index source 1, and RPC failover or polling
is charged as it happens. Reads are cached within a tick until the next state change.
When the budget runs out, the remaining steps are skipped and named in `undone`.

Measured on the model: over three hours of the fast market (8 agents, 3 reporters) the
keeper averaged 20 requests a tick, peaked at 40 in ticks that start a round (index fetch,
reports and 8 commits), and spread what did not fit over the next minute. At a budget of 10 it
still prints every bucket, clears every round and settles and redeems, but cannot commit, and
can reveal at most 8 orders per fast round (2 ticks of 10 requests).

## Run it

### Option 1: Cloudflare Worker

```sh
pnpm --filter @weir/keeper exec wrangler login
pnpm --filter @weir/keeper exec wrangler kv namespace create STORE
# put the printed id in wrangler.jsonc in place of REPLACE_WITH_KV_NAMESPACE_ID
pnpm --filter @weir/keeper exec wrangler secret put REPORTERS
pnpm --filter @weir/keeper exec wrangler secret put AGENTS
pnpm --filter @weir/keeper exec wrangler secret put SWARM_SECRET
pnpm --filter @weir/keeper exec wrangler deploy
```

None of these have been run. The cron trigger is `* * * * *`. `deployments.json` is bundled
into the Worker at build time, so a new market means a new deploy. Routes, all GET (and
HEAD), with `Access-Control-Allow-Origin: *`:

| Route | Answer |
|---|---|
| `/bundles/<hash>.json` | The canonical bundle; its sha256 is `<hash>`, the `bundle` argument of the reports. `Cache-Control: public, max-age=31536000, immutable`. 404 if unknown. |
| `/latest.json` | `{ "hash", "bundle" }` of the latest bundle that formed an index. `max-age=30`. |
| `/status` | Last tick, the operator note, the budget used per step, what was left undone, the last index attempt (with per-source errors), a summary per market, the last 50 log entries. No secrets: everything is passed through a redactor that replaces every configured key and the swarm secret before it is stored. |
| `/health` | 200 if the last tick is at most 5 minutes old, else 503. |

`wrangler deploy --dry-run --outdir <tmp>` works without logging in: 101.6 KiB, 30.2 KiB gzipped.

### Option 2: Node loop

```sh
cp keeper/.env.example keeper/.env        # fill in; keeper/.env is ignored by git
node --env-file=keeper/.env keeper/src/node.ts --once
node --env-file=keeper/.env keeper/src/node.ts --loop --port 8787
```

Same `runTick`, same routes on `--port`, the store in `keeper/store/` (one file per key,
`--store` to change it), `--deployments` and `--budget` to override. `--loop` ticks at the
start of each minute, one tick at a time.

## Secrets

All three are JSON or plain strings in environment variables (Worker secrets or `.env`).
They never appear in `deployments.json`, the log or the routes.

```jsonc
// REPORTERS: accounts in the contract's `reporters`; others are ignored for that market.
[{ "account_id": "reporter-a.example.testnet", "secret_key": "ed25519:<base58>" }]

// AGENTS: role is buyer | seller | maker | noise. Optional, with defaults:
//   buyer:  need 40, premium_bps 500         seller: capacity 180, premium_bps 500
//   maker:  spread_bps 600, share_bps 1000, max_size 40
//   noise:  view_bps 1000, min_size 3, max_size 10
//   markets: ["fast"] to trade only some markets (default: all)
[{ "account_id": "buyer-1.example.testnet", "secret_key": "ed25519:<base58>", "role": "buyer", "need": 40 }]

// SWARM_SECRET: any long random string. Salts of sealed orders derive from it.
```

The first agent also signs `clear` and `settle` (anyone may call them). SPEC section 15 lists
an agent's function-call key as limited to `commit`, `reveal`, `clear`, `mint`, `merge` and
`redeem`; the first agent's key must also allow `settle`, or settlement will fail on chain.
Agents must already be registered on each contract and funded; the keeper does neither.

## Cost per tick

`node keeper/scripts/bench.ts` runs an hour of the fast market on `ModelWeir` with the index
package's saved source responses (321 KiB of JSON), then times the pieces a real tick runs on
its own CPU. On this machine (Node 22.23, Apple silicon):

| | CPU |
|---|---|
| Median model tick (keeper, swarm and the engine executing every call) | 0.7 ms |
| Median model tick with an index fetch | 4.1 ms |
| Busiest model tick (index fetch, 7 transactions, 40 requests) | 9 to 11 ms |
| Parse the six payloads (`makeBundle`), warm | 0.8 ms |
| Hash the bodies and the bundle, warm | 0.4 ms |
| Sign one transaction (borsh, sha256, ed25519), warm | 0.25 ms |
| First tick in a fresh process (JIT, first index fetch) | 43 to 48 ms |
| First key derivation (`@noble/ed25519` tables) | 16 to 19 ms |

Estimated keeper CPU for a tick on chain: about 1 ms for a tick with 4 transactions, about
3.5 ms for an index tick with 9 transactions, warm. A cold isolate adds tens of milliseconds.
Store writes: 6.2 per tick, about 8,900 a day.

**Recommendation: the Node loop, or the Workers Paid plan.** Not the free plan, for two
reasons. Its 10 ms CPU limit is met by warm ticks but exceeded by any cold start (about 45 ms
measured) and approached by busy index ticks. And its KV allows 1,000 writes a day, against
about 8,900 needed. (Both limits as Cloudflare publishes them; neither was tried against an
account.) The Node loop costs nothing on any always-on machine and has neither limit; the paid
Worker needs no machine.

## Tests

```sh
pnpm --filter @weir/keeper test        # node --test, offline
pnpm --filter @weir/keeper typecheck   # tsc --noEmit
pnpm --filter @weir/keeper bench
```

All on `ModelWeir` with an in-memory store, a fake clock and a fake fetch serving the index
fixtures (`test/harness.ts`: fast preset, three reporters with quorum 2, eight agents):

- `run.test.ts`: three hours ticked every minute (all 37 buckets printed, every round with
  commits cleared, every commit revealed, zero forfeits, series 0 and 1 settled, every
  position redeemed, `get_totals` adds up to the deposits, never over 40 requests, every
  transaction logged with its hash); ticks missed across a reveal window (each forfeit logged
  with its amount, the bonus pool matches, later rounds trade normally); three sources failing
  for a bucket (one fetch per window, no report, the reason in every tick's log, the last good
  bundle not reused, reporting resumes); a budget of 10 (never an 11th request, requests in
  priority order, reveals spread over two ticks with urgent ones first, everything printed,
  settled and redeemed, the one forfeit that cannot fit logged); two overlapping runs per
  minute (one works, one stands aside, the same events as a single run); overlapping runs
  without the lease (the contract refuses duplicates, nothing stops).
- `worker.test.ts`: the routes (status codes, CORS, cache headers, 404 for an unknown or
  malformed hash, the bundle's sha256 is its name), the cron handler with bad keys and the
  network down, no secret anywhere in `/status`, `/latest.json`, `/health` or the store
  (recognisable fake keys, plus malformed JSON in a secret), `src/` free of Node imports
  except `node.ts`.
- `node.test.ts`: the directory store under real ticks.

## Not built

- **Independent or staggered reporters.** All reporters report from one fetch by one
  operator in the same minute.
- **Raw source bodies are not published.** Bundles carry each body's sha256 and the parsed
  offers, so anyone can recompute the index, but not check the hashes against the bodies.
- **A retry within the five-minute window** when the index fetch fails, and any source retry
  (each source gets one request; the next window tries again).
- **Registration, funding, guards and withdrawals** of agents, and `prune_result`.
- **A strict lock.** The lease is best effort on KV; Durable Objects would give a real one.
- **Alerts.** `/health` returns 503 when stale, but nothing pages anyone.
- **Agents added later** are not redeemed on series the keeper has already marked done.

## What the other packages lack (worked around, not patched)

- `@weir/index`: `fetchAll` uses the global `fetch` with a retry after 2 s, so it cannot be
  metered or faked; the keeper has its own 20-line fetcher (`src/indexer.ts`) and uses
  `makeBundle`, `bundleHash`, `canonical`, `sha256Hex`, `SOURCES` and `USER_AGENT` as they are.
- `@weir/agents`: `tick` cannot be told to do only some of its work (only reveals, only
  clears) or to skip series. The keeper runs it several times per tick with ports that defer
  the state changes a step may not make, and drops those entries from the log; repeated reads
  are served from the per-tick cache. `SIM_T0` is not exported from the package root.

## Not proven

The keeper has never run against a real contract, a real RPC node or a real Cloudflare
account. Proven offline: the step order, the budget ceiling, idempotence under repeated and
missed ticks, the lease in one process, the index pipeline on saved responses, the routes and
the redaction. Not proven: that `ChainWeir` transactions land as the model's calls do (see
`chain/README.md`), real RPC latency and its effect on how much fits in a tick, request counts
under failover and `send_tx` polling, real Worker CPU time and cold starts, KV consistency
for the lease, KV and subrequest limits as enforced, the cron trigger's timing, and live
source responses beyond the saved ones.
