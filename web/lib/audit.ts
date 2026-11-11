// The review of the contract, from its written record: docs/AUDIT.md ("Every finding, status
// under 0.5", "Residual risks", "Verdict") and the Audit section of contracts/README.md. Where
// the two differ, the later review record wins: contracts/README.md still lists the void
// finding (2.2) as closed, and docs/AUDIT.md's third pass found the 0.5 void rule can be
// steered (3.1, open). Tests are in contracts/weir/tests/; lib/audit.test.ts checks that every
// test named here exists and that every spec section exists.

export interface ClosedFinding {
  id: string;
  severity: string;
  finding: string;
  rule: string;
  sections: string[];
  test: string;
  /** "Closed", or "Partly closed" where part of it remains a stated limit. */
  status: string;
}

export interface Limit {
  id: string;
  severity: string;
  /** What remains possible, in plain words. */
  limit: string;
  /** What the test demonstrates, with its number. */
  shows: string;
  /** The number at the deployed parameters, when it differs from the test's fixture. Filled in by the page from get_params where it can be. */
  deployed?: string;
  sections: string[];
  test: string | null;
  /** "Open" for the review's open findings; "Stated" for limits the spec states and accepts. */
  status: "Open" | "Stated";
}

export const AUDIT_DOC = "docs/AUDIT.md";

export const CLOSED: ClosedFinding[] = [
  { id: "1.1", severity: "Critical", finding: "One reporter could ratchet the index through the mean of two reports.", rule: "No move rule; with every reporter present the print is the median.", sections: ["9"], test: "audit_one_reporter_can_no_longer_steer_the_index", status: "Closed" },
  { id: "1.2", severity: "High", finding: "One silent reporter froze the index after a large move.", rule: "There is no move limit.", sections: ["9"], test: "audit_a_silent_reporter_can_no_longer_freeze_the_index", status: "Closed" },
  { id: "1.3", severity: "Critical on testnet", finding: "Minting u64::MAX sets made clear overflow and froze the series.", rule: "mint stops at 2^53 - 1 less what the auctions can still add.", sections: ["8"], test: "audit_open_sets_can_no_longer_overflow", status: "Closed" },
  { id: "1.4", severity: "High", finding: "A function-call agent forfeited an account's balance to an accomplice.", rule: "Forfeits are burned, so nobody gains from them. Burning by a careless agent remains a stated limit (2.4).", sections: ["7.3"], test: "audit_function_call_agent_can_no_longer_drain_a_guarded_account", status: "Partly closed" },
  { id: "1.6", severity: "Medium", finding: "Changing the guard after a commit cancelled the order for free.", rule: "The commit records the guard and its reference; reveal applies those.", sections: ["6.2", "6.4"], test: "audit_guard_change_after_commit_no_longer_cancels", status: "Closed" },
  { id: "1.7", severity: "Medium", finding: "Reporting out of order bypassed the move limit.", rule: "Nothing compares a print with earlier prints.", sections: ["9"], test: "audit_reporting_out_of_order_no_longer_bypasses_anything", status: "Closed" },
  { id: "1.8", severity: "Medium", finding: "Storage the contract pays for grew without bound.", rule: "Results keep only filled orders, and anyone may prune old prints and results. Nobody is paid to do it: a stated limit.", sections: ["12", "14"], test: "audit_storage_bytes_per_object_and_pruning", status: "Partly closed" },
  { id: "2.7", severity: "Medium", finding: "A quorum of one in three let one reporter print alone.", rule: "The quorum must be a majority of the reporters.", sections: ["3"], test: "audit2_a_quorum_of_one_in_three_is_refused", status: "Closed" },
  { id: "3.1", severity: "Critical", finding: "Under 0.5, wash trades between two accounts set the void payout (0.397 against a fair 0.200; the counterparty lost 19.80 $ of 20 $).", rule: "Specification 0.6: a void series pays the centre of its band and reads nothing that was traded. In the same test the two sides now lose only their fees, 0.10 $ and 0.30 $.", sections: ["10"], test: "audit3_wash_trades_no_longer_set_the_void_payout", status: "Closed by 0.6" },
  { id: "2", severity: "Note", finding: "Soundness check: could a pruned bucket take reports again?", rule: "It cannot: a bucket's reports close before pruning opens.", sections: ["3"], test: "audit2_a_pruned_bucket_cannot_come_back", status: "Closed" },
];

export const LIMITS: Limit[] = [
  { id: "2.2, 3.x", severity: "High", status: "Open", limit: "A reporter can make a series void while another is absent (by disagreeing in every bucket), and a void series pays both sides half the band. A reporter who trades can buy the side that has become cheap after a move, then force the void.", shows: "10 SHORT bought at 0.10 pay 0.20 each: +1.00 $; in the second test a SHORT bought at 0.04 pays 0.20: +15.90 $ on 100 units at a 0.40 $ band", deployed: "up to 0.299 $ a unit at the 0.60 $ band", sections: ["10", "15"], test: "limit_forcing_a_void_pays_a_reporter_half_the_band_for_a_cheap_side" },
  { id: "3.x", severity: "High", status: "Open", limit: "The same, sized at the deployed band: a trading reporter who forces a void gains up to the distance between the price it paid and the centre of the band.", shows: "up to 0.299 $ a unit at the deployed 0.60 $ band", sections: ["10", "15"], test: "limit_a_trading_reporter_forces_a_void_for_up_to_0_299_a_unit_at_the_deployed_band" },
  { id: "2.1", severity: "High", status: "Open", limit: "With one reporter absent, one dishonest reporter chooses which buckets print and leans each print by up to half the spread tolerance.", shows: "true average 2.000000, fixing 2.121000 from the 10 buckets it let through", deployed: "up to 25% of the hours dropped and every print leaned 1%", sections: ["9", "15"], test: "limit_one_reporter_selects_which_buckets_print" },
  { id: "2.3", severity: "High", status: "Open", limit: "A round can be blocked by filling every slot; each slot costs the commit fee. The blocker also chooses the price of every trade in that round.", shows: "64 slots at the test's 0.02 $ fixture: 1.28 $ a round", sections: ["15"], test: "limit_blocking_a_round_costs_1_28_dollars" },
  { id: "2.4", severity: "Medium", status: "Stated", limit: "An account that has not set max_round_lock can be burned by its own agent, one forfeit and fee per round.", shows: "100 $ falls to 90.25 $ in 10 rounds at a 1% forfeit", sections: ["15"], test: "limit_an_account_without_a_round_lock_limit_can_be_burned" },
  { id: "2.5", severity: "Medium", status: "Stated", limit: "The last look: a late revealer has seen the others and can choose not to reveal, which changes who else is filled.", shows: "the clearing moves from 0.150 to 0.225", sections: ["11", "15"], test: "limit_last_look_a_non_reveal_changes_another_accounts_fill" },
  { id: "2.6", severity: "Low", status: "Stated", limit: "One account can take a series' whole mint cap.", shows: "the next minter is refused with too many sets; auctions still clear", sections: ["8"], test: "limit_one_account_can_take_the_whole_mint_cap" },
  { id: "2.7", severity: "Medium", status: "Stated", limit: "The contract accepts unwise parameters: a 100% spread, two reporters, no fee and no forfeit.", shows: "a 100% spread lets one of two reporters print 3.0 for a true 2.0", sections: ["3", "15"], test: "limit_unwise_parameters_are_still_accepted" },
  { id: "2.8-2.11", severity: "Low, Note", status: "Open", limit: "Four smaller points found by reading and not measured: many pending buckets under a large grace, pruning delivery reports before a late settlement, no age check on the guard's reference, and get_prints missing prints after pruning.", shows: "no test", sections: ["9", "12"], test: null },
];

/** How the void rule changed between passes: one fix was itself found faulty and replaced. */
export const HISTORY: { spec: string; rule: string; review: string }[] = [
  { spec: "0.3 and 0.4", rule: "A void series settled on the prints it had, or at mid-band with none.", review: "Second pass (2.2): one reporter could force a void at mid-band and profit." },
  { spec: "0.5", rule: "A void series paid each side at the average price its own auctions had traded at.", review: "Third pass (3.1, critical): wash trades in a blocked round set that average anywhere in the band. The fix was faulty." },
  { spec: "0.6", rule: "A void series is cancelled at the centre of its band: half the band to every LONG and every SHORT, whatever was traded.", review: "Replaces the 0.5 rule; the authors' test now asserts the wash trade no longer moves the payout. A reporter who also trades can still profit from causing a void (open, above). The reviewer's own note on 0.6 is not yet in docs/AUDIT.md." },
];

export const VERDICT = {
  testnet: "Fit for a public testnet with test dollars: the accounting held exact through three passes.",
  real: "Not fit for real dollars in its 0.5 form: the void rule could be steered (3.1, since replaced in 0.6), the reporters decide the fixing, and a round can be blocked for a few dollars.",
};

export const specHref = (section: string) => `/spec#s${section.replace(/\./g, "-")}`;
export const auditHref = (anchor?: string) => `/audit${anchor ? `#${anchor}` : ""}`;
