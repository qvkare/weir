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
    pub open_sets: u64,
    /// The series' bonus pool plus the carry pool.
    pub pool: u128,
    /// `now >= delivery_end + void_after_secs`.
    pub void_allowed: bool,
    pub min_prints: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Settlement {
    pub fixing: u64,
    pub long_payout: u64,
    pub short_payout: u64,
    pub bonus_long: u128,
    pub bonus_short: u128,
    /// The new carry pool.
    pub carry: u128,
    pub void: bool,
}

/// Section 10, `redeem`: `long * (long_payout + bonus_long) + short * (short_payout +
/// bonus_short)`.
pub fn payout(
    long: u64,
    short: u64,
    long_payout: u64,
    short_payout: u64,
    bonus_long: u128,
    bonus_short: u128,
) -> Result<u128, &'static str> {
    let leg = |units: u64, payout: u64, bonus: u128| {
        u128::from(payout)
            .checked_add(bonus)
            .and_then(|each| each.checked_mul(u128::from(units)))
    };
    leg(long, long_payout, bonus_long)
        .zip(leg(short, short_payout, bonus_short))
        .and_then(|(a, b)| a.checked_add(b))
        .ok_or(ERR_OVERFLOW)
}

pub fn settle(input: SettleInput) -> Result<Settlement, &'static str> {
    let average = || {
        u64::try_from(input.sum / u128::from(input.count)).map_err(|_| ERR_OVERFLOW)
    };
    let (fixing, void) = if input.count >= input.min_prints {
        (average()?, false)
    } else if input.void_allowed {
        let fixing = if input.count >= 1 {
            average()?
        } else {
            input.floor + input.band / 2
        };
        (fixing, true)
    } else {
        return Err(ERR_NOT_ENOUGH_PRINTS);
    };

    let long_payout = fixing.saturating_sub(input.floor).min(input.band);
    let short_payout = input.band - long_payout;

    let (bonus_long, bonus_short, carry) = if input.open_sets > 0 {
        let sets = u128::from(input.open_sets);
        let per_set = input.pool / sets;
        let bonus_long = per_set / 2;
        (bonus_long, per_set - bonus_long, input.pool - per_set * sets)
    } else {
        (0, 0, input.pool)
    };

    Ok(Settlement {
        fixing,
        long_payout,
        short_payout,
        bonus_long,
        bonus_short,
        carry,
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
        open_sets: 10,
        pool: 0,
        void_allowed: false,
        min_prints: 3,
    };

    #[test]
    fn band_from_an_anchor() {
        // 2.0345 $/h, tick 0.001, 10%: mid 2.034, half 0.203, floor 1.831, band 0.406.
        assert_eq!(
            band(2_034_500, 1_000, 1_000),
            Ok(Band { mid: 2_034_000, half: 203_000, floor: 1_831_000, band: 406_000 })
        );
    }

    #[test]
    fn band_narrower_than_a_tick_panics() {
        assert_eq!(band(9_999, 1_000, 1_000), Err(ERR_BAND_TOO_NARROW));
        assert_eq!(band(10_000, 1_000, 1_000), Ok(Band { mid: 10_000, half: 1_000, floor: 9_000, band: 2_000 }));
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
        let s = settle(SettleInput { sum: 6_000_000, count: 3, ..INPUT }).unwrap();
        assert_eq!((s.fixing, s.long_payout, s.short_payout, s.void), (2_000_000, 200_000, 200_000, false));
        assert_eq!(settle(SettleInput { sum: 4_000_000, count: 2, ..INPUT }), Err(ERR_NOT_ENOUGH_PRINTS));
    }

    #[test]
    fn fixing_rounds_down_and_payouts_clamp() {
        let s = settle(SettleInput { sum: 7, count: 3, ..INPUT }).unwrap();
        assert_eq!((s.fixing, s.long_payout, s.short_payout), (2, 0, 400_000));
        let s = settle(SettleInput { sum: 9_000_000, count: 3, ..INPUT }).unwrap();
        assert_eq!((s.fixing, s.long_payout, s.short_payout), (3_000_000, 400_000, 0));
        let s = settle(SettleInput { sum: 5_400_002, count: 3, ..INPUT }).unwrap();
        assert_eq!((s.fixing, s.long_payout), (1_800_000, 0));
    }

    #[test]
    fn void_with_some_prints_uses_their_average() {
        let s = settle(SettleInput { sum: 4_100_001, count: 2, void_allowed: true, ..INPUT }).unwrap();
        assert_eq!((s.fixing, s.long_payout, s.void), (2_050_000, 250_000, true));
    }

    #[test]
    fn void_with_no_prints_fixes_mid_band() {
        let s = settle(SettleInput { void_allowed: true, ..INPUT }).unwrap();
        assert_eq!((s.fixing, s.long_payout, s.short_payout, s.void), (2_000_000, 200_000, 200_000, true));
    }

    #[test]
    fn enough_prints_is_never_void() {
        let s = settle(SettleInput { sum: 6_000_000, count: 3, void_allowed: true, ..INPUT }).unwrap();
        assert!(!s.void);
    }

    #[test]
    fn bonus_splits_per_set_and_carries_the_remainder() {
        let s = settle(SettleInput { sum: 6_000_000, count: 3, pool: 1_007, ..INPUT }).unwrap();
        // per_set = 100, carry 7; LONG gets 50, SHORT 50.
        assert_eq!((s.bonus_long, s.bonus_short, s.carry), (50, 50, 7));
        let s = settle(SettleInput { sum: 6_000_000, count: 3, pool: 1_019, ..INPUT }).unwrap();
        // per_set = 101: the odd unit goes to SHORT.
        assert_eq!((s.bonus_long, s.bonus_short, s.carry), (50, 51, 9));
        let pay = |long, short| payout(long, short, s.long_payout, s.short_payout, s.bonus_long, s.bonus_short);
        assert_eq!(pay(2, 1), Ok(2 * 200_050 + 200_051));
        assert_eq!(pay(1, 1), Ok(400_000 + 101));
        assert_eq!(payout(u64::MAX, 0, u64::MAX, 0, u128::MAX, 0), Err(ERR_OVERFLOW));
    }

    #[test]
    fn no_open_sets_carries_the_whole_pool() {
        let s = settle(SettleInput { sum: 6_000_000, count: 3, pool: 999, open_sets: 0, ..INPUT }).unwrap();
        assert_eq!((s.bonus_long, s.bonus_short, s.carry), (0, 0, 999));
    }
}
