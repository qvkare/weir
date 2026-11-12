# @weir/keeper

The scheduled job that keeps live Weir markets running, one market per chip (SPEC 0.4). Once a
minute it fetches the GPU-hour indexes (at most once per five minutes, every chip in one fetch),
has the reporters post each market's chip on chain, finalizes buckets a reporter missed, runs
the trading agents, clears rounds, settles series, redeems the agents' positions and prunes
what the contract no longer needs to store.

It is one platform-neutral function, `runTick(env, now)` in `src/keeper.ts`, with two thin
adapters: a Cloudflare Worker with one Durable Object (`src/worker.ts`, `src/durable.ts`) and a
Node loop (`src/node.ts`). It imports
`@weir/index`, `@weir/agents`, `@weir/chain` and `@weir/engine` and copies none of their code.

**One operator.** Every reporter configured here is run by this one keeper, from the same
fetch of the same sources. The quorum therefore protects against a failed transaction, not
against a wrong price. `/status` says so in `operator_note`.

## Markets

`deployments.json` lists the markets: `{ id, label, chip, contract, usdc }`, with `id` one of
the agents package's `MARKETS` (`h100-fast`, `h100-weekly`, `h200-weekly`, `a100-80-weekly`)
and `chip` one of the index package's chips (`h100`, `h200`, `a100-80`). Each market's
reporters report from the bundle of its own chip.

## Each minute

Steps, in the order the request budget is spent. Each step runs across the markets before the
next starts.

| Step | What it does |
|---|---|
| plan | `get_status` per market (and `get_params` once per contract, then kept in the store). Moves the "settled" mark over series that have been settled. |
| urgent reveals | If a reveal phase ends within 90 s (before the next tick), the swarm reveals now. |
| index, reports, finalize | If no fetch was made in this five-minute window: `fetchChips` for the markets' chips, with the keeper's metered fetch and no retry (8 requests for all three chips: identical requests are made once), and one bundle per chip stored under `bundles/<hash>.json`. Then, for each market's bucket `floor(now / print_interval_secs) * print_interval_secs`, each configured reporter that has not reported (read with `get_print`) sends `report(bucket, index, hash)` from its chip's latest bundle, only if that bundle was fetched inside the bucket. With every reporter of the contract reporting, the bucket is decided at once (SPEC section 9). If some are missing, the bucket is remembered and, once its report window has closed, decided with `finalize_print`; once per bucket the keeper also reads `get_pending_prints` to catch buckets reported by others. A bucket decided with no print is logged with the reason (fewer reports than `quorum`, or the two middle reports further apart than `max_spread_bps`). |
| reveals and clears | The other reveals, and `clear` for every round that is over. |
| commits | New sealed orders (`tick` from `@weir/agents`; it sizes orders for the commit fee). Not started with fewer than 9 requests left: one commit cannot cost less. |
| settle and redeem | `settle` for series whose delivery and report window are over, then `redeem` for every agent with a position, remembering per series who is done. |
| prune | At most 3 prune transactions per market per turn: `prune_print` for buckets with stored reports once `now >= bucket + 2 * period_secs` (two hours on the fast market, two weeks on the weekly ones), and `prune_result` for every result of a settled series, oldest first. The last print and the accumulators are kept by the contract and are not affected. Then `get_totals` after any clear, for the cost report. Needs the housekeeping account (below). |

A chip whose sources form no index gets nothing stored, the reason is logged, and no market
on that chip reports for that bucket, even though an older bundle exists. A price is never
fabricated, carried forward or interpolated.

**Fairness.** Urgent reveals, the index, reports and finalize run for every market every tick.
The other steps run for a market on its turn: every `cadence` minutes, the largest whole number
of minutes that still gives the market at least 6 turns per commit phase and 3 per reveal
phase. That is 1 minute for the fast preset and 5 for the weekly one, and markets with the same
cadence take different minutes (weekly market *i* acts when `minute mod 5 = i mod 5`). Within
every step the markets taking part are served in an order that rotates by one each tick, so
a market with work is first in line at least once every k of its turns, k being the number of
markets acting in the same minute: with the four markets, every 2 minutes for the fast one and
every 10 for a weekly one. `test/run.test.ts` checks who acts, that nobody spends out of turn,
the head-of-line bound, and that over an hour every fast round got commits (at least four agents
a round on average) and at least half the agents got an order into round 0 of each weekly market.

**The cost of the swarm.** For every round this keeper clears, it adds up its agents' commit
fees and the forfeits of their unrevealed commits, from the round's book as read on chain just
before clearing. `/status` shows them per market and per agent (`costs`), with the market's
`get_totals().burned` at the first tick and now. The tick log gets a `costs` line whenever a
round was cleared. Rounds cleared by someone else are not counted in the agents' figures; they
are in the burned total.

`runTick` returns a `TickReport`: every entry (done, skipped and why, failed and why), every
transaction with its hash, every request made with its step and market, the order markets were
served in, and what was left undone. The last 200 entries are kept in the store.

**Safe to repeat and to miss.** Every decision is read from chain state. Sealed orders are
written to the store before they are committed. A missed reveal window is logged as a forfeit
when the round is cleared, and the keeper carries on. In the Node loop a run first takes a
lease in the store (write, wait 0.2 s, read back); a second run on the same directory that
finds it held does nothing. The Durable Object runs without the lease: its store is its own,
and it never runs two ticks at once (Option 1 below). Without a lease the contract still
refuses a second report and a second reveal (tested), but two keepers on two stores could both
commit for the same agent and round: never run the loop and the Worker together. An order
missing from the store is rebuilt at reveal time from its commit and `SWARM_SECRET` (the agents
package's `rebuildOrder`; `test/durable.test.ts` reveals through a fresh store orders committed
through another, with nothing forfeited). Refusals are recognised
by the engine's `ERR` texts (SPEC section 16): `ERR.ALREADY_REVEALED`, `ERR.CLEARED` and
`ERR.SETTLED` from another caller count as "done by another caller first";
`ERR.DUPLICATE_REPORT`, `ERR.DECIDED`, `ERR.NO_REPORTS`, `ERR.NO_POSITION` and
`ERR.NOT_DECIDED` are handled where they can occur.

**Failures stay local.** A market whose status cannot be read is skipped; a failed transaction
is logged and the step goes on; an agent with a bad key is left out.

**Configuration problems stay in view.** A secret that is not valid JSON, an entry that is
dropped, a key that does not parse, a signer with no key for a market's contract: each is
logged, and also listed under `config` in `/status`, recomputed every tick, so it is shown for as
long as it holds and is gone the tick after it is mended. The log alone was not enough: `/status`
shows the last 50 entries, and one busy tick (four markets, eight agents each with a bad key)
logs more than 50 after the line that named the problem. A market that could not be opened in a
tick keeps the problems last found for it. `test/worker.test.ts` checks both.

**Request budget.** At most `BUDGET` outbound requests per tick (default 40; the free Workers
plan allows 50 subrequests per invocation). Every request is charged before it is made and
refused once the budget is spent, so a tick never makes one more: a view costs 1, a
transaction 2 (access key, then `send_tx`), each distinct index request 1, and RPC failover or
polling is charged as it happens. Reads are cached within a tick until the next state change.
When the budget runs out, the remaining steps are skipped and named in `undone`.

**RPC endpoints, shared.** `nearChain` gives every connection (each market, each signer) one
`EndpointHealth` from `@weir/chain`, kept for the life of the Node process or the Worker isolate.
An endpoint that refused (HTTP 429, code -429) or faulted is passed over by every connection for
10 s, or for its `retry-after` up to 60 s (chain/README.md, "RPC endpoints"), so a 429 seen for one
market does not cost a refused request on each of the others. Each attempt still goes through the
tick's metered fetch and is charged; a call that fails at once because every endpoint is cooling
down sends nothing and is charged nothing. A cooldown is a wall-clock deadline, so one taken
late in a tick can still hold when the next starts; that is kept on purpose (the endpoint asked
for it, and asking again spends budget on another refusal). The tick then logs which endpoints it
starts without, and `/status` shows `rpc_cooling` at the end of the last tick. `test/rpc.test.ts`
checks the sharing, the carry-over, its end, and the charges.

Measured on the model with all four markets for three hours: a mean of 28 requests a tick, 40
at most (ticks with an index fetch and reports for every market), what did not fit done in the
next minutes. The sandbox run of the earlier version (`integration/RESULTS.md`, one market) had
a median of 17. At a budget of 10 on the fast market alone the keeper still prints every bucket,
clears every round, settles and redeems, but cannot commit, and reveals at most 8 orders per
fast round. With four markets a budget below the index fetch plus the four status reads (12)
cannot fetch the index at all.

## Keys

The chain package's function-call key lists:

| List | Methods | Used by |
|---|---|---|
| `REPORTER_KEY_METHODS` | `report`, `finalize_print` | each reporter |
| `AGENT_KEY_METHODS` | `commit`, `reveal`, `clear`, `mint`, `merge`, `settle`, `redeem` | each agent |
| `KEEPER_KEY_METHODS` | the agent list plus `finalize_print`, `prune_print`, `prune_result` | the optional housekeeping account |

**One key per contract.** A NEAR function-call key names exactly one receiver contract, so an
account acting on several markets needs one key per market contract. Every signer therefore
takes `keys`, a map from contract account to key. A single `secret_key` is used on any contract
without an entry in `keys`; that is right only for a full-access key (tests, a sandbox), never
for function-call keys on more than one market (the sandbox run found exactly that:
`ReceiverMismatch` on the second market). When a signer has no key for a market's contract,
the keeper sends nothing for it there and logs once per run that it cannot act on that market
and why.

**Who signs what, in order.** The keeper sends a call only through a signer whose role list
allows the method and whose key for that contract has not been refused. If one is refused, it
tries the next:
- `clear` and `settle`: the housekeeping account, then each agent of that market in
  configuration order;
- `finalize_print`: the housekeeping account, then each reporter;
- `prune_print` and `prune_result`: the housekeeping account only (no other list allows them).
  Without it, or without its key for a market, pruning is off for that market, and `/status`
  says so;
- `report` by each reporter, and `commit`, `reveal` and `redeem` by each agent, for itself.

If nobody may make a call on a market, that is logged once per run.

**Refused keys.** A key the node refuses because of the key itself (`ReceiverMismatch`,
`MethodNameMismatch`, `NotEnoughAllowance`, `DepositWithFunctionCall`, `AccessKeyNotFound`) is
never retried in that run. It is logged once with what to fix, listed in `/status` under
`key_faults`, and set aside for an hour, so a bad key costs two requests an hour, not two every
turn. The call goes to the next signer in the order above.

**The housekeeping account** (`KEEPER` secret, optional) holds, on each market's contract, a
function-call key for `KEEPER_KEY_METHODS` and nothing else. With it the agents' keys need
nothing beyond `AGENT_KEY_METHODS`. It needs no registration and no USDC, only NEAR for gas.

## Run it

### Option 1: Cloudflare Worker and one Durable Object (fits the Free plan)

The keeper's state lives in one SQLite-backed Durable Object, `KeeperObject` (`src/durable.ts`),
one instance under the fixed name `keeper`. Its storage is the keeper store: one SQL table,
`kv (key, value, at)`, `at` being when the value was written (`src/sqlstore.ts`). The object's
alarm runs `runTick` once a minute. The Worker (`src/worker.ts`) only passes calls on.

**The minute.** Each alarm first arms the next one, for the start of the next minute, and then
runs the minute it woke in. So:
- a tick that throws or stalls leaves the next minute armed (nothing it does comes first);
- a late alarm runs the current minute once; the minutes missed are not replayed (the Node
  loop's rule);
- two ticks never overlap: Cloudflare runs at most one `alarm()` per object at a time (the alarms
  page, below), the object refuses a second tick while one runs, and it records the minute each
  tick starts (`object/started`), so an alarm delivered twice (alarms are at-least-once) does not
  run that minute again. A tick longer than a minute makes the next one start late, in the minute
  it then wakes in;
- an alarm firing up to 1 s early counts as the minute it was set for.

**The watchdog.** The cron trigger (`* * * * *`) asks the object to arm its alarm only when
none is armed: after the first deploy, or if a `setAlarm` failed. It costs one Worker request and
one object request a minute, and no store write when the alarm is armed. An alarm-only design
would have no way to start or restart itself; a cron-only design would make a Worker wait 18 to
43 s on the object every minute, which the Free plan's documentation neither allows nor forbids.

**The lease is off in the object.** The lease exists because two runs over one KV namespace
could overlap. The object's store is private to it and the object never runs two ticks at once,
so the lease would only cost its 1 s confirmation wait (1,440 s of billed duration a day) and two
rows written a tick. What the lease guarded against across keepers, it never could: the Node loop
and the Worker have separate stores, so nothing but the operator keeps them from running together.

**Retention.** Every 6 hours, after a tick, values under `bundles/` and `orders/` written more than
15 days ago are deleted, except each chip's latest bundle. 15 days: a print may be pruned from the
contract two periods after its bucket (two weeks on the weekly markets), plus a day. A print that
is not pruned stays readable on chain longer than its bundle; with the housekeeping account
configured the keeper prunes them. A sealed order is needed for at most one round (an hour on the
weekly markets). Without the rule the store would grow about 6.3 MiB a day without end.
`test/durable.test.ts` checks the rule.

**The routes.** The same four routes as before, served from the object's store. The Worker
answers OPTIONS, other methods and unknown paths itself (the watchdog's path among them: it is
never forwarded), and looks in the Cache API before asking the object for `/bundles/<hash>.json`
(cached as its `immutable` header says) and `/latest.json` (30 s). `/status` and `/health` always
reach the object. The Cache API is per data centre, and its documentation names custom domains
as having working cache operations; on a `workers.dev` address it may do nothing, and then every
bundle read is one object request (browsers still cache it for a year from its header).

| Route | Answer |
|---|---|
| `/bundles/<hash>.json` | The canonical bundle of any chip; its sha256 is `<hash>`, the `bundle` argument of the reports. `Cache-Control: public, max-age=31536000, immutable`. 404 if unknown (not cached). |
| `/latest.json?chip=h100` | `{ chip, hash, bundle }` of that chip's latest bundle with an index (`chip` defaults to `h100`; 404 for an unknown chip or none yet). `max-age=30`. |
| `/status` | Last tick, the operator note, configuration problems that hold (`config`, including a secret that is not set), the budget used per step, the order markets were served in (`order`, `acting`), what was left undone, the last index attempt per chip (with per-source errors), a summary per market (bucket, print state, buckets waiting for `finalize_print`, marks, pruning, costs), refused keys (`key_faults`), RPC endpoints cooling down (`rpc_cooling`), the last 50 log entries. Everything stored is passed through a redactor that replaces every configured key and the swarm secret. |
| `/health` | 200 if the last tick is at most 5 minutes old, else 503. |

All GET (and HEAD), with `Access-Control-Allow-Origin: *`. `deployments.json` is bundled at
build time, so a new market means a new deploy. There is no KV path any more: one code path runs
on the Free and the Paid plan.

#### Deploy

From the repository root, logged in to wrangler (`wrangler whoami` shows the account):

```sh
pnpm --filter @weir/keeper test
pnpm --filter @weir/keeper exec wrangler deploy --dry-run --outdir "$(mktemp -d)"
pnpm --filter @weir/keeper exec wrangler deploy
# Prints the URL, https://weir-keeper.<your-subdomain>.workers.dev. Once the cron trigger first
# fires (up to 15 minutes after a deploy; 11 minutes on 2026-11-12) it arms the alarm and the
# object ticks with no secrets: it reads the four markets and fetches the index, and signs
# nothing. Until then /health is 503 with last_tick null. Check:
curl -s https://weir-keeper.<your-subdomain>.workers.dev/status   # config: REPORTERS and AGENTS "not set"
curl -s https://weir-keeper.<your-subdomain>.workers.dev/health   # 200 once a tick has run
# Then, and only once the Node loop is stopped (below), the secrets from keeper/.env, the agent
# list split so no value is over 5,000 bytes, piped as JSON so no value is printed or written to
# a file (stderr shows names and byte counts only):
node --env-file=keeper/.env keeper/scripts/secrets.ts | pnpm --filter @weir/keeper exec wrangler secret bulk
pnpm --filter @weir/keeper exec wrangler tail       # the tick lines, one a minute
```

`wrangler secret bulk` reads JSON from standard input when given no file (`wrangler secret bulk
--help`, wrangler 4.158.0). Cloudflare refuses a secret over 5 KB, so `scripts/secrets.ts` writes
the agents as `AGENTS_<MARKET>` (and `AGENTS_<MARKET>_2`, ... if one market is still too large),
sets `AGENTS` to null so a stale whole list cannot sit beside the parts, and does the same for
`REPORTERS` if it ever passes the limit. It refuses, with nothing on stdout, if any value is still
too large, a value is not valid JSON, or the parts do not read back as the same lists. The keeper
reads `AGENTS` and every `AGENTS_*` variable, sorted by name, as one list (`REPORTERS` likewise);
a bad part is a configuration problem naming it, and the other parts still load; the same agent
on the same market twice is named and counted once. A part left by an earlier split and not
named by a later one stays until deleted (`wrangler secret list` shows it). Setting secrets makes
a new version; the object restarts with it and its alarm is kept. To make the Worker sign nothing
again without deleting it or its store, pipe a JSON object with every secret name from `wrangler
secret list` set to null to the same `wrangler secret bulk` (a null deletes a secret).

`BUDGET` stays 40 (a variable in `wrangler.jsonc`): the Free plan allows 50 subrequests per
invocation, and whether a Durable Object alarm has the same cap is not stated.

#### Free plan arithmetic

Limits read on 2026-11-12 from developers.cloudflare.com: Workers limits (`/workers/platform/limits/`,
last updated 2026-10-29), Durable Objects pricing (`/durable-objects/platform/pricing/`, 2026-10-18),
Durable Objects limits (`/durable-objects/platform/limits/`, 2026-11-07), alarms
(`/durable-objects/api/alarms/`, 2026-04-21), Cache API (`/workers/runtime-apis/cache/`, 2026-10-29).
Use per day unless said. "Model" means measured with
`node keeper/scripts/rows.ts` (`test/harness.ts`: four markets, three hours, eight agents each, the
object's SQL store on node:sqlite, lease off); "local" means the `wrangler dev` run below (no
secrets); "live" means the Node loop on testnet (above and `keeper/store/`, read 2026-11-12).

| Limit (Free) | Keeper's use | Margin |
|---|---|---|
| Worker requests: 100,000 | 1,440 cron calls, plus public reads | about 98,500 for readers |
| Durable Object requests: 100,000 (alarm invocations count on Paid; the Free column does not itemise them, counted here) | 1,440 alarms + 1,440 watchdog calls = 2,880, plus every read of `/status` and `/health`, every HEAD, and each bundle read the cache misses | about 97,000 for readers. One browser polling `/status` every 10 s uses 8,640 |
| Duration: 13,000 GB-s, billed at 128 MB per object whatever it uses | Optimistic, the object billed only while a tick runs: 18 to 43 s a tick (live wall time) x 1,440 x 0.125 GB = 3,240 to 7,740 GB-s. Pessimistic, it never hibernates: 86,400 s x 0.125 GB = 10,800 GB-s, the most one object can use | 40% to 75% left optimistic; **17% left pessimistic** |
| SQLite rows read: 5,000,000 | Model: 17.6 store reads a tick (26 at most) + 2 by the object = about 28,000 (40,000 if every tick were the busiest). Retention: about 4 x 44,000 rows scanned (15 days of bundles and orders) = 176,000. Local: 13 a tick without secrets | about 95% left |
| SQLite rows written: 100,000 | Model: 5.7 store writes a tick (17 at most) + 1 started mark + 1 `setAlarm` = about 11,100 (27,400 if every tick were the busiest). Retention deletes what a day adds: about 900 bundles and 2,100 orders. Local: 1 to 2 a tick, 6 to 16 on index ticks | 70% to 86% left |
| Stored data: 5 GB per account; per object 1 GB on Free in the limits page's FAQ, 10 GB in the same page's table | Live: bundles 7 KiB mean, 3 every 5 minutes = 5.9 MiB a day; model: orders 0.4 MiB a day; status 47 to 56 KiB. With the 15-day rule: about 95 MiB at most (value bytes; SQLite's own overhead on Cloudflare not measured). Without it 1 GB would be reached in about 160 days | about 10x under 1 GB |
| CPU per invocation: Worker 10 ms; object 30 s | Worker: one call to the object and at most two cache calls (not measured on Cloudflare). Object: the heaviest tick about 12 ms, a cold one about 35 ms (`scripts/bench.ts`, Node) | object about 800x |
| Subrequests per invocation: 50 (Workers page; the Durable Objects page lists none, only 6 connections at once) | Worker: 3 at most. Object alarm: at most `BUDGET` = 40 | 10, if an alarm is held to 50 |
| Wall time: alarm handler 15 min | 18 to 43 s live | ample |
| Size of one variable or secret: 5 KB (Workers limits, "Variable size"; the API's refusal said "limit of 5.1 kB"); 64 variables per Worker | Live: `REPORTERS` 1,721 bytes, `AGENTS` 6,488 whole, 1,578 to 1,673 per market, `SWARM_SECRET` 64, `KEEPER` 567. `scripts/secrets.ts` keeps every value at or under 5,000 bytes | 4 agent parts + 3 others + `BUDGET` = 8 of 64 variables |

**What happens at a limit.** Per the pricing page, once a free daily limit is exceeded,
operations of that kind fail until 00:00 UTC. Rows written: every `put` fails; a sealed order is
stored before it is committed, so no commit is sent that could not be revealed, and a missing
order is rebuilt from `SWARM_SECRET` anyway; reports, reveals and clears still go out, but
progress marks and `/status` stop updating. Requests or duration: the alarm stops running and no
tick runs until midnight UTC; `/health` turns 503 after 5 minutes; reveals due in that time are
forfeited (1% of their lock) and buckets go unreported. The thin margin is duration: if the
object never hibernates between ticks, 17% is left, and nothing else the keeper does adds to it,
because one object cannot be billed for more than the 86,400 s of a day. Requests have the most
room but are the one limit outsiders can spend: heavy polling of `/status` would stop the keeper
for the rest of the UTC day. Whether an object hibernates between ticks (pending timers in the
RPC client could hold it) has not been measured.

**Not confirmed in the documentation:** a subrequest cap for alarms; whether a Worker on the Free
plan may await a 40 s call to an object (not needed: the watchdog returns at once); how rows are
counted for an upsert into a `WITHOUT ROWID` table (assumed one); whether the Cache API works on
`workers.dev`; whether alarm invocations count against the Free plan's 100,000 requests (assumed
they do).

#### Tested locally, 2026-11-12

**Careful:** `wrangler dev` run in `keeper/` loads `keeper/.env` as local secrets when there is no
`.dev.vars`, and the keeper would then sign with the real keys. Run it as below, from a copy of
the configuration outside `keeper/`:

```sh
D=$(mktemp -d)
sed -e "s#\"main\": \"src/worker.ts\"#\"main\": \"$PWD/keeper/src/worker.ts\"#" -e '/\$schema/d' keeper/wrangler.jsonc > "$D/wrangler.jsonc"
(cd "$D" && env -u REPORTERS -u AGENTS -u SWARM_SECRET -u KEEPER CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
  "$OLDPWD/keeper/node_modules/.bin/wrangler" dev --local --port 8799 --persist-to "$D/state" \
  --test-scheduled)
curl -s 'http://127.0.0.1:8799/__scheduled?cron=*+*+*+*+*'   # from a second shell: the watchdog, once
```

`wrangler dev --local` (wrangler 4.158.0, workerd) run that way (and with `--env-file` an empty
file, which turned out not to matter: in `wrangler dev` that flag did not bind its values at all;
a later run with a fake part in a `.dev.vars` in the temporary directory did), so no
secret was loaded (the bindings table listed `KEEPER_OBJECT` and `BUDGET` only), port 8799, from
18:26 to 18:31 UTC, against the four testnet markets (read-only). One `GET /__scheduled` (the
watchdog) armed the alarm; every tick after that came from the alarm, including after a code
reload at 18:29. The log:

```
[wrangler:info] GET /status 200 OK (14ms)
[wrangler:info] GET /health 503 Service Unavailable (3ms)
[wrangler:info] GET /__scheduled 200 OK (3ms)
[wrangler:info] POST /_internal/ensure 405 Method Not Allowed (3ms)
tick 2026-11-12T18:27:00.000Z: 35/40 requests, 3 done, 0 failed, 0 transactions, 4.2 s, 6 rows read, 16 rows written
tick 2026-11-12T18:28:00.000Z: 5/40 requests, 0 done, 0 failed, 0 transactions, 0.5 s, 13 rows read, 2 rows written
tick 2026-11-12T18:29:00.000Z: 4/40 requests, 0 done, 0 failed, 0 transactions, 0.4 s, 13 rows read, 1 rows written
⎔ Reloading local server...
tick 2026-11-12T18:30:00.000Z: 12/40 requests, 3 done, 0 failed, 0 transactions, 3.0 s, 14 rows read, 6 rows written
  - keeper/config skipped: REPORTERS is not set: no price is reported
  - keeper/config skipped: AGENTS is not set: no agent trades
tick 2026-11-12T18:31:00.000Z: 5/40 requests, 0 done, 0 failed, 0 transactions, 0.5 s, 13 rows read, 2 rows written
```

The three "done" are the index fetches (h100 2,845,000 micro-USD at 18:27, every chip formed an
index). The first ticks show `config: []` because the code then did not list unset secrets; the
reload brought the change that does. At 18:31, `/status` answered `config` with the two lines
above and `age_secs` 1; `/health` 200 `{"ok":true,"age_secs":1}`; `/bundles/<hash>.json` 200 with
CORS, `application/json` and the immutable header, its body's sha256 equal to its name; OPTIONS
204, POST 405, `GET /_internal/ensure` 404. The ticks with no index fetch took 0.4 to 0.5 s; with
signing, the live loop's take 18 to 43 s. The rows in the log are workerd's own counts
(`cursor.rowsRead`, `rowsWritten`).

`wrangler deploy --dry-run --outdir <tmp>`: 158.46 KiB, 46.98 KiB gzipped (2026-11-12, with split secrets; the code as
left here).

#### First deploy and the first switch, 2026-11-12 (UTC)

From the operator's run of the commit f424649 at https://weir-keeper.qvkare.workers.dev; sizes
measured from `keeper/.env` as lengths only.

| What | When | Result |
|---|---|---|
| `wrangler deploy`, no secrets | 18:38 | Deployed. No tick for about ten minutes: `/health` 503 with `last_tick: null` until the cron trigger first fired. Cron changes "may take several minutes (up to 15 minutes) to propagate" (`/workers/configuration/cron-triggers/`, read 2026-11-12) |
| First tick, from the cron's arming of the alarm | 18:49:00 | 34/40 requests, 3 done, 0 failed, 1.8 s, 6 rows read, 16 written: the index for all three chips fetched from Cloudflare |
| Ticks 18:49 to 18:55 | 7 ticks | All 0 failed. Idle ticks 0.2 s, 13 rows read, 1 to 2 written; index ticks 0.8 to 0.9 s, 14 read, 6 written. `/status`, `/health`, `/latest.json` answered |
| Node loop stopped | 19:00:21 | After its 19:00 tick |
| `wrangler secret bulk` with the four secrets as JSON on stdin | 19:00:26 | **Refused** by the API: "Text binding 'AGENTS' is too large, its size of 6.5 kB exceeds the limit of 5.1 kB. [code: 10054]". Nothing was set (`wrangler secret list` printed `[]`). `AGENTS` was 6,488 bytes; `REPORTERS` 1,721, `SWARM_SECRET` 64, `KEEPER` 567 |
| Node loop started again | about 19:01 | The loop is the keeper again; the Worker holds no keys and signs nothing |

Cost of the failed switch: about a minute with no keeper (19:00:21 to about 19:01:30), outside
any reveal phase that ends then (the weekly reveals ended at 19:00 and the loop's 19:00 tick ran).
Not checked on chain.

What was done: the keeper now reads the agent list from `AGENTS` and every `AGENTS_*` secret
(and `REPORTERS` from `REPORTERS_*` likewise), and `scripts/secrets.ts` writes the secrets for
`wrangler secret bulk` with no value over 5,000 bytes (the deploy command above). Tested in
`test/secrets.test.ts`: parts read in name order, a bad part named while the others load, a
duplicate agent across parts named and counted once, the redactor covering keys from every part
(also from entries dropped), the object reading parts from its whole environment on the model
(every market's agents committed), and the script on fake keys sized like the real list: four
parts of at most 5,000 bytes, `AGENTS` null, the same agents read back, nothing but names and
sizes on stderr, and a refusal with nothing on stdout. In `wrangler dev --local` at 19:05 to
19:06 a fake part (`AGENTS_H100_FAST`, one agent with a malformed key, in a `.dev.vars` in a
temporary directory) was read from the runtime's `env`: `/status` listed that agent's key as
unusable and no longer said `AGENTS is not set`, and the fake key appeared nowhere in `/status`.
The switch has not been retried yet.

#### Moving from the Node loop to the Worker

Two keepers must never run at once: each would commit for the same agents, with no lease
between them. The stores are separate, so:
- **Sealed orders**: an order the loop committed and did not reveal is not in the object's store.
  At reveal the swarm rebuilds it from the commit, as long as `SWARM_SECRET` is the same: the salt is
  HMAC(`SWARM_SECRET`, series, round, agent, n) and the lock fixes size and price (`rebuildOrder` in
  `agents/src/swarm.ts`; `test/durable.test.ts`, "moving stores", revealed every such order on the
  model with nothing forfeited). Only if that failed would those orders forfeit 1% of their lock.
- **Bundles** the loop stored are not in the object: `/bundles/<hash>.json` on the Worker answers
  404 for prints reported before the switch. Keep `keeper/store/` (or publish its `bundles%2F*`
  files elsewhere) until those prints are pruned.
- **Marks and costs** start again: the cost figures count from the Worker's first tick, and buckets
  the loop reported but had not pruned are not pruned by the Worker (they stay in the contract's
  storage).

When: rounds of both kinds end on the hour (hourly market: 3 min commit, 2 min reveal, every 5
minutes; weekly: 45 min commit, 15 min reveal). Stop the loop just after its tick for minute :00
has printed its line (about :00:20 to :00:45): the weekly rounds that ended at :00 are revealed,
no weekly market has its turn at :00 (they act at minutes 1, 2 and 3 mod 5), and the hourly
round that opened at :00 usually gets no order in its first minute (the first night's log). Then
run the `wrangler secret bulk` line; the Worker's tick at :01 is the first to sign.

1. Deploy as above, without secrets, a few minutes before the hour; check `/status` and `/health`.
2. After the loop's :00 tick line, stop the loop (its process id is in `keeper/store/loop.pid`).
   Check that `keeper/store/loop.log` gets no tick line after that.
3. Set the secrets (above). `wrangler tail` should show a tick at :01 with transactions.
4. At :05, after the hourly round of :00 is cleared, and again after :00 of the next hour for the
   weekly rounds: `/status` should show no failed entry; any reveal of a loop's order says
   `(rebuilt: not in store)`; the `costs` line says `lost $0.00 in forfeits`; `get_totals().burned`
   grew by the commit fees only.

A one-off carry-over of bundles, marks and costs (not built): a script that reads those keys from
`keeper/store/` into a JSON file (sealed orders left out: their salts are secret until revealed,
and they are rebuilt anyway), and a write route in the object accepted only with a fifth secret,
an import token compared in constant time, taking only `bundles/` (each checked: its sha256 must
equal its name), `marks/` and `costs/` keys, before the first signed tick. Removing the token
afterwards closes it. About 80 lines and a test; not done because nothing is lost without it but
the old bundles' URL and the prune list.

### Option 2: Node loop

```sh
cp keeper/.env.example keeper/.env        # fill in; keeper/.env is ignored by git
node --env-file=keeper/.env keeper/src/node.ts --once
node --env-file=keeper/.env keeper/src/node.ts --loop --port 8787
```

Same `runTick`, same routes on `--port`, the store in `keeper/store/` (one file per key,
`--store` to change it), `--deployments` and `--budget` to override. The loop ticks at the start
of every minute, one tick at a time; a tick that runs past the next minute skips the minutes it
overlaps, and a machine that slept through the wait runs the minute it wakes in, not the one it
waited for. Each tick prints one summary line (requests, entries, transactions, seconds taken) and
every entry that is not "done".

## Secrets

JSON or plain strings in environment variables (Worker secrets or `.env`). They never appear
in `deployments.json`, the log or the routes.

```jsonc
// REPORTERS: accounts in the contracts' `reporters`; one key per market contract.
[{ "account_id": "reporter-a.example.testnet",
   "keys": { "weir-h100-fast.example.testnet": "ed25519:<key>", "weir-h200-weekly.example.testnet": "ed25519:<key>" } }]

// AGENTS: one entry per agent and market, as the deploy tool writes them. Also read from every
// AGENTS_* variable (sorted by name), as scripts/secrets.ts splits it for Cloudflare's 5 KB limit;
// REPORTERS likewise from REPORTERS_*. The Node loop reads AGENTS and REPORTERS only.
// role is buyer | seller | maker | noise. Optional, with defaults:
//   buyer:  need 40, premium_bps 500         seller: capacity 180, premium_bps 500
//   maker:  spread_bps 600, share_bps 1000, max_size 40
//   noise:  view_bps 1000, min_size 3, max_size 10
// `market` names its market; `markets: [...]` (several) or neither (every market) also work,
// given a key for each contract.
[{ "account_id": "buyer-1.example.testnet", "market": "h100-fast", "role": "buyer",
   "keys": { "weir-h100-fast.example.testnet": "ed25519:<key>" } }]

// SWARM_SECRET: any long random string. Salts of sealed orders derive from it.

// KEEPER (optional): the housekeeping account, one key per market contract.
{ "account_id": "keeper.example.testnet", "keys": { "weir-h100-fast.example.testnet": "ed25519:<key>" } }

// Any signer may give "secret_key": "ed25519:<key>" instead of (or besides) "keys": used on
// every contract not in "keys". Right for a full-access key only.
```

Agents must already be registered on each market's contract and funded; the keeper does
neither.

## Cost per tick

`node keeper/scripts/bench.ts` runs an hour of the four markets on `ModelWeir` with the index
package's saved responses for all three chips (8 bodies, 443 KiB), then times the pieces a
real tick runs on its own CPU. On this machine (Node 22.23, Apple silicon):

| | CPU |
|---|---|
| Median model tick (keeper, swarm and the engine executing every call) | 1.1 ms |
| Median model tick with an index fetch (three bundles, reports on four markets) | 11.5 ms |
| Busiest model tick | about 20 ms |
| Parse the 8 bodies for 3 chips (`makeBundle` per chip), warm | 2.9 ms |
| Hash the bodies and 3 bundles, warm | 0.7 ms |
| Sign one transaction (borsh, sha256, ed25519), warm | 0.23 ms |
| First tick in a fresh process (JIT, first index fetch) | about 35 ms |
| First parse and hash, cold | about 15 ms |
| First key derivation (`@noble/ed25519` tables) | about 13 ms |

Estimated keeper CPU for a tick on chain, warm: about 1 ms for a tick with 5 transactions,
about 7 ms for an index tick with 16. A cold isolate adds tens of milliseconds.

**What the swarm burns.** At the ten-cent commit fee, the default swarm of eight agents
(sized like the agents package's simulation: weekly needs and capacities 8.4 times the fast
ones, deposits scaled with the chip's price) burned, in test dollars, measured over 24 hours on
the model:

| Market | Burned per day |
|---|---|
| `h100-fast` | $141 (about 1,400 commits) |
| `h100-weekly` | $15 |
| `h200-weekly` | $18 |

All of it was commit fees: there were no forfeits. In every run the keeper's cost report
(fees plus forfeits) equalled the contract's `burned`.

**Store writes: 8.0 per tick, about 11,600 a day** with the lease (status and log, lease,
sealed orders, progress marks, the cost record, and every five minutes three bundles, the latest
map and the attempt); 5.7 a tick without it, as in the Durable Object (`node
keeper/scripts/rows.ts`).

**Recommendation: Option 1, the Worker with its Durable Object, on the Free plan.** The KV
Worker did not fit the Free plan (10 ms of CPU against about 12 ms for an index tick, and 1,000
KV writes a day against about 11,600). In the Durable Object the tick runs under a 30 s CPU limit
and the store's writes are SQLite rows, 100,000 a day; the table under Option 1 gives the
margins, the thinnest being duration (17% if the object never hibernates). Nothing of this has
run on a Cloudflare account yet. The Node loop stays the fallback, on a machine that does not
sleep.

## Tests

```sh
pnpm --filter @weir/keeper test        # node --test, offline, 38 tests
pnpm --filter @weir/keeper typecheck   # tsc --noEmit
pnpm --filter @weir/keeper bench
pnpm --filter @weir/keeper rows        # store reads and writes per tick, for the Free plan table
```

All on `ModelWeir` with an in-memory store, a fake clock and a fake fetch serving the index
fixtures for every chip (`test/harness.ts`: the four `MARKETS`, three reporters, eight agents
on each sized for its market as the agents package sizes them, the housekeeping account):

- `run.test.ts`:
  - **Three hours, four markets:** every bucket printed (fast buckets two hours old pruned),
    every round with commits cleared, every commit revealed, zero forfeits, fast series 0 and 1
    settled and redeemed, series 0's results pruned, `get_totals` adds up to the deposits on
    every market, the agents' fees plus forfeits equal the market's `burned`, never over 40
    requests, nothing failed.
  - **Missed minutes:** each forfeit logged with its amount and counted in `/status`; later
    rounds trade normally.
  - **Sources failing:** every chip without an index, one fetch per window, every market's log
    saying why, then recovery.
  - **A chip without a bundle:** only its market goes without a report, and says so.
  - **A reporter missing:** with two agreeing, the bucket stays open, then `finalize_print`
    gives the print after the window. With two 5% apart, there is no print, the log gives the
    500 bps against `max_spread_bps` 200, and there is no last print.
  - **The fairness rule** (as above). An order below 50 commit fees is now placed with a
    probability, so participation is checked with bounds: every fast round had commits, at
    least four agents a round on average, and at least half the agents in each weekly round 0.
  - **A budget of 10:** never an 11th request, requests in priority order, everything printed,
    settled and redeemed, the one reveal that cannot fit logged as a forfeit.
  - **No housekeeping account:** pruning off and said so.
  - **Two overlapping runs:** with the lease, one works and one stands aside, with the same
    events as a single run. Without the lease, the only failures are the contract's refusals of
    the second copies.
- `worker.test.ts`: the routes through the Worker and the object (status codes, CORS, cache
  headers, `?chip=` for each chip, 404 for an unknown chip or hash, `/health` against the
  object's clock), the object's alarm (over the test's own four markets, never the repository's
  `deployments.json`) with bad keys and the network down, no secret anywhere in `/status`,
  `/latest.json`, `/health` or the store (recognisable fake keys, including the housekeeping
  account's, plus malformed JSON in a secret), `config` listing the malformed secret while it
  holds and not after, a problem kept in `config` through ticks that push it out of the last 50
  log entries, unset secrets listed in `config` with nothing signed, and `src/` free of Node
  imports except `node.ts`.
- `durable.test.ts`, with fakes for the object's storage (`test/fakes.ts`: SQL on node:sqlite,
  one alarm, a namespace binding, `caches.default`): an alarm arms the next minute and then runs
  the minute it woke in (and one firing up to 1 s early counts as its minute); a call while a tick
  runs starts no second tick and the minute it overlapped is skipped; a tick that throws leaves the
  next minute armed, and a failed `setAlarm` is mended by the watchdog; a late wake runs the current
  minute once and a repeated delivery does not run it again; the cron watchdog arms a missing alarm
  and leaves an armed one alone, its path never reaches the object from outside, and only the name
  `keeper` is used; real ticks on the model through the alarm, with no lease written, read back
  through the Worker's routes; a bundle read three times costs one object request with the cache,
  a 404 is not cached, `/status` always reaches the object; retention (15 days, every 6 hours,
  each chip's latest bundle kept, other keys untouched); sealed orders committed through one store
  revealed through a fresh one, nothing forfeited.
- `secrets.test.ts`: `AGENTS_*` and `REPORTERS_*` parts (order, a bad part, a duplicate across
  parts, the redactor over every part), the object reading parts from its environment on the
  model, and `scripts/secrets.ts` (split under 5,000 bytes, `AGENTS` null, read back the same,
  stderr without values, refusal with empty stdout).
- `rpc.test.ts`: a 429 seen through one market's port spares the other markets' ports in the
  same tick and the next while the cooldown lasts, the first endpoint is used again once it ends,
  every attempt is charged and nothing else; with every endpoint refusing, the next call fails
  without a request or a charge; two `nearChain`s in one process share the cooldowns; the tick
  logs the cooldowns it starts with and `/status` shows them.
- `keys.test.ts`: per-contract function-call keys, enforced by the model transport the way a
  node does (one receiver, a method list), on two markets:
  - with keys for both, reports, clears, settles and prunes on both, nothing refused, no key in
    the store;
  - with the housekeeping key missing for one market, that market's agents clear and settle,
    and pruning is skipped with one log line a tick;
  - with a key naming the wrong contract, one `ReceiverMismatch`, one log line with the fix, no
    retry for an hour (so two in the two hours), and an agent does the clearing.
- `node.test.ts`: the directory store under real ticks, and the loop's choice of the next minute.

## Not built

- **Independent or staggered reporters.** All reporters report from one fetch by one operator
  in the same minute.
- **Raw source bodies are not published.** Bundles carry each body's sha256 and the parsed
  offers, so anyone can recompute an index, but not check the hashes against the bodies.
- **A retry within the five-minute window** when the index fetch fails, and any source retry.
- **Registration, funding, guards, round lock limits and withdrawals** of agents.
- **A guard between the Node loop and the Worker.** Their stores are separate; nothing but the
  operator keeps both from running at once (Option 1, "Moving from the Node loop").
- **A carry-over of the loop's bundles, marks and costs** to the object (described under
  Option 1; sealed orders need none).
- **Alerts.** `/health` returns 503 when stale, but nothing pages anyone.
- **Cost figures for rounds cleared by someone else** (only the market-wide burned total has
  them), and for anything before the keeper's first tick.
- **Agents added later** are not redeemed on series the keeper has already marked done.

## What the other packages lack (worked around, not patched)

- `@weir/agents`: `tick` cannot be told to do only some of its work (only reveals, only clears)
  or to skip series. The keeper runs it several times per tick with ports that defer the state
  changes a step may not make, and drops those entries from the log; repeated reads are served
  from the per-tick cache. `tick` does not report what a cleared round cost, so the keeper reads
  it from the book its port saw.

## First night on testnet, 2026-11-12

The Node loop ran against the four markets of `deployments.json` (24 agents, 6 per market,
`evidence/deploy/testnet-w1.json`; three reporters; the housekeeping account) with the default
budget of 40, from a `--once` run at 00:47:20 UTC and the loop from 00:48:10. The figures below
are from the loop's output (`keeper/store/loop.log`, not committed; 30 ticks, 00:48 to 01:18
UTC), from `/status` at 01:10 and 01:18, and from 17 view calls (`get_results`, `get_print`,
`get_totals`, `get_series`) through `near-testnet.drpc.org` at about 01:20. The process ran the
chain client from before commit 9507b3c and none of the keeper changes listed under "What was
done".

| What | Count, when (UTC) | Cost on chain | Whose |
|---|---|---|---|
| Transactions logged `RPC error: null` while a second tool used the same fastnear endpoint and it answered 429 | 12 in 5 ticks: a commit at 00:52 and at 00:57, 5 reveals at 00:59 (4 commits, one tried twice), 4 reports at 01:00 (3 on `h100-fast`, 1 on `h100-weekly`), 1 report at 01:01 (`h100-weekly`); 24 failed log entries in all, each failure being logged by its step and as a transaction | None found. Every one that could be checked had landed: rounds 11 of series 0 and 0 of series 1 of `h100-fast` hold 7 commits each (6 logged done, 1 logged failed), series 1 round 0 forfeited 0, and the 01:00 prints of `h100-fast` and `h100-weekly` hold all three reports | Chain client (fixed in 9507b3c). That the bodies came after delivery is the authors' inference; the log kept only "null" |
| What the failures cost the keeper | The 4 failed reports at 01:00 used the rest of that tick (40 of 40): `h200-weekly` and `a100-80-weekly` reported at 01:01, the clear of series 1 round 0 waited until 01:01:29 (89 s after the round), and `h100-fast` placed no orders at 01:00 or 01:01, so series 1 round 1 got 5 orders from one tick (01:02) | Fewer orders in one round | Keeper, through the client |
| Recovery | 0 failed entries from 01:02 to 01:18 (17 ticks). The 01:01 tick logged no report on `h100-fast`: the chain already held the three "failed" reports for the 01:00 bucket | Every `h100-fast` bucket 00:50 to 01:10 and the 01:00 bucket of the three weekly markets final with 3 reports; the four rounds cleared up to 01:11 each traded (prices 394000, then 415000 three times) with 0 forfeited; `get_totals().burned` $2.40 = 24 commit fees of $0.10, equal to the keeper's own count | Expected |
| Request budget spent | 40 of 40 in 4 ticks, 37 or more in 10 of 30 (mean 27.6, median 25). Commits not started for want of budget: `h100-fast` 5 times, `h100-weekly` 4 of its 5 turns (it committed once, 5 orders at 01:11), `h200-weekly` 2 (it committed 6 at 01:07); `a100-80-weekly` committed 6 at 01:03 | `h100-fast` rounds got 7, 7, 5, 5, 4 and 5 orders from 6 agents (the maker places two) | Configuration: 40 is the Worker's limit, not the Node loop's |
| The first tick of each phase sees the previous one | The chain's final block was about 3 s behind the tick (`chain_now` 1794445797 at the 1794445800 tick). No `h100-fast` orders at 01:05, 01:10 or 01:15, the minute each commit phase opened; no reveals at 00:58, the minute the reveal phase opened | None seen. Each 120 s reveal phase gets one ordinary tick and one urgent tick about 3 s before the phase ends; a reveal sent then could land too late and be forfeited (not seen) | Expected from ticking on the minute; see below |
| One minute run twice | Two ticks labelled 01:08 and none for 01:09: the loop's timer fired just before 01:09:00 and the loop took the minute from the clock after the wait | None: every decision is read from chain state. The 01:09 tick ran 01:08's turns again (`a100-80-weekly` took a second turn); no market lost one, since only `h100-fast` acts at minute 9 | Keeper (fixed) |
| One minute not run | No 00:51 tick: the 00:50 tick (40 requests, 6 transactions) ran past 00:51:00, which the loop skips | None seen | Expected; how long ticks take was not logged then (it is now) |
| Orders trimmed by `max_round_lock` | 3 entries, all for series 0 round 11 (00:50 twice, 00:52): a buyer from $18.88 to $14.63 against $15, a seller from $69.30 to $49.89 and from $57.60 to $49.92 against $50. None in the 28 ticks after | None: the orders were placed, smaller | Expected: the limits the deploy tool set (25% of the working balance, at least $10) acting on the first orders; not every round |
| Settle, redeem, prune not reached | Never in 30 ticks; "settle and redeem" and "pruning" left undone in 3 budget-short ticks | None by 01:18: nothing was due. `h100-fast` series 0 is delivered 01:00 to 02:00 and can be settled from 02:01; the first `prune_print` is due two hours after its bucket (from about 02:45); the weekly series 0 is delivered 16 to 23 November. For what happened when they became due, see below | Expected until 01:18 |

**After 01:21 the laptop slept.** The loop ran on a laptop under `caffeinate -i`, which
prevents idle sleep only, not sleep with the lid closed or on battery. `pmset -g log` showed
"Maintenance Sleep ... Using Batt (Charge:46%)" with short DarkWakes (read by the operator at
06:46). From 01:21 to 07:25 the log has 6 ticks: 02:28, 03:04, 03:19, 05:24, 06:46 and 07:25, after
gaps of 67, 36, 15, 125, 82 and 39 minutes (ticks resumed at 07:34 and 07:35, not read here). A tick could also stop in the middle when
the machine slept again: the 02:28 tick held its lease until 03:04:53 (the 03:04 tick found it
held and did nothing) and its clears landed at 02:46:53 and 03:03:56. What that did, from the log
and 21 more view calls through dRPC at about 07:35 UTC:

| What | Count, when (UTC) | Cost on chain | Whose |
|---|---|---|---|
| Hourly prints missed | `h100-fast` buckets from 01:25 on mostly unreported: series 0 (delivered 01:00 to 02:00) has 5 prints, series 1 (02:00 to 03:00) 0, series 4 (05:00 to 06:00) 1 (`get_accumulator`); `min_prints` is 9 | Series 0 (91 open sets) and series 1 (115) cannot settle on an index: each will settle void when someone calls `settle`, allowed from 02:30 and 03:30. Neither is settled yet: no tick since had budget left for it. Series 2, 3, 5 and 6 never opened (no trade) | Host |
| Reports sent too late | 6 transactions refused `outside the report window of this bucket`: 3 at the 03:19 tick (bucket 03:15) and 3 at 06:46 (bucket 06:45). They carry transaction hashes, so they reached the chain and burned gas | Gas only | Host (the tick stalled past the bucket's 6-minute window). The keeper could check the chain's time before reporting; not changed |
| Orders never revealed | `h100-fast` series 1 round 5: 3 commits at 01:21, reveal phase 01:23 to 01:25 slept through; cleared at 02:46:53 with no trade. `a100-80-weekly` round 74: 6 commits at 01:03, reveal phase 01:45 to 02:00 slept through; cleared at 03:03:56 with no trade. Round 74 of `h100-weekly` (5 commits) and `h200-weekly` (6) is not cleared yet; its commits were not revealed either (no tick in 01:45 to 02:00) | Forfeited $0.17 on `h100-fast` (1% of $16.67 locked) and $1.31 on `a100-80-weekly`; `h100-weekly` and `h200-weekly` will lose 1% of their locks when cleared. `h100-fast` `burned` $3.77 = $3.60 in fees and $0.17 in forfeits | Host |
| Index fetch at 02:28 | No chip formed an index (2 or 3 providers of 6 needed): vast, lium and shadeform timed out after 15 s | No report from that fetch | Host, probably (network after wake; not shown) |
| Every tick since 01:21 at 40 of 40 | Reports, then clears; commits, settle and prune not started in most of them | No new orders since 01:21 on `h100-fast` | Host and budget |

A keeper on a laptop is not a host. The first night showed the keeper's own logic recovering
from what it met while the machine was awake (the RPC refusals, a missed minute), and the
markets left without prints, reveals or clears while it slept. An always-on host (the Cloudflare
Worker on the paid plan, or any machine that does not sleep) has not been set up. (Later on
2026-11-12: the Worker was rebuilt on a Durable Object to fit the Free plan, Option 1; not
deployed yet.)

**What was done.**
- `chain/`: provider refusals are now endpoint failures with their own text, retried on the
  next endpoint (9507b3c; chain/README.md, "RPC endpoints").
- Keeper: the cooldowns are shared by every connection of the process or isolate (above); the
  loop names the minute it waits for before waiting (and runs the minute it wakes in when it
  wakes a minute or more late), and prints how long each tick took;
  configuration problems are listed in `/status` for as long as they hold.
- Not changed, decisions left to the operator:
  - **The Node loop's budget.** The loop is not bound by the Workers plan's 50 subrequests.
    `--budget 80` gives 40 more requests in each tick that ran out; whether that would have
    started every commit step skipped that night is not measured. The price is up to 80
    requests a minute on free RPC endpoints, the kind that rate-limited that night.
    Recommended: 80 for the Node loop, watched through `rpc_cooling` and the tick log.
  - **When in the minute to tick.** Ticking a few seconds after the minute would make the first
    tick of each phase useful, but would lose the urgent tick just before a reveal phase ends.
    Recommended: no change until a reveal is seen landing too late.
  - **Agents' sizing against `max_round_lock`.** Trimming was seen in one round; nothing to
    change on this evidence.

## Not proven

The earlier, single-market version ran against the real contract on a local sandbox node
(`integration/RESULTS.md`: 78 ticks, every print final, zero forfeits, settled and redeemed).
A later sandbox run of the 0.4 version on two markets found the one-key-per-contract bug fixed
here. Since 2026-11-12 the Node loop runs on testnet against four markets (above): reports,
finalized prints, commits, reveals and clears through function-call keys, 30 ticks at most 40
requests each. Not proven:
- settle, redeem and prune on testnet (none was due in the first night), and refusal texts
  from the 0.4 contract matching the engine's `ERR` there;
- the keeper changes of 2026-11-12 (shared cooldowns, the loop's minute, `config`) on testnet:
  they are tested on the model and a fake RPC only;
- request counts under failover and `send_tx` polling with the new chain client;
- a tick that signs on Cloudflare: the Worker and its Durable Object ran on the operator's
  account without secrets from 18:49 (above); the first attempt to set the secrets was refused
  for size. Not shown:
  the Worker's CPU time, the object's duration and whether it hibernates between ticks, rows
  read and written as billed, subrequest limits for an alarm, the alarm's and the cron
  trigger's timing, the Cache API on `workers.dev`, and a tick that signs;
- live source responses beyond the saved ones.
