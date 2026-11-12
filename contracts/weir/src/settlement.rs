//! Section 6.1 (the band a series opens with) and section 10 (what a unit pays).

use crate::{ERR_BAND_TOO_NARROW, ERR_BAND_TOO_WIDE, ERR_NOT_ENOUGH_PRINTS, ERR_OVERFLOW};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Band {
    pub mid: u64,
    pub half: u64,
    pub floor: u64,
    pub band: u64,
}

pub fn band(anchor: u64, tick: u64, band_bps: u32) -> Result<Band, &'static str> {
    let mid = anchor - anchor % tick;
    // anchor * band_bps / 10_000 < anchor, since band_bps < 10_000, so it fits.
    let raw = (u128::from(anchor) * u128::from(band_bps) / 10_000) as u64;
    let half = raw - raw % tick;
    if half < tick {
        return Err(ERR_BAND_TOO_NARROW);
    }
    if half > mid {
        return Err(ERR_BAND_TOO_WIDE);
    }
    Ok(Band {
        mid,
        half,
        floor: mid - half,
        band: half.checked_mul(2).ok_or(ERR_OVERFLOW)?,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SettleInput {
    pub floor: u64,
    pub band: u64,
    /// The series' accumulator.
    pub sum: u128,
    pub count: u32,
    /// `now >= delivery_end + void_after_secs`.
    pub void_allowed: bool,
    pub min_prints: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Settlement {
    pub fixing: u64,
    pub long_payout: u64,
    pub short_payout: u64,
    pub void: bool,
}

/// Section 10, `redeem`: `long * long_payout + short * short_payout`.
pub fn payout(
    long: u64,
    short: u64,
    long_payout: u64,
    short_payout: u64,
) -> Result<u128, &'static str> {
    // Each product fits a u128; only their sum can overflow, and only far beyond
    // anything `mint`'s cap allows.
    (u128::from(long) * u128::from(long_payout))
        .checked_add(u128::from(short) * u128::from(short_payout))
        .ok_or(ERR_OVERFLOW)
}

/// Section 10. A void series is cancelled at the centre of its band: what was traded
/// and any partial prints are deliberately not inputs, so nobody can move it.
pub fn settle(input: SettleInput) -> Result<Settlement, &'static str> {
    let (long_payout, fixing, void) = if input.count >= input.min_prints {
        let fixing =
            u64::try_from(input.sum / u128::from(input.count)).map_err(|_| ERR_OVERFLOW)?;
        (
            fixing.saturating_sub(input.floor).min(input.band),
            fixing,
            false,
        )
    } else if input.void_allowed {
        let long_payout = input.band / 2;
        (long_payout, input.floor + long_payout, true)
    } else {
        return Err(ERR_NOT_ENOUGH_PRINTS);
    };
    Ok(Settlement {
        fixing,
        long_payout,
        short_payout: input.band - long_payout,
        void,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const INPUT: SettleInput = SettleInput {
        floor: 1_800_000,
        band: 400_000,
        sum: 0,
        count: 0,
        void_allowed: false,
        min_prints: 3,
    };

    #[test]
    fn band_from_an_anchor() {
        // 2.0345 $/h, tick 0.001, 10%: mid 2.034, half 0.203, floor 1.831, band 0.406.
        assert_eq!(
            band(2_034_500, 1_000, 1_000),
            Ok(Band {
                mid: 2_034_000,
                half: 203_000,
                floor: 1_831_000,
                band: 406_000
            })
        );
    }

    #[test]
    fn band_narrower_than_a_tick_panics() {
        assert_eq!(band(9_999, 1_000, 1_000), Err(ERR_BAND_TOO_NARROW));
        assert_eq!(
            band(10_000, 1_000, 1_000),
            Ok(Band {
                mid: 10_000,
                half: 1_000,
                floor: 9_000,
                band: 2_000
            })
        );
    }

    #[test]
    fn half_never_exceeds_mid() {
        // `half > mid` is checked because section 6.1 names it, but it cannot happen:
        // band_bps < 10_000 makes the raw half smaller than the anchor, and rounding
        // both down to a tick keeps that order. The widest band reaches floor 0.
        assert_eq!(band(3_999, 1_000, 9_999).unwrap().floor, 0);
        assert_eq!(band(11_999, 4_000, 9_999).unwrap().floor, 0);
        for anchor in 1..3_000 {
            for tick in [1, 7, 100, 999] {
                if let Ok(b) = band(anchor, tick, 9_999) {
                    assert!(b.half <= b.mid);
                }
            }
        }
    }

    #[test]
    fn normal_settlement_at_min_prints() {
        let s = settle(SettleInput {
            sum: 6_000_000,
            count: 3,
            ..INPUT
        })
        .unwrap();
        assert_eq!(
            (s.fixing, s.long_payout, s.short_payout, s.void),
            (2_000_000, 200_000, 200_000, false)
        );
        assert_eq!(
            settle(SettleInput {
                sum: 4_000_000,
                count: 2,
                ..INPUT
            }),
            Err(ERR_NOT_ENOUGH_PRINTS)
        );
    }

    #[test]
    fn fixing_rounds_down_and_payouts_clamp() {
        let s = settle(SettleInput {
            sum: 7,
            count: 3,
            ..INPUT
        })
        .unwrap();
        assert_eq!((s.fixing, s.long_payout, s.short_payout), (2, 0, 400_000));
        let s = settle(SettleInput {
            sum: 9_000_000,
            count: 3,
            ..INPUT
        })
        .unwrap();
        assert_eq!(
            (s.fixing, s.long_payout, s.short_payout),
            (3_000_000, 400_000, 0)
        );
        let s = settle(SettleInput {
            sum: 5_400_002,
            count: 3,
            ..INPUT
        })
        .unwrap();
        assert_eq!((s.fixing, s.long_payout), (1_800_000, 0));
    }

    #[test]
    fn void_pays_the_centre_of_the_band_whatever_the_partial_prints() {
        let s = settle(SettleInput {
            sum: 4_100_001,
            count: 2,
            void_allowed: true,
            ..INPUT
        })
        .unwrap();
        assert_eq!(
            (s.fixing, s.long_payout, s.short_payout, s.void),
            (2_000_000, 200_000, 200_000, true)
        );
        let s = settle(SettleInput {
            void_allowed: true,
            ..INPUT
        })
        .unwrap();
        assert_eq!(
            (s.fixing, s.long_payout, s.short_payout, s.void),
            (2_000_000, 200_000, 200_000, true)
        );
    }

    #[test]
    fn enough_prints_is_never_void() {
        let s = settle(SettleInput {
            sum: 6_000_000,
            count: 3,
            void_allowed: true,
            ..INPUT
        })
        .unwrap();
        assert!(!s.void);
    }

    #[test]
    fn payout_pays_each_side_its_share_of_the_band() {
        assert_eq!(payout(2, 1, 250_000, 150_000), Ok(650_000));
        assert_eq!(
            payout(u64::MAX, u64::MAX, u64::MAX, u64::MAX),
            Err(ERR_OVERFLOW)
        );
    }
}
