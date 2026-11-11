# @weir/engine

The TypeScript reference engine for Weir, written from `docs/SPEC.md` alone. It is the
second, independent implementation of the spec next to the NEAR contract; the two are
compared on the shared test vectors in `vectors/`. It has no runtime dependencies and no
platform imports, so `src/` runs unchanged in Node 22.18+ (which strips the types), a
browser or a Cloudflare Worker.

Dollar amounts are `bigint` micro-USDC. Prices, sizes and times are `number`.

## Modules

| File | Spec | What it is |
|---|---|---|
| `src/time.ts` | 4 | Series and round timing, `phaseAt(params, series, now)`, the live series at a time |
| `src/band.ts` | 6.1 | `computeBand(anchor, tick, bandBps)`: `{ mid, half, floor, band }`, or throws |
| `src/hash.ts` | 6.2 | `commitPreimage` and `commitHash` of a sealed order |
| `src/sha256.ts` | 6.2 | Synchronous SHA-256 in plain TypeScript, checked against `node:crypto` |
| `src/clearing.ts` | 7.1, 7.2 | `clearRound(orders, tick)`: price, volume and per-order fills; `curves(orders)` for charts |
| `src/index.ts` | 9 | `median` and `printDecision`: when a bucket's reports become a print |
| `src/settlement.ts` | 10 | Fixing, the void rule, payouts, bonus and carry pools, redeem amounts |
| `src/market.ts` | 5 to 13 | `Market`: the whole contract state machine in memory, with a clock you set |
| `src/wire.ts` | 3, 5-14 | The contract's JSON interface served from a `Market`: wire types, `callView`, `callChange`, `wireEvent` |
| `src/mod.ts` | | Re-exports the public API |

`Market` keeps every check of the contract, including "must be registered", and every call
validates fully before it changes anything, so a call that throws leaves the state as it
was, like a panicking transaction. The panics the spec names keep their exact messages:
`index is stale`, `round is full`, `not enough prints yet`. It leaves out what only exists
on chain: the registration fee, the 1 yoctoNEAR deposits and the token contract (`deposit`
stands in for `ft_on_transfer`). Events of section 13 collect in `market.events`; their
fields are camelCase. Views return copies.

## Wire format

`src/wire.ts` is the single definition of the contract's JSON, for the website, the agents
and anything else that talks to Weir. Every type is documented with its spec section.
Keys are snake_case, dollar amounts are decimal strings (`U128`), prices, sizes, times and
counts are numbers, and nulls are where section 12 puts them.

```ts
import { callChange, callView, eventLog } from "@weir/engine";

callChange(market, "alice", "register", {});
callChange(market, params.usdc, "deposit", { sender_id: "alice", amount: "10000000", msg: "" });
const seq = callChange(market, "alice", "commit", { series: 0, hash, lock: "2500000" });
callView(market, "get_account", { account_id: "alice" }); // { balance: "7500000", guard: null }
market.events.map(eventLog); // the EVENT_JSON:... lines the contract logs
```

Method names and argument objects are the contract's, so the same client code can call
the chain instead. `deposit` takes the arguments of `ft_on_transfer` and must be called by
the `usdc` account. Change methods the spec gives no return value return null.

## Tests

```sh
pnpm --filter @weir/engine test        # node:test, every file in test/
pnpm --filter @weir/engine typecheck   # tsc --noEmit
WEIR_ALLOW_MISSING_VECTORS=1 pnpm --filter @weir/engine test   # skip vectors not written yet
```

- `clearing.test.ts`: 32 hand-worked rounds, one per branch and edge of section 7.
- `clearing.property.test.ts`: 5,000 seeded random rounds checking invariants 3 and 4,
  the second by brute force over every tick price, plus fill priority.
- `time.test.ts`, `band_hash_index.test.ts`, `settlement.test.ts`: the arithmetic modules,
  phase boundaries to the second, both band panics, the `far` rule, void settlement, bonus and carry.
- `market.test.ts`: scenarios through the whole contract, including each named panic.
- `model.test.ts`: 300 seeded random action sequences against `Market`, checking
  invariants 1, 2 and 5 after every step against dollars the test counts itself, and that
  every call that threw changed nothing.
- `sha256.test.ts`: the standard vectors (empty, "abc", a million "a") and 300 random
  inputs, ASCII and multi-byte UTF-8, against `node:crypto`.
- `wire.test.ts`: a scripted market driven through `callChange`, every view checked field
  by field, exact event log lines, and a JSON round trip of all of it.
- `vectors.test.ts`: reproduces every case in `../vectors/*.json` exactly. A missing file fails.

## Using `Market`

```ts
import { commitHash, Market } from "@weir/engine";

const m = new Market(params, 96_000); // params: Params, now in Unix seconds
m.report("r0", 96_000, 2_000_000, bundle); // two of three reporters make a print
m.report("r1", 96_000, 2_000_000, bundle);
for (const a of ["alice", "bob"]) { m.register(a); m.deposit(a, 10_000_000n); }

m.setTime(96_400); // round 0 of series 0 is in its commit phase
const salt = "5a17".repeat(8);
const order = { series: 0, round: 0, accountId: "alice", side: "Long", size: 10, price: 250_000, salt } as const;
const seq = m.commit("alice", 0, commitHash(order), 2_500_000n); // opens the series
// ... bob commits a SHORT the same way ...

m.advance(120); // reveal phase
m.reveal("alice", 0, 0, seq, "Long", 10, 250_000, salt);
m.advance(60); // the round is over
const result = m.clear(0, 0); // { price, volume, fills, ... }

// ... reporters keep printing through the delivery week ...
m.setTime(103_720); // delivery and its last report window are over
m.settle(0);
m.redeem(0, "alice"); // returns the bigint credited
console.log(m.getAccount("alice"), m.getTotals(), m.events.length);
```
