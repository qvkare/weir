# Weir. Run `pnpm install` first. Every target prints what it checked.
#
#   make judge      no keys, no funds, no Rust; 2 s on an Apple-silicon laptop, plus one network call
#   make test       every suite without a running node; needs Rust 1.96 and cargo-near 0.23 (about 2 min warm)
#   make audit      the review's tests, with what each one shows (needs Rust)
#   make test-sandbox   the slow suites on a local NEAR node (about 20 min)
# Times are from runs on 2026-11-12 on an Apple-silicon laptop.

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

NODE  := node --disable-warning=ExperimentalWarning
CARGO := cargo test --manifest-path contracts/Cargo.toml -p weir
AUDIT_TESTS = $(basename $(notdir $(wildcard contracts/weir/tests/audit*.rs)))
TS_PACKAGES := engine index chain agents keeper backtest integration deploy web
# The recorded index bundles: the first H100 print (method version 1) and the newest of each chip.
BUNDLES = evidence/bundles/1794423600-1c0e2cb8b9c8.json $(wildcard evidence/bundles/h100/*.json evidence/bundles/h200/*.json evidence/bundles/a100-80/*.json)
# The judge target collects one line per step in this file; empty when a step runs alone.
JUDGE_NOTES ?=
NOTE = note() { if [ -n "$(JUDGE_NOTES)" ]; then echo "$$*" >> "$(JUDGE_NOTES)"; fi; }; note

.PHONY: help judge verify verify-index verify-vectors verify-deploy sim backtest quote-dry \
        test test-contracts test-ts test-sandbox audit index build build-contracts web lint

help:
	@grep -E '^# [a-z-]+:' Makefile | sed 's/^# /  make /'

# judge: verify, sim, backtest and quote-dry in turn, then a summary of what was and was not checked.
judge:
	@t0=$$(date +%s); notes=$$(mktemp); trap 'rm -f "$$notes"' EXIT; \
	$(MAKE) --no-print-directory verify sim backtest quote-dry JUDGE_NOTES="$$notes"; \
	echo; echo "== make judge: done in $$(( $$(date +%s) - t0 )) s"; cat "$$notes"; \
	echo "Not checked by make judge:"; \
	echo "  - the Rust contract itself (make test, make audit: need Rust and cargo-near)"; \
	echo "  - the contract against the engine on a local NEAR node (make test-sandbox: about 20 min)"; \
	echo "  - anything on a public NEAR network: nothing is deployed yet"; \
	echo "  - today's index from the live sources (make index) and the site (make web)"

# verify: recorded index bundles recomputed, engine against the contract's vectors, deployment records.
verify: verify-index verify-vectors verify-deploy

# verify-index: each recorded bundle recomputed from its offers and its raw source bodies, and re-hashed.
verify-index:
	@echo "== Index bundles: recompute every provider value and the index from the raw bodies, re-hash"
	@n=0; for f in $(BUNDLES); do \
	  out=$$($(NODE) index/src/cli.ts verify "$$f") || { echo "$$out" | grep -v '^ok ' ; echo "FAIL $$f"; exit 1; }; \
	  idx=$$(node -p "const b=require('./$$f'); (b.index_name ?? 'H100-OD') + ' ' + (b.index % 10000 ? b.index/1e6 : (b.index/1e6).toFixed(2)) + ' USD'"); \
	  printf '  ok  %-54s %-24s %s\n' "$$f" "$$idx" "$$(echo "$$out" | tail -1)"; n=$$((n+1)); \
	done; $(NOTE) "ok  verify-index: $$n recorded index bundles recomputed and re-hashed"

# verify-vectors: the TypeScript engine reproduces every case the Rust contract wrote to vectors/.
verify-vectors:
	@echo "== Shared vectors: the engine must reproduce every case the contract wrote"
	@node -e "let t=0; for (const f of ['band','clearing','hash','print','settlement','time']) { const n=require('./vectors/'+f+'.json').cases.length; t+=n; process.stdout.write('  '+f+' '+n); } console.log('  ('+t+' cases)')"
	@$(NODE) --test --test-reporter=spec engine/test/vectors.test.ts 2>&1 | grep -E '^(✔|✖|ℹ (pass|fail))' | sed 's/^/  /'
	@n=$$(node -e "let t=0; for (const f of ['band','clearing','hash','print','settlement','time']) t+=require('./vectors/'+f+'.json').cases.length; console.log(t)"); \
	$(NOTE) "ok  verify-vectors: the engine reproduced all $$n shared vector cases"

# verify-deploy: deployment records read back from the public chain. None exist yet.
verify-deploy:
	@echo "== Deployment records (evidence/deploy/)"
	@if ls evidence/deploy/*.json >/dev/null 2>&1; then \
	  echo "  evidence/deploy/ holds records, but no read-back is wired here yet: fix the verify-deploy target"; exit 1; \
	else \
	  echo "  no deployment recorded yet"; \
	fi
	@$(NOTE) "--  verify-deploy: no deployment recorded yet; nothing read from a public chain"

# sim: the agents trade the h100-fast market on the engine: 20 rounds, settlement, money check.
sim:
	@echo "== Simulation: 30 agents, market h100-fast, seed 7, on the engine (no chain)"
	@out=$$($(NODE) agents/src/cli.ts sim); echo "$$out"; \
	traded=$$(echo "$$out" | grep -oE '^[0-9]+ of [0-9]+ rounds traded'); \
	money=$$(echo "$$out" | grep -E '^Money check' | sed 's/^Money check: //'); \
	node -e "const [d, ...r] = process.argv[1].match(/[0-9]+\.[0-9]{2}/g).map((x) => Math.round(x * 100)); if (d !== r.reduce((a, b) => a + b, 0)) { console.error('money check FAILED: ' + process.argv[1]); process.exit(1); }" "$$money"; \
	$(NOTE) "ok  sim: $$traded; money check holds: $$money"

# backtest: results recomputed from backtest/data/derived/ and compared byte for byte; then the Python check.
backtest:
	@echo "== Backtest: recompute backtest/results/ from the committed data, compare, cross-check in Python"
	@d=$$(mktemp -d); trap 'rm -rf "$$d"' EXIT; \
	$(NODE) --input-type=module -e "import { runBacktest } from './backtest/src/backtest/run.ts'; import { DERIVED } from './backtest/src/lib/paths.ts'; runBacktest(DERIVED, process.argv[1]);" "$$d"; \
	for f in summary.json summary.md weeks.csv site.json; do \
	  cmp -s "$$d/$$f" "backtest/results/$$f" && echo "  same as committed: backtest/results/$$f" || { echo "  DIFFERS: backtest/results/$$f"; exit 1; }; \
	done
	@python3 backtest/scripts/verify.py | sed 's/^/  /'
	@$(NOTE) "ok  backtest: 4 result files identical to the committed ones; verify.py 900 numbers, 0 mismatches"

# quote-dry: a live NEAR Intents dry quote, USDC on Arbitrum to USDC on NEAR. Exits 0 even when it cannot quote.
QUOTE_FROM ?= arbitrum
quote-dry:
	@echo "== NEAR Intents: a live dry 1Click quote, $(QUOTE_FROM) USDC -> NEAR USDC, 20 USDC (nothing is sent)"
	@if out=$$($(NODE) chain/src/cli.ts quote --from $(QUOTE_FROM) --amount 20 --to near 2>&1); then \
	  echo "$$out" | sed 's/^/  /'; r="quoted"; \
	elif echo "$$out" | grep -qi 'not available'; then \
	  echo "  The service answered, but it does not quote this pair right now:"; echo "$$out" | sed 's/^/    /'; r="answered, pair not available now"; \
	else \
	  echo "  The service could not be reached or failed:"; echo "$$out" | sed 's/^/    /'; r="service unreachable or failing"; \
	fi; \
	if [ "$$r" = quoted ]; then $(NOTE) "ok  quote-dry: live dry quote received; nothing was sent"; \
	else $(NOTE) "--  quote-dry: $$r; not counted as a failure"; fi

# test: every suite that does not need a running node: the contract's and every TypeScript package's.
test: test-contracts test-ts

# test-contracts: unit, property, audit and vector tests of the contract, then clippy. About 90 s warm, 70 s of it the property tests.
test-contracts:
	$(CARGO) --lib
	$(CARGO) --test properties
	$(CARGO) $(addprefix --test ,$(AUDIT_TESTS))
	$(CARGO) --test vectors
	$(MAKE) --no-print-directory lint

# test-ts: node:test and tsc --noEmit in each TypeScript package. About 15 s.
test-ts:
	@for p in $(TS_PACKAGES); do \
	  printf '== %-12s ' "$$p"; \
	  out=$$(pnpm --silent --dir $$p test 2>&1) || { echo "$$out" | tail -40; echo "test FAILED in $$p"; exit 1; }; \
	  printf 'tests: %s, ' "$$(echo "$$out" | grep -E '^# (pass|fail|skipped) ' | tr -d '#' | xargs)"; \
	  pnpm --silent --dir $$p typecheck >/dev/null 2>&1 || { pnpm --dir $$p typecheck; echo "typecheck FAILED in $$p"; exit 1; }; \
	  echo "typecheck ok"; \
	done

# test-sandbox: the real wasm on a local near-sandbox node (macOS arm64 or Linux; the first run downloads
# near-sandbox 2.14.0). The Rust sandbox suite took 641 s here, the integration e2e 393 s.
test-sandbox: build-contracts
	$(CARGO) --test sandbox -- --nocapture
	pnpm --dir integration run e2e

# audit: the independent review's tests: what each one asserts, then the states they print.
audit:
	@for f in $(wildcard contracts/weir/tests/audit*.rs); do \
	  echo "== $$f"; \
	  awk '/^\/\/\/ /{d=d substr($$0,5) " "; next} /^#\[test\]/{t=1; next} /^fn [a-z0-9_]+\(/{ if (t) { n=$$2; sub(/\(.*/,"",n); print "- " n; print "    " d } d=""; t=0; next } {d=""; t=0}' $$f; \
	done
	@echo "== Running them (each prints the state it reached)"
	@$(CARGO) $(addprefix --test ,$(AUDIT_TESTS)) -- --nocapture --test-threads=1 2>&1 \
	  | sed -E 's/EVENT_JSON:.*$$//' \
	  | awk '/^thread .* panicked at/{skip=1; next} skip{skip=0; next} /^(called `Result|note: run with)/{next} /^[. ]*$$/{next} {print}'

# index: fetch this hour's index for every chip from the six public sources, then verify what was written.
# Writes to a new temporary directory; `make index OUT=evidence/bundles` records the bundles instead.
OUT ?=
index:
	@out="$(OUT)"; [ -n "$$out" ] || out=$$(mktemp -d); \
	echo "== Fetching the H100, H200 and A100 80 GB indexes into $$out (network)"; \
	log=$$($(NODE) index/src/cli.ts fetch --chip all --out "$$out"); echo "$$log"; \
	for f in $$(echo "$$log" | grep '^wrote ' | cut -d' ' -f2); do \
	  echo "== verify $$f"; $(NODE) index/src/cli.ts verify "$$f" | tail -1; \
	done

# build: the two wasm files (needs cargo-near) and the site in model mode.
build: build-contracts
	cd web && WEIR_MODEL=1 pnpm exec next build

build-contracts:
	contracts/build.sh

# web: the site on http://localhost:3000 in model mode: every view answered by the engine, no chain.
WEB_PORT ?= 3000
web:
	cd web && WEIR_MODEL=1 pnpm exec next dev --port $(WEB_PORT)

# lint: rustfmt's check and clippy on the contracts, warnings as errors.
lint:
	cargo fmt --manifest-path contracts/Cargo.toml --all -- --check
	cargo clippy --manifest-path contracts/Cargo.toml --workspace --all-targets -- -D warnings
