//! Section 9: how a bucket's reports become a print, or no print.

use crate::types::PrintState;

/// The price a decided bucket gets, or `None` for no print. `reports` need not be
/// sorted.
pub fn decide(reports: &[u64], quorum: u32, max_spread_bps: u32) -> Option<u64> {
    if (reports.len() as u64) < u64::from(quorum) || reports.is_empty() {
        return None;
    }
    let mut sorted = reports.to_vec();
    sorted.sort_unstable();
    let n = sorted.len();
    if n % 2 == 1 {
        return Some(sorted[n / 2]);
    }
    let (lo, hi) = (u128::from(sorted[n / 2 - 1]), u128::from(sorted[n / 2]));
    if (hi - lo) * 10_000 > lo * u128::from(max_spread_bps) {
        return None;
    }
    // At most `hi`, so it fits.
    Some(((lo + hi) / 2) as u64)
}

/// The state a bucket is in: undecided until every reporter has reported or its
/// report window has closed and someone decides it.
pub fn state(reports: &[u64], quorum: u32, reporters: u32, max_spread_bps: u32, window_closed: bool) -> (PrintState, Option<u64>) {
    if reports.len() as u64 != u64::from(reporters) && !window_closed {
        return (PrintState::Open, None);
    }
    match decide(reports, quorum, max_spread_bps) {
        Some(price) => (PrintState::Final, Some(price)),
        None => (PrintState::NoPrint, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn below_quorum_is_no_print() {
        assert_eq!(decide(&[], 1, 10_000), None);
        assert_eq!(decide(&[5], 2, 10_000), None);
        assert_eq!(decide(&[5], 1, 0), Some(5));
    }

    #[test]
    fn an_odd_count_takes_the_middle_report() {
        assert_eq!(decide(&[9, 1, 5], 2, 0), Some(5));
        // One wild report out of three cannot move it.
        assert_eq!(decide(&[2_000_000, 2_000_000, 400_000_000], 2, 1), Some(2_000_000));
    }

    #[test]
    fn an_even_count_needs_the_middle_two_within_the_spread() {
        // 1% of 2_000_000 is 20_000.
        assert_eq!(decide(&[2_000_000, 2_020_000], 2, 100), Some(2_010_000));
        assert_eq!(decide(&[2_000_000, 2_020_001], 2, 100), None);
        assert_eq!(decide(&[4, 1, 3, 2], 4, 10_000), Some(2));
        assert_eq!(decide(&[u64::MAX, u64::MAX], 2, 0), Some(u64::MAX));
    }

    #[test]
    fn a_bucket_stays_open_until_everyone_reports_or_its_window_closes() {
        assert_eq!(state(&[5, 5], 2, 3, 100, false), (PrintState::Open, None));
        assert_eq!(state(&[5, 5, 6], 2, 3, 100, false), (PrintState::Final, Some(5)));
        assert_eq!(state(&[5, 5], 2, 3, 100, true), (PrintState::Final, Some(5)));
        assert_eq!(state(&[5], 2, 3, 100, true), (PrintState::NoPrint, None));
    }
}
