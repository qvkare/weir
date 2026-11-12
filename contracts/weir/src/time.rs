//! Section 4: when a series delivers, when its auctions run and which phase a round
//! is in. Phases come from the clock alone.

use near_sdk::near;

use crate::ERR_OVERFLOW;

/// `get_status` lists at most this many series. Windows overlap only when
/// `lead_secs` exceeds a period, so real parameters give one or two.
pub const MAX_LIVE_SERIES: usize = 32;

#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Commit,
    Reveal,
    Closed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Schedule {
    pub t0: u64,
    pub period_secs: u64,
    pub lead_secs: u64,
    pub cutoff_secs: u64,
    pub commit_secs: u64,
    pub reveal_secs: u64,
}

fn add(a: u64, b: u64) -> u64 {
    a.checked_add(b).expect(ERR_OVERFLOW)
}

impl Schedule {
    fn try_delivery_start(&self, series: u32) -> Option<u64> {
        u64::from(series)
            .checked_mul(self.period_secs)?
            .checked_add(self.t0)
    }

    pub fn delivery_start(&self, series: u32) -> u64 {
        self.try_delivery_start(series).expect(ERR_OVERFLOW)
    }

    pub fn delivery_end(&self, series: u32) -> u64 {
        add(self.delivery_start(series), self.period_secs)
    }

    pub fn auction_open(&self, series: u32) -> u64 {
        self.delivery_start(series).saturating_sub(self.lead_secs)
    }

    /// Auctions end before delivery starts: this is a week-ahead market.
    pub fn auction_close(&self, series: u32) -> u64 {
        self.delivery_start(series).saturating_sub(self.cutoff_secs)
    }

    pub fn round_secs(&self) -> u64 {
        add(self.commit_secs, self.reveal_secs)
    }

    pub fn round_start(&self, series: u32, round: u64) -> u64 {
        let offset = round.checked_mul(self.round_secs()).expect(ERR_OVERFLOW);
        add(self.auction_open(series), offset)
    }

    pub fn reveal_start(&self, series: u32, round: u64) -> u64 {
        add(self.round_start(series, round), self.commit_secs)
    }

    pub fn round_end(&self, series: u32, round: u64) -> u64 {
        add(self.round_start(series, round), self.round_secs())
    }

    /// A round past the end of the window does not exist, however large its number.
    pub fn round_exists(&self, series: u32, round: u64) -> bool {
        let close = self.auction_close(series);
        round
            .checked_mul(self.round_secs())
            .and_then(|offset| offset.checked_add(self.auction_open(series)))
            .and_then(|start| start.checked_add(self.round_secs()))
            .is_some_and(|end| end <= close)
    }

    pub fn in_window(&self, series: u32, now: u64) -> bool {
        self.auction_open(series) <= now && now < self.auction_close(series)
    }

    /// The round whose commit or reveal phase contains `now`. `Closed` with no round
    /// when `now` is outside the auction window or past its last whole round.
    pub fn current(&self, series: u32, now: u64) -> (Option<u64>, Phase) {
        if !self.in_window(series, now) {
            return (None, Phase::Closed);
        }
        let round = (now - self.auction_open(series)) / self.round_secs();
        if !self.round_exists(series, round) {
            return (None, Phase::Closed);
        }
        if now < self.reveal_start(series, round) {
            (Some(round), Phase::Commit)
        } else {
            (Some(round), Phase::Reveal)
        }
    }

    /// Every series whose auction window contains `now`, lowest first. Windows are
    /// ordered: both ends grow with the series number.
    pub fn live_series(&self, now: u64) -> Vec<u32> {
        // close(s) > now  <=>  s * period > now + cutoff - t0
        let first = match now.saturating_add(self.cutoff_secs).checked_sub(self.t0) {
            Some(gap) => gap / self.period_secs + 1,
            None => 0,
        };
        let Ok(first) = u32::try_from(first) else {
            return Vec::new();
        };
        (first..=u32::MAX)
            .take(MAX_LIVE_SERIES)
            .take_while(|&s| {
                self.try_delivery_start(s)
                    .and_then(|start| start.checked_add(self.period_secs))
                    .is_some()
                    && self.in_window(s, now)
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Series 0 delivers over [10_000, 11_000). Its auction runs over [8_900, 9_900),
    /// in rounds of 100 seconds: 10 of them. lead = period + cutoff, so the windows
    /// of consecutive series meet.
    const S: Schedule = Schedule {
        t0: 10_000,
        period_secs: 1_000,
        lead_secs: 1_100,
        cutoff_secs: 100,
        commit_secs: 60,
        reveal_secs: 40,
    };

    #[test]
    fn formulas() {
        assert_eq!(S.delivery_start(0), 10_000);
        assert_eq!(S.delivery_end(0), 11_000);
        assert_eq!(S.auction_open(0), 8_900);
        assert_eq!(S.auction_close(0), 9_900);
        assert_eq!(S.delivery_start(3), 13_000);
        assert_eq!(S.auction_close(3), 12_900);
        assert_eq!(S.round_start(0, 2), 9_100);
        assert_eq!(S.reveal_start(0, 2), 9_160);
        assert_eq!(S.round_end(0, 2), 9_200);
    }

    #[test]
    fn open_and_close_saturate_at_zero() {
        let s = Schedule { t0: 50, ..S };
        assert_eq!(s.auction_open(0), 0);
        assert_eq!(s.auction_close(0), 0);
        assert_eq!(s.current(0, 0), (None, Phase::Closed));
    }

    #[test]
    fn a_zero_cutoff_runs_auctions_until_delivery() {
        let s = Schedule {
            cutoff_secs: 0,
            ..S
        };
        assert_eq!(s.auction_close(0), 10_000);
        assert_eq!(s.current(0, 9_999), (Some(10), Phase::Reveal));
        assert_eq!(s.current(0, 10_000), (None, Phase::Closed));
    }

    #[test]
    fn last_round_must_end_by_close() {
        assert!(S.round_exists(0, 9));
        assert!(!S.round_exists(0, 10));
        assert!(!S.round_exists(0, u64::MAX));
        let ragged = Schedule {
            cutoff_secs: 150,
            ..S
        };
        assert!(ragged.round_exists(0, 8));
        assert!(!ragged.round_exists(0, 9));
    }

    #[test]
    fn phases_change_at_the_exact_second() {
        assert_eq!(S.current(0, 8_899), (None, Phase::Closed));
        assert_eq!(S.current(0, 8_900), (Some(0), Phase::Commit));
        assert_eq!(S.current(0, 8_959), (Some(0), Phase::Commit));
        assert_eq!(S.current(0, 8_960), (Some(0), Phase::Reveal));
        assert_eq!(S.current(0, 8_999), (Some(0), Phase::Reveal));
        assert_eq!(S.current(0, 9_000), (Some(1), Phase::Commit));
        assert_eq!(S.current(0, 9_899), (Some(9), Phase::Reveal));
        assert_eq!(S.current(0, 9_900), (None, Phase::Closed));
        assert_eq!(S.current(1, 9_900), (Some(0), Phase::Commit));
    }

    #[test]
    fn the_tail_after_the_last_whole_round_is_closed() {
        let ragged = Schedule {
            cutoff_secs: 150,
            ..S
        };
        assert_eq!(ragged.current(0, 9_799), (Some(8), Phase::Reveal));
        assert_eq!(ragged.current(0, 9_800), (None, Phase::Closed));
        assert_eq!(ragged.current(0, 9_849), (None, Phase::Closed));
    }

    #[test]
    fn live_series_follow_each_other_or_overlap_with_a_long_lead() {
        assert_eq!(S.live_series(8_899), Vec::<u32>::new());
        assert_eq!(S.live_series(8_900), vec![0]);
        assert_eq!(S.live_series(9_899), vec![0]);
        assert_eq!(S.live_series(9_900), vec![1]);
        let gap = Schedule {
            lead_secs: 500,
            ..S
        };
        assert_eq!(gap.live_series(9_000), Vec::<u32>::new());
        let long_lead = Schedule {
            lead_secs: 2_500,
            ..S
        };
        assert_eq!(long_lead.live_series(9_000), vec![0, 1]);
        let tiny = Schedule {
            period_secs: 1,
            lead_secs: 1_000,
            cutoff_secs: 0,
            ..S
        };
        assert_eq!(tiny.live_series(20_000).len(), MAX_LIVE_SERIES);
    }

    #[test]
    #[should_panic(expected = "arithmetic overflow")]
    fn a_series_past_the_end_of_time_overflows() {
        let s = Schedule {
            period_secs: u64::MAX / 2,
            ..S
        };
        s.delivery_start(3);
    }
}
