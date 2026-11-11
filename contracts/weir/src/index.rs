//! Section 9: the median of a bucket's reports, and whether it becomes a print.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Decision {
    pub candidate: u64,
    pub is_final: bool,
}

/// Even count: the mean of the two middle values, rounded down. Panics on an empty
/// slice; a bucket's print always has the report that was just stored.
pub fn median(reports: &[u64]) -> u64 {
    let mut sorted = reports.to_vec();
    sorted.sort_unstable();
    let n = sorted.len();
    if n % 2 == 1 {
        sorted[n / 2]
    } else {
        ((u128::from(sorted[n / 2 - 1]) + u128::from(sorted[n / 2])) / 2) as u64
    }
}

/// `|candidate - last| * 10000 > last * max_move_bps`, in `u128` so neither side
/// can overflow.
pub fn is_far(candidate: u64, last: u64, max_move_bps: u32) -> bool {
    u128::from(candidate.abs_diff(last)) * 10_000 > u128::from(last) * u128::from(max_move_bps)
}

/// `last` is the last print's price, and only when its bucket is lower than this
/// one; the caller passes `None` otherwise.
pub fn decide(
    reports: &[u64],
    last: Option<u64>,
    quorum: u32,
    reporters: u32,
    max_move_bps: u32,
) -> Decision {
    let candidate = median(reports);
    let far = last.is_some_and(|last| is_far(candidate, last, max_move_bps));
    let n = reports.len() as u64;
    let is_final = (n >= u64::from(quorum) && !far) || n == u64::from(reporters);
    Decision { candidate, is_final }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn median_odd_and_even() {
        assert_eq!(median(&[5]), 5);
        assert_eq!(median(&[9, 1, 5]), 5);
        assert_eq!(median(&[4, 1]), 2);
        assert_eq!(median(&[1, 2, 3, 10]), 2);
        assert_eq!(median(&[u64::MAX, u64::MAX]), u64::MAX);
    }

    #[test]
    fn far_is_strictly_beyond_the_move() {
        // 10% of 1_000_000 is 100_000.
        assert!(!is_far(1_100_000, 1_000_000, 1_000));
        assert!(is_far(1_100_001, 1_000_000, 1_000));
        assert!(!is_far(900_000, 1_000_000, 1_000));
        assert!(is_far(899_999, 1_000_000, 1_000));
    }

    #[test]
    fn quorum_finalizes_a_near_print() {
        let d = decide(&[1_000_000, 1_010_000], Some(1_000_000), 2, 3, 1_000);
        assert_eq!(d, Decision { candidate: 1_005_000, is_final: true });
        assert!(!decide(&[1_000_000], Some(1_000_000), 2, 3, 1_000).is_final);
    }

    #[test]
    fn a_far_print_needs_every_reporter() {
        assert!(!decide(&[2_000_000, 2_000_000], Some(1_000_000), 2, 3, 1_000).is_final);
        assert!(decide(&[2_000_000, 2_000_000, 2_000_000], Some(1_000_000), 2, 3, 1_000).is_final);
    }

    #[test]
    fn no_last_print_is_never_far() {
        assert!(decide(&[2_000_000, 2_000_000], None, 2, 3, 0).is_final);
    }
}
