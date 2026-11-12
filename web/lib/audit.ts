// The review of the contract, item for item from its final record: docs/AUDIT.md ("Every
// finding, status under 0.6", "What remains for a reporter", "Residual risks", "Verdict").
// Four passes, against specifications 0.3, 0.4, 0.5 and 0.6. Numbers are the record's, at the
// deployed parameters it lists (the weekly preset: 3 reporters, quorum 2, max_spread_bps 200,
// min_prints 126 of 168, band_bps 1500, commit_fee 0.10 $, forfeit_bps 100, max_commits 64).
// Tests are in contracts/weir/tests/; lib/audit.test.ts checks that every test named here
// exists, that every limit_ test there is shown here, and that every spec section exists.

export interface Finding {
  /** The record's number, e.g. "2.1". */
  id: string;
  severity: string;
  finding: string;
  /** The status in the record's words: the rule that closes it, or what remains, with its number. */
  status: string;
  /** "Closed", "Partly closed" or "Open". */
  state: "Closed" | "Partly closed" | "Open";
  sections: string[];
  tests: string[];
  /** What the named test demonstrates, when the record gives it. */
  shows?: string;
  /** Found by reading and not tested. */
  byReading?: boolean;
}

export const AUDIT_DOC = "docs/AUDIT.md";
export const PASSES = 4;

/** Closed by a rule, each with the test that asserts the attack now fails. */
export const CLOSED: Finding[] = [
  { id: "1.1", severity: "Critical", state: "Closed", finding: "One reporter ratcheted the index through the two-report mean.", status: "No move rule, and a full set of reports gives the median.", sections: ["9"], tests: ["audit_one_reporter_can_no_longer_steer_the_index"] },
  { id: "1.2", severity: "High", state: "Closed", finding: "One silent reporter froze the index after a large move.", status: "No move limit.", sections: ["9"], tests: ["audit_a_silent_reporter_can_no_longer_freeze_the_index"] },
  { id: "1.3", severity: "Critical on testnet", state: "Closed", finding: "Minting u64::MAX sets made clear overflow and froze the series.", status: "The mint cap.", sections: ["8"], tests: ["audit_open_sets_can_no_longer_overflow"] },
  { id: "1.4", severity: "High", state: "Partly closed", finding: "A function-call agent forfeited an account's balance to an accomplice.", status: "Closed for theft: forfeits are burned. The burning that remains is 2.4, below.", sections: ["7.3"], tests: ["audit_function_call_agent_can_no_longer_drain_a_guarded_account"] },
  { id: "1.6", severity: "Medium", state: "Closed", finding: "Changing the guard after commit cancelled an order for free.", status: "The commit records the guard and its reference.", sections: ["6.2", "6.4"], tests: ["audit_guard_change_after_commit_no_longer_cancels"] },
  { id: "1.7", severity: "Medium", state: "Closed", finding: "Out-of-order reports bypassed the move limit.", status: "Nothing compares prints.", sections: ["9"], tests: ["audit_reporting_out_of_order_no_longer_bypasses_anything"] },
  { id: "1.8", severity: "Medium", state: "Partly closed", finding: "Storage the contract pays for grew without bound.", status: "Results keep only fills, and anyone may prune. Still open: nobody is paid to prune or to send NEAR.", sections: ["14", "15"], tests: ["audit_storage_bytes_per_object_and_pruning"] },
  { id: "1.9", severity: "Note", state: "Partly closed", finding: "Missing parameter checks, a missing event, the bonus pool, an unchecked add in the mock.", status: "Closed, except some parameter checks (2.7, below).", sections: ["3"], tests: [] },
  { id: "2.7", severity: "Medium", state: "Partly closed", finding: "Dangerous parameters were accepted.", status: "A quorum below a majority is now refused. The rest is still accepted: see 2.7 under the stated limits.", sections: ["3"], tests: ["audit2_a_quorum_of_one_in_three_is_refused"] },
  { id: "3.1", severity: "Critical", state: "Closed", finding: "The 0.5 void payout, the traded average, was set by wash trades: a trading reporter took 19.40 $ of a counterparty's 20 $.", status: "Specification 0.6: a void pays band/2 on each side, and no rule reads the traded fields.", sections: ["10"], tests: ["audit3_wash_trades_no_longer_set_the_void_payout", "audit4_a_non_reporter_cannot_move_the_void_payout"] },
];

/** Open: the weakness exists in the deployed contract today. */
export const OPEN: Finding[] = [
  { id: "2.1", severity: "High", state: "Open", finding: "With one reporter absent, one dishonest reporter chooses which buckets print and leans each print.", status: "About 0.029 $ a unit, about 4.8% of the band: up to 1% lean per print (about 0.020 $) plus up to 42 of 168 hours dropped (about 0.009 $ at an assumed 1% hourly spread of the index; the spread was assumed, not measured).", sections: ["9", "15"], tests: ["limit_one_reporter_selects_which_buckets_print"], shows: "the mechanism with ±5% hourly swings: a fixing of 2.121 against a true 2.000" },
  { id: "3.2", severity: "High", state: "Open", finding: "A reporter who holds the cheap side and forces a void is paid half the band for it.", status: "Up to 0.299 $ a unit, 49.8% of the band, over the price paid; up to 0.30 $ (50%) against the true settlement. It needs 43 of 168 buckets without a print.", sections: ["10", "15"], tests: ["limit_a_trading_reporter_forces_a_void_for_up_to_0_299_a_unit_at_the_deployed_band", "limit_forcing_a_void_pays_a_reporter_half_the_band_for_a_cheap_side"] },
  { id: "2.2", severity: "High", state: "Open", finding: "Forcing a void paid mid-band (specification 0.4).", status: "Replaced in 0.5 by the traded-average rule (3.1), then by the centre-of-band rule in 0.6. Open as a reporter gain: 3.2.", sections: ["10"], tests: ["limit_forcing_a_void_pays_a_reporter_half_the_band_for_a_cheap_side"] },
  { id: "2.3", severity: "High", state: "Open", finding: "Blocking a round costs max_commits × commit_fee. (1.5, eviction was free, is open as this.)", status: "6.40 $ a round at the 0.10 $ commit fee, about 1,075 $ a week of 168 rounds, plus capital above the largest honest lock.", sections: ["15"], tests: ["limit_blocking_a_round_costs_6_40_dollars_at_the_deployed_fee", "audit_eviction_griefing_now_costs_a_fee_per_slot"] },
  { id: "2.8", severity: "Low", state: "Open", finding: "A large grace leaves many pending buckets in the root state, and settle decides them all in one call. Recoverable through finalize_print.", status: "Open.", sections: ["9", "10"], tests: [], byReading: true },
  { id: "2.9", severity: "Low", state: "Open", finding: "prune_print can delete delivery reports before a late settlement.", status: "Open.", sections: ["9"], tests: [], byReading: true },
  { id: "2.10", severity: "Note", state: "Open", finding: "The guard reference has no age check and lags 1 to 2 intervals.", status: "Open.", sections: ["6.4"], tests: [], byReading: true },
  { id: "2.11", severity: "Note", state: "Open", finding: "get_prints scans 4096 words and can miss prints after pruning (a view only).", status: "Open.", sections: ["12"], tests: [], byReading: true },
  { id: "4.1", severity: "Low", state: "Open", finding: "A non-reporter can cause a void only indirectly: by exhausting the contract's NEAR so that reports fail.", status: "Open. Expensive unless the balance has been allowed to run low: about 6.40 $ of fees for 8 KB of book storage.", sections: ["14", "15"], tests: [], byReading: true },
];

/** Open, and stated in the specification as limits it accepts. */
export const STATED: Finding[] = [
  { id: "2.4", severity: "Medium", state: "Open", finding: "With max_round_lock unset (the default), an agent burns 1% plus the fee per round.", status: "100 $ became 90.25 $ in 10 rounds. The deployment tool sets the limit for the agents it creates.", sections: ["15"], tests: ["limit_an_account_without_a_round_lock_limit_can_be_burned"] },
  { id: "2.5", severity: "Medium", state: "Open", finding: "Not revealing changes others' fills, which gives a last look.", status: "A look costs 1% of the lock plus 0.10 $. Invariant 6 now reads \"burned stays burned\".", sections: ["11", "15"], tests: ["limit_last_look_a_non_reveal_changes_another_accounts_fill"] },
  { id: "2.6", severity: "Low", state: "Open", finding: "On testnet, one account can take the whole mint cap.", status: "The next minter is refused; auctions still clear.", sections: ["8"], tests: ["limit_one_account_can_take_the_whole_mint_cap"] },
  { id: "2.7", severity: "Medium", state: "Open", finding: "Unwise parameters are still accepted.", status: "A 100% spread, 2 reporters, no fee with no forfeit, and grace equal to the period are accepted. Read get_params before trusting a deployment.", sections: ["3", "15"], tests: ["limit_unwise_parameters_are_still_accepted"] },
];

/** Tests behind the record's "Examined and found sound" list, which are not numbered findings. */
export const SOUND_TESTS = ["audit2_a_pruned_bucket_cannot_come_back"];

/** The record's History section, one line per pass. */
export const HISTORY: { pass: string; spec: string; found: string }[] = [
  { pass: "1", spec: "0.3", found: "One reporter could ratchet the index and one could freeze it; clear could overflow; forfeits could be steered to an accomplice; eviction was free; the guard could be changed after commit. Specification 0.4 closed most of these." },
  { pass: "2", spec: "0.4", found: "With one reporter absent, a single dishonest reporter could force a void settlement at mid-band. Specification 0.5 replaced that rule." },
  { pass: "3", spec: "0.5", found: "The 0.5 rule paid a void series at the average price its own auctions had traded at. That fix was faulty: wash trades between two accounts of one person, in a round they alone used, set the average anywhere in the band for the price of commit fees. A trading reporter took 19.40 $ of a counterparty's 20 $." },
  { pass: "4", spec: "0.6", found: "Specification 0.6 withdrew the 0.5 rule and pays a void series half the band on each side. The pass found that rule sound against traders who are not reporters: wash trades, mints, merges and transfers moved the payout by nothing. What remains is a reporter's gain (2.1, 3.2) and an indirect path through the contract's NEAR balance (4.1)." },
];

export const VERDICT = {
  testnet: "Weir 0.6 is fit for a public testnet with test dollars, with its reporters run by one known operator and these limits stated where users will read them. Its accounting stayed exact through four passes, and the void rule now in force cannot be moved by traders.",
  real: "It is not fit for real dollars until, at least: the reporters are independent parties, numerous enough that one absence does not hand every bucket to a two-reporter veto; blocking a round costs something that scales with what it blocks; max_round_lock is on by default; and the contract's NEAR balance and pruning have a funded owner.",
  history: "One fix in this review's history was itself found faulty: the 0.5 void rule. Any change made to meet the conditions above needs its own review.",
};

export const specHref = (section: string) => `/spec#s${section.replace(/\./g, "-")}`;
export const auditHref = (anchor?: string) => `/audit${anchor ? `#${anchor}` : ""}`;

// The record's "Residual risks before real money" list, read from docs/AUDIT.md at build and
// shown on /proof in the record's own words. The verdict makes stating them a condition of
// running on testnet, so the page renders the file's bullets rather than a paraphrase.

export interface RiskItem {
  /** Markdown text of the bullet, as written. */
  text: string;
  children: RiskItem[];
}

/** The bullets under the record's "## Residual risks before real money" heading, nested. */
export function residualRisks(record: string | null): { heading: string; items: RiskItem[] } | null {
  if (!record) return null;
  const lines = record.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => /^## Residual risks before real money/.test(l));
  if (start < 0) return null;
  const heading = lines[start]!.replace(/^##\s+/, "");
  const items: RiskItem[] = [];
  let last: RiskItem | null = null;
  let lastChild: RiskItem | null = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^#{1,6}\s/.test(l)) break;
    if (/^- /.test(l)) {
      last = { text: l.slice(2).trim(), children: [] };
      lastChild = null;
      items.push(last);
    } else if (/^\s{2,}- /.test(l) && last) {
      lastChild = { text: l.replace(/^\s+- /, "").trim(), children: [] };
      last.children.push(lastChild);
    } else if (/^\s+\S/.test(l)) {
      const target = lastChild ?? last;
      if (target) target.text += ` ${l.trim()}`;
    }
  }
  return { heading, items };
}

/** The sandbox comparison's figures, read from integration/RESULTS.md; null for any not found. */
export function integrationFigures(text: string | null) {
  if (!text) return null;
  const pick = (re: RegExp) => re.exec(text)?.[1] ?? null;
  return {
    run: pick(/^(\w+) run, \*\*specification/m),
    spec: pick(/\*\*specification (\d+\.\d+)\*\*/),
    checks: pick(/\*\*(\d[\d,]* of \d[\d,]*) checks pass/),
    stateChanges: pick(/([\d,]+) state changes/),
    views: pick(/([\d,]+) view calls/),
    refusals: pick(/\(([\d,]+) refused calls/),
    node: pick(/(near-sandbox [\d.]+)/),
    date: pick(/specification \d+\.\d+\*\*, on (\d{4}-\d{2}-\d{2})/),
  };
}
