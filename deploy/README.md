# @weir/deploy

One command that takes the built contracts to NEAR testnet and leaves running markets with
reporters and trading agents ready for the keeper. Built and proven on a local near-sandbox
node; **never run against testnet by its author** (see the last section).

```sh
contracts/build.sh                                                     # the wasm it deploys
node deploy/src/cli.ts plan   --network testnet --suffix <s>           # offline: what it would do
node deploy/src/cli.ts apply  --network testnet --suffix <s>           # do it (resumable)
node deploy/src/cli.ts status --network testnet                        # read the chain, compare
node deploy/src/cli.ts seal   --network testnet --markets h100-fast --confirm weir-h100-fast-<s>.testnet
node deploy/src/cli.ts topup  --network testnet --days 14 [--dry-run]  # keep it funded (below)
```

Options: `--markets h100-fast,h100-weekly,h200-weekly,a100-80-weekly` (default: those in the
state file, else all four), `--out <dir>` (default `deploy/out/<network>/`, git-ignored),
`--keys <dir>` (default `~/.near-credentials/<network>/`; refused inside the repository),
`--days <n>` (operator gas to fund, default 2), `--faucet-wait <secs>` (default 900),
`--json` (status), `--dry-run` and `--max-fund-accounts <n>` (topup, default 20). On the sandbox: `--rpc <url> --root-key <sandbox home>/validator_key.json`.
The suffix is kept in `<out>/state.json`; later runs need only `--network`.

## What it creates

With the markets of `agents/src/presets.ts`, whose parameters are read from `MARKETS` at run time
(`plan` prints all of it, for the actual names, with every transaction in order and what it
attaches):

| Account | Created by | What it is | NEAR |
|---|---|---|---|
| `weir-<market>-<s>.testnet` | faucet | the market contract, deployed and initialised with `new(params)` in one transaction | the faucet grant (10 NEAR assumed, read by `apply`); weir.wasm is 303,281 B = 3.04 NEAR of storage, plus 0.105 NEAR of attached gas to deploy; the remaining ~6.86 NEAR pays for the state it accumulates |
| `weir-usdc-<s>.testnet` | faucet | the test dollar `tUSDC` (`mock_usdc.wasm`, open `mint`). **Real USDC is out of scope.** | grant; 146,689 B = 1.47 NEAR of storage |
| `weir-ops-<s>.testnet` | faucet | parent of every operator; pays their NEAR, their token storage and their registrations | grant; pays 9.78 NEAR for the four markets (6.83 for the two H100 ones) |
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
reporters 0.29, agents 0.79 (maker 1.41), the keeper 2.88. `plan` prints every key's arithmetic. An allowance is a cap,
not money: what is spent comes from the account's balance.

**Funding.** Each operator gets its setup gas plus `--days` of gas at the expected load (worst
measured gas, `clear` at our agents' book), plus what it must keep: the purchase price of its
largest call and any storage stake above 770 bytes (NEP-448). With the default 2 days, the four
markets cost the ops account 9.78 NEAR of a 10 NEAR grant, so a faucet grant runs the markets
for about two days; `topup` keeps them running after that. Re-running `apply` never sends more NEAR.

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
check this with recognisable generated keys; the sandbox run scans all CLI output and files for
the 88 secrets it generated.

## Outputs (`--out`)

| File | |
|---|---|
| `deployments.json` | the repository root's shape; on testnet `rpc` = fastnear and rpc.testnet.near.org, `explorer` = nearblocks, `bundles_base` null |
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

`keeper.env` uses the keeper's per-contract key shape (keeper commit 868e2fc, "Let every keeper
signer hold one key per contract"): a NEAR function-call key names exactly one contract, so the
three reporters and the housekeeping account hold one key per market contract and each agent one
for its market. With the housekeeping account set, the keeper prunes prints and results.

## Tests

```sh
pnpm --filter @weir/deploy test        # offline, node:test: 31 tests
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
  X plus a tenth; a contract's N days of unpruned prints, 1.49 NEAR a day fast, 0.12 weekly; a key
  rotated below N days' need and not at exactly it, to a month or N days x 1.25; the number of fund
  accounts; the fast market's gas about twelve times a weekly one's); and on the fake chain a
  test-dollar top-ups at and below the floor; and on the fake chain a drained agent (NEAR and,
  for another, test dollars), contract and key with an empty ops account: fund accounts created and swept, the
  run killed partway and resumed, nothing short afterwards, the new key on chain, the old one
  gone, keeper.env holding the new one, a second run sending nothing, no secret logged.
- `encode.test.ts`: `DeleteKey` (the one action this package encodes) and a 400 kB deploy, byte
  for byte against `@near-js/transactions`.
- `faucet.test.ts`: the faucet client through 429 and 503, an existing account, a refusal, a
  `false`, a long outage.
- `e2e/e2e.ts` (sandbox, through the CLI as an operator runs it): plan; apply two H100 markets
  (117 transactions, each hash logged); status asserted field by field (code hashes, keys and
  allowances, balances, storage to the byte, parameters, registrations, guards, deposits); one
  tick by hand with the generated keys (three reports make a print, a buyer and a seller commit
  and reveal, the keeper's key clears at 3 GPU-hours at $0.435, the agent key refused
  `set_guard`, `withdraw` and `register`, the keeper's weekly key refused on the fast market,
  allowance charged per call measured); apply again sends nothing; seal refused without and with
  the wrong `--confirm`, then sealed, and the sealed market still takes reports and commits; 12
  ticks of the keeper's `runTick` loaded from the generated `keeper.env` and `deployments.json`
  (index sources served from the saved fixtures), which reports, commits, reveals and clears with
  no failure; topup after draining an agent's NEAR, another's test dollars (withdrawn) and
  exhausting reporter-a's fast key (status flags
  both; `--dry-run` names them and creates nothing; topup creates fund accounts from the sandbox
  root, sweeps them, tops everyone up to 14 days, rotates the key, rewrites keeper.env; a second
  run sends nothing), then the keeper restarted on the new keeper.env reports with the rotated key;
  a fresh apply killed with SIGKILL halfway and re-run to completion; no secret in any output.

## Not run against testnet by this tool's author

Everything above ran on near-sandbox 2.14.0 (protocol 88) only. Only testnet will show:

- **The faucet.** The endpoint and request are near-cli-rs's (`src/chain.ts`, `FAUCET_URL`,
  with the source cited); its grant per account (10 NEAR assumed; `apply` reads the balance
  instead), its rate limits and how it answers when limited, whether it accepts six accounts in
  a row from one address, and the exact shape of its reply (the client falls back to waiting for
  the account if the reply is not the outcome near-cli-rs expects).
- **Real latency and finality**: 211 transactions one after another.
- **`topup` against the faucet**: how many fund accounts in a row the faucet allows, and its
  grant per account (the sandbox root gives 10 NEAR).
- **RPC limits** of fastnear and rpc.testnet.near.org under that load, and their failover.
- **Gas price above the minimum** under congestion (status would show fewer days left).
- **Name collisions**: a suffix someone already used (apply stops and says so).
- The keeper on testnet with these accounts, the index sources live, and the site reading the
  copied `deployments.json`.
