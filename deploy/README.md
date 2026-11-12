# @weir/deploy

One command that takes the built contracts to NEAR testnet and leaves running markets with
reporters and trading agents ready for the keeper. Built and proven on a local near-sandbox
node, then run once against testnet by its author on 2026-11-12: suffix `w1`, four markets, 34
accounts, 211 transactions from 00:25:11 to 00:46:04 UTC, recorded in `deploy/out/testnet/record.json`
and read back by `verify` (see the last section, which also keeps what went wrong).

```sh
contracts/build.sh                                                     # the wasm it deploys
node deploy/src/cli.ts plan   --network testnet --suffix <s>           # offline: what it would do
node deploy/src/cli.ts apply  --network testnet --suffix <s>           # do it (resumable)
node deploy/src/cli.ts status --network testnet                        # read the chain, compare
node deploy/src/cli.ts seal   --network testnet --markets h100-fast --confirm weir-h100-fast-<s>.testnet
node deploy/src/cli.ts topup  --network testnet --days 14 [--dry-run]  # keep it funded (below)
node deploy/src/cli.ts verify evidence/deploy/<record>.json [--txs]    # no keys: a record against the chain (below)
```

Options: `--markets h100-fast,h100-weekly,h200-weekly,a100-80-weekly` (default: those in the
state file, else all four), `--out <dir>` (default `deploy/out/<network>/`, git-ignored),
`--keys <dir>` (default `~/.near-credentials/<network>/`; refused inside the repository),
`--days <n>` (operator gas to fund, default 2), `--faucet-wait <secs>` (default 900),
`--json` (status), `--dry-run` and `--max-fund-accounts <n>` (topup, default 20; there `--days`
means days to cover, default 14). On the sandbox: `--rpc <url> --root-key <sandbox home>/validator_key.json`.
The suffix is kept in `<out>/state.json`; later runs need only `--network`.

## What it creates

With the markets of `agents/src/presets.ts`, whose parameters are read from `MARKETS` at run time
(`plan` prints all of it, for the actual names, with every transaction in order and what it
attaches):

| Account | Created by | What it is | NEAR |
|---|---|---|---|
| `weir-<market>-<s>.testnet` | faucet | the market contract, deployed and initialised with `new(params)` in one transaction | the faucet grant (10 NEAR assumed, read by `apply`); weir.wasm is about 304 kB = 3.04 NEAR of storage (`plan` prints the exact size of the local build), plus 0.105 NEAR of attached gas to deploy; the remaining ~6.86 NEAR pays for the state it accumulates |
| `weir-usdc-<s>.testnet` | faucet | the test dollar `tUSDC` (`mock_usdc.wasm`, open `mint`). **Real USDC is out of scope.** | grant; 146,689 B = 1.47 NEAR of storage |
| `weir-ops-<s>.testnet` | faucet | parent of every operator; pays their NEAR, their token storage and their registrations | grant; pays 9.80 NEAR for the four markets (6.84 for the two H100 ones) |
| `reporter-{a,b,c}.weir-ops-<s>.testnet` | ops | three reporters for every market, each with one function-call key per market contract | 0.240 each for the four markets |
| `<market>-{buyer-1,buyer-2,seller-1,seller-2,maker-1,noise-1}.weir-ops-<s>.testnet` | ops | six agents (two buyers, two sellers, a maker, a noise trader), sized by the agents package's rule: test dollars = working balance + `--days` of commit fees (fast H100 buyer $60 + 288 x $0.10 x 2 = $117.60; weekly working balances x8.4 and x the chip's price) | fast 0.568 to 0.967, weekly 0.190 to 0.223 |
| `keeper.weir-ops-<s>.testnet` | ops | the keeper's housekeeping account (clear, settle, finalize, prune), one function-call key per market contract | 0.880 for the four markets |

Then, in this order: token storage for every market contract and operator (0.00125 NEAR each,
paid by ops); test dollars minted to every agent; every agent and the keeper registered on
its markets (0.02 NEAR each, paid by ops); each agent deposits into its market
(`ft_transfer_call`) and sets its guard and round lock limit (`set_guard`, 1 yoctoNEAR); every
reporter, agent and the keeper adds its function-call keys, one per contract it acts on. Four
markets: 34 accounts, 211 transactions; the two H100 markets: 20 accounts, 111 transactions.

**t0.** The delivery start whose auction window contains the deployment time: the first top of
the hour (fast) or Monday 00:00 UTC (weekly) strictly after `now + cutoff_secs`. With
`lead_secs = period_secs + cutoff_secs` exactly one such time puts `now` inside series 0's
auction window, so trading can start as soon as the index has a print. `apply` computes it from
the chain's clock when it sends each deploy; `plan` shows the reasoning for the current time.

**Agents' test dollars.** The agents package sizes its simulated agents by one rule
(`agents/src/sim.ts`, `makeAgents`; not exported, so `src/layout.ts` applies the same rule to
`MARKETS`, read at run time): needs, capacities and the maker's size are the fast market's
figures x8.4 on a weekly market; working balances (buyer $60, seller $200, maker $400, noise $30)
x8.4 on a weekly market and x the chip's start price over the H100's. Each agent's deposit is that
working balance plus `--days` of commit fees, at most one commit per order per round (a maker
places two) at the preset's `commit_fee`: on the fast market 288 rounds x $0.10 = $28.80 a day
per agent ($57.60 the maker), $201.60 for the six; on a weekly market 24 rounds, $2.40 a day.
`plan` prints each agent's arithmetic; `topup` mints and deposits more when it runs low.

**Guard and round lock limit** (`set_guard`, full-access key, so the agents' function-call
keys cannot change them): guard = 20% of the band the market opens with at the chip's start
price, i.e. 6% of the index ($0.174 on H100, $0.255 on H200, $0.093 on A100 80 GB), well beyond
every strategy's reach (at most 6% of the band from fair value); `max_round_lock` = 25% of the
working balance, at least $10 (fast: $15, $15, $50, $50, $100, $10; weekly H100: $126 to $840).
A hijacked agent key can then lose at most 1% (`forfeit_bps`) of that per round plus $0.10 per
commit, at prices within the guard.

### NEAR, gas and allowances

Prices the budget rests on, read on 2026-11-12 from `EXPERIMENTAL_protocol_config` on the sandbox
and (one read-only query) on testnet, both protocol 88: gas price 1e8 yocto/gas (0.0001 NEAR per
Tgas burnt); **attached gas is bought at `min_gas_purchase_price` = 1e9 yocto/gas** (a signer,
and a function-call key's allowance, must hold attached gas x 1e9 at submission, plus the
transaction's own fees, budgeted as 5 Tgas: 0.155 NEAR for a 150 Tgas `clear`, 0.105 NEAR for a
100 Tgas deposit; the unburnt part comes back);
`account_creation_charge` = 0.007 NEAR per account created; storage 1 NEAR per 100 kB.
`apply` reads them first and stops before sending anything if the network asks more.

Gas per call is the worst figure measured on the sandbox (`BURNT_GGAS` in `src/budget.ts`, from
`integration/RESULTS.md` and `contracts/README.md`): report 2.73, commit 3.60, reveal 3.33,
clear 4.92 at our six agents' books and 25.50 at a full 64-commit book, settle 3.20, redeem
2.52, prune 2.24 Tgas. This tool's own sandbox run measured lower (report 2.32 to 2.59, commit
2.83 to 2.93, reveal 2.46, clear of a two-order book 3.35) and showed **a key's allowance is
charged the gas burnt at the gas price** (0.00021 NEAR for a 2.32 Tgas report), not the
purchase price of what it attaches.

**Allowance per key** = a month (30 days) of calls at the worst gas, with `clear` at a full
book, x 1.25, plus the purchase price of its largest attached call and 5 Tgas of fees, rounded
up to 0.01 NEAR. For example a fast reporter: (8640 reports + 864 finalizes) x 2.73 Tgas =
25,946 Tgas = 2.5946 NEAR; x 1.25 + (10 + 5) Tgas x 1e9 = 0.015, so 3.2582, rounded to
**3.26 NEAR**. Fast agents 7.87 (maker 15.36), the keeper on the fast market 33.12; weekly
reporters 0.29, agents 0.79 (maker 1.41), the keeper 2.88. A reporter and the keeper hold one such
key per market. `plan` prints every key's arithmetic. An allowance is a cap, not money: what is
spent comes from the account's balance.

**Funding.** Each operator gets its setup gas plus `--days` of gas at the expected load (worst
measured gas, `clear` at our agents' book), plus what it must keep: the purchase price of its
largest call and any storage stake above 770 bytes (NEP-448). With the default 2 days, the four
markets cost the ops account 9.80 NEAR of a 10 NEAR grant, so a faucet grant runs the markets
for about two days; `topup` keeps them running after that. Re-running `apply` never sends more NEAR.
Before the first step ops pays for, `apply` checks its balance by the same reasoning (`opsNeed` in
`src/budget.ts`): what the remaining steps spend, plus the purchase price of the largest attached
gas, held only while that one transaction is in flight (9.78 NEAR for the default four-market plan,
of which 0.015 held). Until 2026-11-12 it summed the purchase price of every step's attached gas and
refused a 10 NEAR grant that `plan` said fits (last section).

### What each market costs a day

At the expected load (worst measured gas per call; `clear` at our six agents' book), from
`marketDailyCost` in `src/budget.ts`:

| Market | 3 reporters | 6 agents | keeper | gas a day | storage a day, unpruned |
|---|---|---|---|---|---|
| `h100-fast` (5-minute rounds and prints) | 0.260 | 1.433 | 0.286 | **1.98 NEAR** | 1.49 NEAR |
| each weekly market (hourly) | 0.022 | 0.117 | 0.023 | **0.16 NEAR** | 0.12 NEAR |

The fast market costs about twelve times a weekly one: it runs twelve times as many rounds and
prints. All four: 2.47 NEAR of gas a day, about 35 NEAR for two weeks. Storage is the
contract's own NEAR: each final print with three reports adds 516 bytes (measured), and the
keeper prunes prints two periods after their bucket, so the fast market's storage levels off
after two hours; a weekly market's grows for two weeks (about 1.7 NEAR) before pruning starts.

## Keys

Generated here with Web Crypto's CSPRNG (`crypto.getRandomValues`), written before the
transaction that uses them, never overwritten (`O_EXCL`), mode 600, directory 700:

```
~/.near-credentials/<network>/<account>.json                       full-access keys (near-cli legacy format)
~/.near-credentials/<network>/<account>/ed25519_<public key>.json  function-call keys (near-cli-rs layout, plus receiver_id)
~/.near-credentials/<network>/weir-<s>.swarm-secret                the keeper's SWARM_SECRET
```

The tool never prints a secret: every log line and error passes through a redactor that knows
each key in every encoding (base58 with and without the public half, hex, base64), and
`state.json`, `record.json` and `deployments.json` are refused if they would contain one. Tests
check this with recognisable generated keys; the sandbox run scans every CLI output and output
file for every secret it generated.

## Outputs (`--out`)

| File | |
|---|---|
| `deployments.json` | the repository root's shape; on testnet `rpc` = fastnear (`test.rpc.fastnear.com`) and dRPC (`near-testnet.drpc.org`), `explorer` = nearblocks, `bundles_base` null |
| `keeper.env` | mode 600, function-call keys only, each under the contract it is for: `REPORTERS=[{account_id, keys: {<contract>: <key>, ...}}]`, `AGENTS=[{account_id, market, role, <settings>, keys: {<contract>: <key>}}]`, `KEEPER={account_id, keys: {<contract>: <key>, ...}}`, `SWARM_SECRET`. Checked against the key files before it is written |
| `state.json` | every step with its transaction hash and when; `t0` per market with the reason; seals. No secrets |
| `record.json` | the public record to commit: tool version, wasm sha256 and code hashes, accounts and why, parameters as read from chain, public keys with allowances and arithmetic, agents' deposits and limits, every transaction hash with its purpose and explorer link |

## Re-running

`apply` reads the chain before every step and skips what is already there (an account holding
our key, code with the local hash and the expected parameters, a storage record, a registration,
a deposit, a guard, a key with the expected permission); it logs `skip` or `sent ... tx <hash>`.
After a crash, a kill, a faucet outage or a short balance, run the same command again. If a name
exists with someone else's key it stops and asks for another `--suffix`. The faucet is retried
through HTTP 429/5xx (honouring `retry-after`, then doubling to 2 minutes) for `--faucet-wait`
seconds, checking whether the account appeared meanwhile; after that `apply` exits and resumes
on the next run.

## Sealing

`seal` deletes every access key of the named market contracts (not the token, not operators),
in one transaction each, after checking the code hash against the local `weir.wasm` and the
parameters against `MARKETS`; each contract must be typed back with `--confirm <account>`.
**A sealed account can never be upgraded or recovered**: no new code, no new keys, its NEAR stays
in it for good (it pays for the contract's storage). The contract keeps working: reporters,
agents and the keeper use keys on their own accounts.

## Reading a record back: `verify`

```sh
node deploy/src/cli.ts verify evidence/deploy/testnet-w1.json              # what make verify-deploy runs
node deploy/src/cli.ts verify evidence/deploy/testnet-w1.json --txs        # also every recorded transaction hash
node deploy/src/cli.ts verify <record> --rpc <url,...> [--json]            # other endpoints; the report as JSON
```

It takes a `record.json` and nothing else: no keys, no `deploy/out/`, no state file, no Rust. It
reads from the record's network's public endpoints (testnet: fastnear, then dRPC, with failover;
a sandbox record needs `--rpc`), one read-only call at a time. A rate limit is waited out on the
same endpoint (`src/pace.ts`: `retry-after`, else 1, 2, 4 s ..., at most 30 s per call per endpoint)
before failing over, and a call no endpoint answers is tried once more after 5 s. `apply`, `status`
and `topup` use the same paced client (`rpcFor`, with up to 90 s of waiting per call). Source:
`src/verify.ts`. One line per check:

| Check | Fails when |
|---|---|
| each market contract account exists and its `code_hash` is the record's weir.wasm hash | the account is missing or runs other code |
| `get_params` on chain against the record's parameters, field by field | any field differs; the line names each one, chain value and record value |
| the reporters in the on-chain parameters against the record's `reporter` accounts | the sets differ |
| a contract the record says was sealed has no access keys | it still has keys |
| the test token's `code_hash` is the record's mock_usdc.wasm hash | missing or other code |
| every function-call key the record lists (reporters, agents, keeper): on chain, a function-call key, the record's receiver, the record's method list | any of the four; the line names the key and the difference |
| with `--txs` only: each recorded transaction hash is known to the chain and succeeded, and where the step name says who signs it (`steps.ts`, `topup.ts`, `seal.ts`) that it was signed by that account. Testnet lookups go to fastnear's archival node, then dRPC (`TESTNET_ARCHIVAL`), since a regular node forgets transactions after about five epochs | unknown, failed, or another signer |

Information lines (`--`), never failures:

- **Sealed or not**, for each market contract and the token: "sealed: no access keys", or how many
  full-access keys it still has and whether they are the ones the record lists. A contract
  account with a full-access key can have its code replaced by whoever holds that key; until
  `seal` has run, that is the deployer.
- **The local build**: if `contracts/target/near/weir/weir.wasm` exists, whether its code hash is the
  one on chain; if it does not, a line saying so.
- **What each market is doing**: `get_status` (each live series, its round and phase, at chain
  time), `get_last_print` (bucket, index in USD per GPU-hour, minutes before chain time, against
  the market's print interval; older than two intervals plus the report grace reads "no recent
  print"), and `get_totals` in tUSDC. From these a reader can tell whether the reporters and the
  keeper are running now; a quiet market is not a failed deployment.

Three outcomes, each with its own last line and exit code:

| Last line | Exit | Meaning |
|---|---|---|
| `RESULT match: all N checks against testnet agree with <file>` | 0 | every check passed |
| `RESULT DIFFERS: k of N checks found testnet different from <file>` | 1 | the chain answered and something differs (also when the chain stopped answering partway after a difference was found: the line says so) |
| `RESULT NOT CHECKED: testnet could not be reached after N checks; nothing is claimed either way` | 3 | network errors, timeouts or rate limits on every endpoint, three times |

Exit 2 is a usage error or a file that is not a record written by `apply`. `make verify-deploy`
runs `verify` on every `evidence/deploy/*.json` (`DEPLOY_RPC=<url,...>` for other endpoints):
a difference fails it, and so `make judge`; an unreachable chain prints "not checked" and does not
fail it, as `quote-dry` treats an unreachable quote service, and the judge summary then says the
record was **not** checked.

What it does not show:

- **That the reporters are honest.** It checks which accounts may report, not what they report.
  The index each print rests on is checked by `make verify-index` for the recorded bundles only.
- **That the keeper is running.** The status and last-print lines show what the chain holds at the
  moment of the run; nothing is promised about the next hour.
- **That the code on chain was built from this source**, unless the reader builds the wasm
  themselves (`contracts/build.sh`) and the local-build line shows the same hash. The build is
  `cargo near build non-reproducible-wasm`: another machine, toolchain or path may produce
  different bytes from the same source. A different local hash therefore does not show different
  source; the same hash does show the same bytes. Matching the record's hash shows only that the
  code has not changed since the record was written.
- **That the record is current.** It is a snapshot. A later `topup` that rotates a key, or a
  `seal`, changes the chain; copy the new `record.json` into `evidence/deploy/` after either, or
  `verify` reports the difference.
- **Balances, allowances, deposits and guards.** `status` checks those, with the deployer's keys
  and state file; the record holds no balance to compare against.

## Keeping it funded: `topup`

```sh
node deploy/src/cli.ts topup --network testnet --days 14 --dry-run   # what it would do; sends nothing, creates no key
node deploy/src/cli.ts topup --network testnet --days 14
```

It reads every operator's and market contract's balance and every function-call key's remaining
allowance, and works out what `--days` (default 14) more days need at the rates above:

- **Operators**: an operator holding less than `days x its daily gas + what it keeps` gets the
  difference plus a tenth of the N-day need (so a re-run straight after finds nothing short).
- **Test dollars**: an agent whose free balance on its market covers less than N days of commit
  fees plus half its working balance is brought back to working balance + N days of fees: ops
  mints to it (the test token's open `mint`; skipped if its wallet already holds them, so a
  resumed run does not mint twice), then the agent deposits with its full-access key.
- **Market contracts**: a contract whose spare balance (balance less its storage) covers less
  than N days of unpruned print storage gets the same treatment. A sealed contract can still
  receive NEAR.
- **Allowances**: NEAR cannot raise a key's allowance. A key that will not last N days is
  replaced: a new key for the same contract and methods (a month's allowance, or N days x 1.25
  if more) is saved to the credentials directory as the next generation, added on chain,
  written into `keeper.env`, and only then is the old key deleted. **Restart the keeper** after a
  rotation so it loads the new keys; until then it uses the old key, which is deleted.
- **Money**: ops pays all of it. When ops cannot, `topup` creates fresh faucet accounts
  `weir-fund-<s>-<n>.testnet` (one at a time, through the same rate-limit waiting as `apply`) and
  sweeps each into ops, leaving 0.01 NEAR so it still exists, until ops can pay. At a 10 NEAR
  grant two weeks of all four markets need about four.

Every transaction's hash is logged and kept in `state.json`. It is idempotent and resumable: each
transfer re-reads the balance first, a fund account already created is swept rather than
recreated, and a run stopped between adding a key and deleting the old one finishes the job
(rewrites `keeper.env`, then deletes) on the next run. `status` shows, for every account, days
left at the expected rate, and each key's remaining allowance with its days.

## Handing over to the keeper and the site

```sh
cp deploy/out/testnet/deployments.json deployments.json          # the site and the keeper read it
node --env-file=deploy/out/testnet/keeper.env keeper/src/node.ts --loop --port 8787
#   or, for the Worker: wrangler secret put REPORTERS (AGENTS, SWARM_SECRET, KEEPER) with the values from keeper.env
```

`keeper.env` is in the keeper's per-contract key shape (see `keeper/.env.example`). A NEAR
function-call key names exactly one contract, so every signer carries a `keys` map from contract
account to key:

- `REPORTERS`: the three reporters, shared by all markets (every market's `reporters` parameter
  names the same three), each with one key per market contract (`REPORTER_KEY_METHODS`);
- `AGENTS`: six per market, each with `market` and one key for that market's contract
  (`AGENT_KEY_METHODS`), plus its strategy settings;
- `KEEPER`: the one housekeeping account, with one key per market contract
  (`KEEPER_KEY_METHODS`); it signs `clear`, `settle`, `finalize_print` and the prunes, so prints
  and results are pruned and a contract's storage stops growing;
- `SWARM_SECRET`.

After `topup` rotates a key it rewrites `keeper.env`; restart the keeper (or re-put the Worker
secrets) so it loads the new key, because the old one is deleted. The tool's own sandbox run loads
the generated `keeper.env` and `deployments.json` into the keeper's `runTick` unchanged, before and
after a rotation.

## Tests

```sh
pnpm --filter @weir/deploy test        # offline, node:test: 46 tests
pnpm --filter @weir/deploy typecheck   # tsc --noEmit
pnpm --filter @weir/deploy run e2e     # near-sandbox 2.14.0 on 127.0.0.1:33051 (WEIR_DEPLOY_E2E_PORT), about 3 minutes
```

- `plan.test.ts`: the plan for all 15 combinations of markets on both networks (names valid and
  unique, every transaction signed by an account created earlier and touching deployed contracts
  only, step counts, key method lists, the ops account fits one grant); allowance arithmetic by
  hand; agents' sizing by the agents package's rule and the preset's commit fee; funding; storage
  bytes; formatting.
- `t0.test.ts`: t0 for "now" on, just before and just after hour and Monday boundaries, at and
  around auction close, across midnight and a year, every second of an hour; checked with the
  engine's own `auctionOpen`, `auctionClose` and `phaseAt`.
- `apply.test.ts` on a fake chain (`test/fake.ts`, NEAR's key permission rules and the two
  contracts' calls): every step once, a second apply sends nothing; killed before or after the
  1st, 2nd, 6th, 7th, 30th, middle, late and last transaction, a re-run ends in the same state with
  the same transaction count; a name held by someone else; the ops balance check; no secret in
  logs, state, record or deployments.json, every function-call key (and no full-access key) in
  keeper.env, in the per-contract shape, and a tampered keeper.env caught; key files; seal.
- `topup.test.ts`: the arithmetic (nothing short at exactly N days; an operator short by X gets
  X plus a tenth; an agent's test dollars at and below its floor; a contract's N days of unpruned
  prints, 1.49 NEAR a day fast, 0.12 weekly; a key rotated below N days' need and not at exactly
  it, to a month or N days x 1.25; the number of fund accounts; the fast market's gas about twelve
  times a weekly one's). Then, on the fake chain, with an empty ops account: an agent drained of
  NEAR, another of test dollars, a contract and an exhausted key. Fund accounts are created and
  swept, the run is killed partway and resumed, nothing is short afterwards, the new key is on
  chain and the old one gone, keeper.env holds the new one, a second run sends nothing, and no
  secret is logged.
- `verify.test.ts`: a record written by `buildRecord` after `apply` on the fake chain, read back
  through the real `NearRpc` from a fake JSON-RPC endpoint serving that chain. The matching record
  passes with every kind of line; a wrong code hash, a changed parameter (two fields, both named),
  a foreign reporter, a missing account, a missing key, a key for another receiver, a key with
  another method list (extra and missing methods named), a function-call key turned full-access,
  and a record saying "sealed" over a contract with keys each fail with a line naming the
  difference; a sealed and an unsealed contract are described and neither fails; an endpoint
  that refuses connections, and one that answers HTTP 429 without end, give "not checked"
  (exit 3), a brief 429 is waited through; `--txs` catches an unknown hash, a failed transaction
  and a wrong signer; the CLI's exit codes 0, 1, 3 and 2.
- `encode.test.ts`: `DeleteKey` (the one action this package encodes) and a 400 kB deploy, byte
  for byte against `@near-js/transactions`.
- `faucet.test.ts`: the faucet client through 429 and 503, an existing account, a refusal, a
  `false`, a long outage.
- `e2e/e2e.ts` (sandbox, through the CLI as an operator runs it): plan; apply two H100 markets
  (111 transactions, each hash logged); status asserted field by field (code hashes, keys and
  allowances, balances, storage to the byte, parameters, registrations, guards, deposits); one
  tick by hand with the generated keys (three reports make a print, a buyer and a seller commit
  and reveal, the keeper's key clears at 3 GPU-hours at $0.435, the agent key refused
  `set_guard`, `withdraw` and `register`, the keeper's weekly key refused on the fast market,
  allowance charged per call measured); apply again sends nothing; seal refused without and with
  the wrong `--confirm`, then sealed, and the sealed market still takes reports and commits; 12
  ticks of the keeper's `runTick` loaded from the generated `keeper.env` and `deployments.json`
  (index sources served from the saved fixtures), which reports, commits, reveals and clears with
  no failure; topup after draining an agent's NEAR, another's test dollars (withdrawn) and
  exhausting reporter-a's fast key (status flags them; `--dry-run` names them and creates
  nothing; topup creates fund accounts from the sandbox
  root, sweeps them, tops everyone up to 14 days, rotates the key, rewrites keeper.env; a second
  run sends nothing), then the keeper restarted on the new keeper.env reports with the rotated key;
  a fresh apply killed with SIGKILL halfway and re-run to completion; no secret in any output.

## Run against testnet

One run, by the author, on 2026-11-12: `node deploy/src/cli.ts apply --network testnet --suffix w1`,
the four markets. What `deploy/out/testnet/record.json` shows: 34 accounts, 211 transactions, each
with its hash, the first at 00:25:11 UTC and the last at 00:46:04 UTC; weir.wasm 303,753 bytes,
code hash `2JSY6cDZx8hVWUCy91w6BBUmJ49W4CZRAsT1DueHHaNw`; no market sealed. `verify` on that record
(`node deploy/src/cli.ts verify deploy/out/testnet/record.json`, 00:46 UTC, 5 s): `RESULT match: all
41 checks against testnet agree`; every market and the token not sealed, one full-access key each,
the one the record lists; no print yet on any market at that time.

What went wrong, and what was done:

- **The ops balance check refused the plan's own budget.** The first `apply` (`--days 2`, the
  default) created the six faucet accounts and deployed the token, then stopped at step 8:
  "weir-ops-w1.testnet holds 10.000 NEAR but the 112 steps it still has to pay for need up to
  11.010 NEAR", while `plan` for the same inputs printed "pays 9.778 NEAR of its grant (fits)". The
  check summed the purchase price of every remaining step's attached gas (about 1.23 NEAR), which
  is held only while one transaction is in flight. The run was resumed with `--days 1` and
  completed (204 transactions sent, 7 steps already on chain), so the operators on testnet are
  funded for one day of gas, not two. Fixed afterwards: the check now uses `opsNeed`, the
  planner's reasoning; `apply.test.ts` checks that a 10 NEAR grant passes the default four-market
  plan and that one yoctoNEAR less is refused before ops sends anything.
- **`create_subaccount` gas was underestimated.** Budgeted at 1.0 Tgas; the run burnt at most
  8.573 Tgas over 28 sub-accounts (`gas_burnt` in the state file). `BURNT_GGAS.create_subaccount`
  is now 8.6 Tgas, which moves the ops account's cost from 9.78 to 9.80 NEAR. Measured on the same
  run and under 4% above the budget: `storage_deposit` 2.000 (budget 1.95), `mint` 2.107 (2.04),
  `register` 2.309 (2.23) Tgas; not changed.
- **rpc.testnet.near.org is deprecated.** It answered one `tx` probe with 200 at about 00:28 UTC;
  from then on it answered HTTP 429 with
  "THIS ENDPOINT IS DEPRECATED ... Switch to https://fastnear.com or alternative RPC providers", so
  every failover from fastnear went to an endpoint that always refuses; `status --network testnet`
  failed with "https://rpc.testnet.near.org answered HTTP 429". archival-rpc.testnet.near.org
  answered a `tx` probe the same way at about 00:50 UTC. Both are replaced by dRPC (`https://near-testnet.drpc.org`), which on
  2026-11-12 answered `query` (view_account, view_access_key, view_access_key_list,
  call_function), `tx`, `block`, `gas_price` and `EXPERIMENTAL_protocol_config` with the shapes the
  client expects (an unknown account as `UNKNOWN_ACCOUNT`, an unknown transaction as
  `UNKNOWN_TRANSACTION`). `send_tx` on dRPC has not been tried: nothing was sent to check it.
- **A burst limit turned into failures.** archival-rpc.testnet.fastnear.com answered 5 `tx`
  lookups in a row, then HTTP 429 with `retry-after: 0`, and answered again within 5 s.
  `NearRpc` fails over at the first 429, so the first `verify --txs` ended "NOT CHECKED" after
  210 s. The deploy package's RPC client now waits a rate limit out (`src/pace.ts`,
  `pace.test.ts`). Rerun at 00:53 UTC with the paced client, fastnear archival then dRPC:
  `RESULT match: all 42 checks against testnet agree`, "all 211 recorded hashes are known to the
  chain and succeeded", 49 s. By then the fast market had its first print (bucket 00:50 UTC,
  2.9175 USD/GPU-hour) and 159.956 tUSDC locked in a round.

Not yet shown on testnet:

- **`topup` against the faucet**: how many fund accounts in a row the faucet allows.
- **Gas price above the minimum** under congestion (status would show fewer days left).
- **Name collisions**: a suffix someone already used (apply stops and says so).
- **`send_tx` through dRPC** (the second endpoint) under load.
- The keeper on testnet with these accounts, the index sources live, and the site reading the
  copied `deployments.json`.
