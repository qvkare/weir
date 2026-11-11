// The independent review of the contract (contracts/README.md, "Audit"; the tests in
// contracts/weir/tests/audit_findings.rs). Each finding, the rule of SPEC 0.4 that closes it,
// the spec sections, and the test that now asserts the attack fails.

export interface AuditFinding {
  n: number;
  finding: string;
  rule: string;
  /** SPEC section numbers, linked to /spec. */
  sections: string[];
  test: string;
}

export const AUDIT_FINDINGS: AuditFinding[] = [
  { n: 1, finding: "Changing the guard after a commit cancelled the order for free, after the book was seen.", rule: "The commit records the guard and its reference; reveal applies those.", sections: ["6.2", "6.4"], test: "audit_guard_change_after_commit_no_longer_cancels" },
  { n: 2, finding: "An agent holding only a function-call key could forfeit an account's dollars to a confederate.", rule: "Forfeits are burned; max_round_lock caps what one round can lock.", sections: ["7.3", "5", "6.2"], test: "audit_function_call_agent_can_no_longer_drain_a_guarded_account" },
  { n: 3, finding: "Evicting every rival from a round cost nothing.", rule: "Every commit pays commit_fee, burned at clearing: blocking a round costs max_commits times the fee.", sections: ["6.2"], test: "audit_eviction_griefing_now_costs_a_fee_per_slot" },
  { n: 4, finding: "One reporter could ratchet the index by up to max_move per print.", rule: "With every reporter the print is the median; with an even count the two middle reports must agree within max_spread_bps.", sections: ["9"], test: "audit_one_reporter_can_no_longer_steer_the_index" },
  { n: 5, finding: "One silent reporter froze the index after a large move.", rule: "No move limit: two agreeing reporters make a print once the window closes.", sections: ["9"], test: "audit_a_silent_reporter_can_no_longer_freeze_the_index" },
  { n: 6, finding: "Reporting out of order bypassed the move limit.", rule: "Nothing compares a print with earlier prints, so there is nothing to bypass.", sections: ["9"], test: "audit_reporting_out_of_order_no_longer_bypasses_anything" },
  { n: 7, finding: "Minting u64::MAX sets made clear overflow and froze the series.", rule: "mint stops at 2^53 - 1 less what the series' auctions can still add.", sections: ["8"], test: "audit_open_sets_can_no_longer_overflow" },
  { n: 8, finding: "Storage the contract pays for grew without bound.", rule: "Results keep only filled orders; prune_print and prune_result release prints and results.", sections: ["12", "14"], test: "audit_storage_bytes_per_object_and_pruning" },
];

export const AUDIT_TEST_FILE = "contracts/weir/tests/audit_findings.rs";

export const specHref = (section: string) => `/spec#s${section.replace(/\./g, "-")}`;
