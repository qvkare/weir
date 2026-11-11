//! Sections 7.1 and 7.2: one price for a round, and who is filled at it.

use std::cmp::Reverse;

use crate::types::Side;
use crate::ERR_OVERFLOW;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Order {
    pub seq: u32,
    pub side: Side,
    pub size: u64,
    /// Always a LONG price, a multiple of the tick.
    pub price: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Clearing {
    /// `p*`, or `None` when no candidate trades anything.
    pub price: Option<u64>,
    /// `V*`.
    pub volume: u64,
    /// `fills[i]` belongs to `orders[i]`.
    pub fills: Vec<u64>,
}

/// `D(p)` and `S(p)`. Sizes are summed in `u128`, so this cannot overflow.
pub fn depth(orders: &[Order], price: u64) -> (u128, u128) {
    orders.iter().fold((0, 0), |(demand, supply), order| match order.side {
        Side::Long if order.price >= price => (demand + u128::from(order.size), supply),
        Side::Short if order.price <= price => (demand, supply + u128::from(order.size)),
        _ => (demand, supply),
    })
}

/// `V(p)`.
pub fn volume_at(orders: &[Order], price: u64) -> u128 {
    let (demand, supply) = depth(orders, price);
    demand.min(supply)
}

pub fn clear(orders: &[Order], tick: u64) -> Clearing {
    let mut candidates: Vec<u64> = orders.iter().map(|order| order.price).collect();
    candidates.sort_unstable();
    candidates.dedup();

    // Step 1: the candidates with the largest V, ascending by price.
    let mut best_volume = 0;
    let mut best: Vec<(u64, u128, u128)> = Vec::new();
    for price in candidates {
        let (demand, supply) = depth(orders, price);
        let volume = demand.min(supply);
        if volume > best_volume {
            best_volume = volume;
            best.clear();
        }
        if volume == best_volume {
            best.push((price, demand, supply));
        }
    }
    if best_volume == 0 {
        return Clearing {
            price: None,
            volume: 0,
            fills: vec![0; orders.len()],
        };
    }

    // Step 2: of those, the smallest imbalance.
    let least_imbalance = best
        .iter()
        .map(|&(_, demand, supply)| demand.abs_diff(supply))
        .min()
        .unwrap_or_default();
    best.retain(|&(_, demand, supply)| demand.abs_diff(supply) == least_imbalance);

    // Step 3.
    let lo = best[0].0;
    let hi = best[best.len() - 1].0;
    let price = if best.iter().all(|&(_, demand, supply)| demand > supply) {
        hi
    } else if best.iter().all(|&(_, demand, supply)| demand < supply) {
        lo
    } else {
        let mid = (u128::from(lo) + u128::from(hi)) / 2;
        // At most `hi`, so it fits.
        (mid - mid % u128::from(tick)) as u64
    };

    let volume = u64::try_from(best_volume).expect(ERR_OVERFLOW);
    let mut fills = vec![0; orders.len()];
    fill_side(orders, &mut fills, volume, Side::Long, price);
    fill_side(orders, &mut fills, volume, Side::Short, price);
    Clearing {
        price: Some(price),
        volume,
        fills,
    }
}

/// Section 7.2: best price first, then lowest `seq`, until `volume` is filled.
fn fill_side(orders: &[Order], fills: &mut [u64], volume: u64, side: Side, price: u64) {
    let mut queue: Vec<usize> = (0..orders.len())
        .filter(|&i| {
            let order = &orders[i];
            order.side == side
                && match side {
                    Side::Long => order.price >= price,
                    Side::Short => order.price <= price,
                }
        })
        .collect();
    match side {
        Side::Long => queue.sort_by_key(|&i| (Reverse(orders[i].price), orders[i].seq, i)),
        Side::Short => queue.sort_by_key(|&i| (orders[i].price, orders[i].seq, i)),
    }
    let mut left = volume;
    for i in queue {
        if left == 0 {
            break;
        }
        let fill = orders[i].size.min(left);
        fills[i] = fill;
        left -= fill;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TICK: u64 = 1_000;

    fn long(seq: u32, size: u64, ticks: u64) -> Order {
        Order { seq, side: Side::Long, size, price: ticks * TICK }
    }

    fn short(seq: u32, size: u64, ticks: u64) -> Order {
        Order { seq, side: Side::Short, size, price: ticks * TICK }
    }

    fn run(orders: &[Order]) -> (Option<u64>, u64, Vec<u64>) {
        let c = clear(orders, TICK);
        (c.price.map(|p| p / TICK), c.volume, c.fills)
    }

    #[test]
    fn nothing_trades_without_both_sides_crossing() {
        assert_eq!(run(&[]), (None, 0, vec![]));
        assert_eq!(run(&[long(0, 5, 10)]), (None, 0, vec![0]));
        assert_eq!(run(&[short(0, 5, 10), short(1, 5, 9)]), (None, 0, vec![0, 0]));
        // The SHORT wants at least 11; the LONG pays at most 10.
        assert_eq!(run(&[long(0, 5, 10), short(1, 5, 11)]), (None, 0, vec![0, 0]));
    }

    #[test]
    fn crossing_at_one_price() {
        assert_eq!(run(&[long(0, 5, 10), short(1, 5, 10)]), (Some(10), 5, vec![5, 5]));
    }

    #[test]
    fn excess_demand_at_every_remaining_candidate_takes_hi() {
        // D=10, S=3 at both 8 and 12.
        let orders = [long(0, 10, 12), short(1, 3, 8)];
        assert_eq!(run(&orders), (Some(12), 3, vec![3, 3]));
    }

    #[test]
    fn excess_supply_at_every_remaining_candidate_takes_lo() {
        // D=3, S=10 at both 5 and 9.
        let orders = [short(0, 10, 5), long(1, 3, 9)];
        assert_eq!(run(&orders), (Some(5), 3, vec![3, 3]));
    }

    #[test]
    fn least_imbalance_narrows_the_candidates() {
        // V=3 at 8, 9 and 12; |D-S| is 17, 17 and 7, so only 12 remains.
        let orders = [long(0, 10, 12), short(1, 3, 8), long(2, 10, 9)];
        assert_eq!(run(&orders), (Some(12), 3, vec![3, 3, 0]));
    }

    #[test]
    fn mixed_imbalance_takes_the_midpoint_rounded_down_to_a_tick() {
        // D(7)=5 S(7)=5 and D(10)=5 S(10)=5: balanced at both, so the midpoint 8.5 -> 8.
        let orders = [long(0, 5, 10), short(1, 5, 7)];
        assert_eq!(run(&orders), (Some(8), 5, vec![5, 5]));
        let c = clear(&[long(0, 5, 10), short(1, 5, 7)], TICK);
        assert_eq!(c.price, Some(8_000));
    }

    #[test]
    fn partial_fill_goes_by_seq_at_equal_prices() {
        let orders = [long(3, 4, 10), long(1, 4, 10), short(2, 5, 10)];
        assert_eq!(run(&orders), (Some(10), 5, vec![1, 4, 5]));
    }

    #[test]
    fn better_prices_fill_first() {
        let orders = [long(0, 4, 10), long(1, 4, 12), short(2, 5, 9), short(3, 5, 8)];
        // D(8..=10)=8, S(8)=5, S(9)=10, S(10)=10, S(12)=10, D(12)=4.
        // V(8)=5, V(9)=8, V(10)=8, V(12)=4. V*=8 at 9 and 10, |D-S|=2 both, D<S -> lo=9.
        assert_eq!(run(&orders), (Some(9), 8, vec![4, 4, 3, 5]));
    }

    #[test]
    fn depth_counts_limits_inclusively() {
        let orders = [long(0, 2, 10), short(1, 3, 10)];
        assert_eq!(depth(&orders, 10_000), (2, 3));
        assert_eq!(depth(&orders, 10_001), (0, 3));
        assert_eq!(depth(&orders, 9_999), (2, 0));
        assert_eq!(volume_at(&orders, 10_000), 2);
    }
}
