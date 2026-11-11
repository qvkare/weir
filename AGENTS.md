# Working in this repository

Notes for anyone changing Weir, person or coding agent.

## Where things are

- `docs/SPEC.md` is the source of truth: the rules, the parameters, the views, the events and the refusal texts. Where code and the spec differ, the code is wrong.
- `docs/AUDIT.md` is the independent review's own record. Do not edit it; answer it in the spec, the code and the tests.
- `contracts/weir` (Rust) and `engine/` (TypeScript) are the two implementations of the spec. `vectors/` holds the test cases the contract writes and the engine must reproduce.
- `index/` makes the price indexes; `evidence/` keeps what they printed. `chain/`, `agents/`, `keeper/` and `deploy/` talk to NEAR. `integration/` runs the real wasm on a local node against the engine. `backtest/` is the price history. `web/` is the site.
- Each package has a README saying what it does, how to run it and what it has not proven.

## Commands

```sh
pnpm install
make judge          # no keys, no Rust: index bundles, vectors, simulation, backtest, a dry quote
make test           # every suite without a running node (Rust 1.96, cargo-near 0.23)
make test-sandbox   # the slow suites on a local near-sandbox node
make help           # every target
```

## Rules of the house

1. **The spec first.** A change to the rules is a change to `docs/SPEC.md`, with its version raised, before any code.
2. **Two implementations, compared.** The contract and the engine are written separately from the spec. Neither copies the other. They are compared on `vectors/` (`WEIR_WRITE_VECTORS=1 cargo test -p weir --test vectors` writes them; `make verify-vectors` checks the engine) and, on a local node, call by call (`make test-sandbox`). A refusal has the same text in both (spec section 16).
3. **No keys in the repository.** Secret keys live in `~/.near-credentials/` or in environment variables. `.env`, `*.key`, `credentials/`, `deploy/out/` and `keeper/.env` are ignored. Records meant to be committed (`evidence/`, `record.json`) hold public keys and transaction hashes only.
4. **One finished piece of work per commit**, described plainly in the message: what changed and why, no adjectives.
5. **Failures stay on the record.** A failed run, a refused transaction or a finding against us is kept in the results file or README where it happened, next to what was done about it. Numbers are written with the condition they were measured under, and a figure that was reasoned and not measured says so.
6. **Every claim has a command.** A sentence in a README that states a result names the command or file that shows it. If nothing shows it, it is labelled as the authors' statement or it is removed.
7. **Plain words.** Short sentences, units on every figure, no praise.
