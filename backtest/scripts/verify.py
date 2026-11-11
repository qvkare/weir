#!/usr/bin/env python3
"""Independent cross-check of results/summary.json.

Recomputes the headline numbers from data/derived/index.csv (and the index itself from
data/derived/providers.csv) with the Python 3.9 standard library only, without
importing anything from the TypeScript code, and exits non-zero on any mismatch beyond
rounding.

    python3 backtest/scripts/verify.py
"""

import csv
import datetime as dt
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DERIVED = os.path.join(ROOT, "data", "derived")
RESULTS = os.path.join(ROOT, "results")

TICK = 1000
GRID = [1000, 1500, 2000, 2500, 3000, 4000]
TARGET = 0.95
LEAD = 7
MAX_AGE = 3
MIN_PRINTS = 4
HOURS = 1344
SHIFTS = [-0.05, -0.02, 0.0, 0.02, 0.05]
MIN_PROVIDERS = 4
HYPERSCALERS = {"aws", "azure", "gcp", "oci"}

failures = []
checked = [0]


def micro(s):
    neg = s.startswith("-")
    whole, frac = s.lstrip("-").split(".")
    v = int(whole) * 1000000 + int(frac.ljust(6, "0"))
    return -v if neg else v


def day(s):
    return dt.date.fromisoformat(s)


def check(name, ours, theirs, tol):
    checked[0] += 1
    if ours is None or theirs is None:
        if ours != theirs:
            failures.append("%s: python=%r summary=%r" % (name, ours, theirs))
        return
    if isinstance(ours, str) or isinstance(theirs, str):
        if ours != theirs:
            failures.append("%s: python=%r summary=%r" % (name, ours, theirs))
        return
    if abs(ours - theirs) > tol:
        failures.append("%s: python=%r summary=%r (tol %g)" % (name, ours, theirs, tol))


def median_floor(values):
    v = sorted(values)
    n = len(v)
    if n % 2:
        return v[n // 2]
    return (v[n // 2 - 1] + v[n // 2]) // 2


def mean(xs):
    s = 0.0
    for x in xs:
        s += x
    return s / len(xs)


def sd(xs):
    if len(xs) < 2:
        return 0.0
    m = mean(xs)
    s = 0.0
    for x in xs:
        s += (x - m) * (x - m)
    return math.sqrt(s / (len(xs) - 1))


def pctl(sorted_xs, q):
    h = (len(sorted_xs) - 1) * q
    lo = int(math.floor(h))
    hi = min(lo + 1, len(sorted_xs) - 1)
    return sorted_xs[lo] + (sorted_xs[hi] - sorted_xs[lo]) * (h - lo)


# ---- 1. the index from providers.csv ----
with open(os.path.join(DERIVED, "index.csv"), newline="") as f:
    index_rows = list(csv.DictReader(f))
with open(os.path.join(DERIVED, "providers.csv"), newline="") as f:
    prov_rows = list(csv.DictReader(f))

by_day = {}
for r in prov_rows:
    if r["provider"] in HYPERSCALERS:
        failures.append("hyperscaler %s in providers.csv" % r["provider"])
    by_day.setdefault(r["date"], []).append(micro(r["price_usd_per_gpu_hour"]))
for r in index_rows:
    vals = by_day.get(r["date"], [])
    expect = median_floor(vals) if len(vals) >= MIN_PROVIDERS else None
    got = micro(r["index"]) if r["index"] else None
    if expect != got:
        failures.append("index %s: python=%r index.csv=%r" % (r["date"], expect, got))
    checked[0] += 1

days = [r["date"] for r in index_rows]
index = {r["date"]: micro(r["index"]) for r in index_rows if r["index"]}

# ---- 2. week selection ----
first, last = day(days[0]), day(days[-1])
idx_first, idx_last = day(min(index)), day(max(index))
monday = dt.date(2024, 11, 4)
offset = (first - monday).days
d = monday + dt.timedelta(days=-(-offset // 7) * 7)
mondays = []
while d + dt.timedelta(days=6) <= last:
    if d - dt.timedelta(days=LEAD + 1) >= idx_first and d + dt.timedelta(days=6) <= idx_last:
        mondays.append(d)
    d += dt.timedelta(days=7)

weeks = []
excluded = {"stale_anchor": 0, "few_prints": 0}
for w in mondays:
    opening = w - dt.timedelta(days=LEAD)
    anchor_day = None
    for age in range(1, MAX_AGE + 1):
        a = (opening - dt.timedelta(days=age)).isoformat()
        if a in index:
            anchor_day = a
            break
    if anchor_day is None:
        excluded["stale_anchor"] += 1
        continue
    prints = [index[(w + dt.timedelta(days=i)).isoformat()] for i in range(7) if (w + dt.timedelta(days=i)).isoformat() in index]
    if len(prints) < MIN_PRINTS:
        excluded["few_prints"] += 1
        continue
    weeks.append({"week": w.isoformat(), "anchor": index[anchor_day], "fixing": sum(prints) // len(prints)})


def band(anchor, bps):
    mid = anchor - anchor % TICK
    raw = anchor * bps // 10000
    half = raw - raw % TICK
    return mid, half, mid - half, 2 * half


S = json.load(open(os.path.join(RESULTS, "summary.json")))
check("days_with_index", len(index), S["data"]["days_with_index"], 0)
check("candidate_mondays", len(mondays), S["weeks"]["candidate_mondays"], 0)
check("weeks_kept", len(weeks), S["weeks"]["kept"], 0)
for reason, n in excluded.items():
    check("excluded_" + reason, n, sum(1 for e in S["weeks"]["excluded"] if e["reason"] == reason), 0)
check("first_week", weeks[0]["week"], S["weeks"]["first"], 0)
check("last_week", weeks[-1]["week"], S["weeks"]["last"], 0)

# ---- 3. move distribution ----
moves = [w["fixing"] / w["anchor"] - 1 for w in weeks]
sm = sorted(moves)
check("move.mean", mean(moves), S["move"]["mean"], 1e-6)
check("move.sd", sd(moves), S["move"]["sd"], 1e-6)
check("move.min", sm[0], S["move"]["min"], 1e-6)
check("move.max", sm[-1], S["move"]["max"], 1e-6)
for q in [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99]:
    k = "p%d" % round(q * 100)
    check("move." + k, pctl(sm, q), S["move"]["percentiles"][k], 1e-6)

# ---- 4. coverage and recommendation ----
rec = None
for i, bps in enumerate(GRID):
    inside = above = below = 0
    for w in weeks:
        mid, half, floor, b = band(w["anchor"], bps)
        if w["fixing"] > floor + b:
            above += 1
        elif w["fixing"] < floor:
            below += 1
        else:
            inside += 1
    c = S["coverage"][i]
    check("coverage[%d].band_bps" % bps, bps, c["band_bps"], 0)
    check("coverage[%d].inside" % bps, inside, c["inside"], 0)
    check("coverage[%d].above_cap" % bps, above, c["above_cap"], 0)
    check("coverage[%d].below_floor" % bps, below, c["below_floor"], 0)
    check("coverage[%d].share" % bps, inside / len(weeks), c["share_inside"], 6e-5)
    if rec is None and round(inside / len(weeks), 4) >= TARGET:
        rec = bps
if rec is None:
    rec = GRID[-1]
check("recommended band_bps", rec, S["recommendation"]["band_bps"], 0)


# ---- 5. hedge at the recommended band, neutral and shifted ----
def long_price(mid, half, floor, b, shift):
    if shift == 0:
        return half
    raw = int(math.floor((mid * (1 + shift) - floor) / TICK + 0.5)) * TICK  # JS Math.round
    return min(max(raw, TICK), b - TICK)


def hedge_series(shift):
    bu, bh, su, sh, anchor_cost, locks = [], [], [], [], [], []
    for w in weeks:
        mid, half, floor, b = band(w["anchor"], rec)
        lp = min(max(w["fixing"] - floor, 0), b)
        sp = b - lp
        p = long_price(mid, half, floor, b, shift)
        bu.append(w["fixing"] * HOURS / 1e6)
        bh.append((w["fixing"] - lp + p) * HOURS / 1e6)
        su.append(w["fixing"] * HOURS / 1e6)
        sh.append((w["fixing"] + sp - (b - p)) * HOURS / 1e6)
        anchor_cost.append(w["anchor"] * HOURS / 1e6)
        locks.append(p * HOURS / 1e6)
    return bu, bh, su, sh, anchor_cost, locks


def compare_hedge(prefix, block, shift):
    bu, bh, su, sh, ac, locks = hedge_series(shift)
    B, Se = block["buyer"], block["seller"]
    check(prefix + "buyer.unhedged.sd", sd(bu), B["unhedged_weekly_cost"]["sd"], 0.006)
    check(prefix + "buyer.hedged.sd", sd(bh), B["hedged_weekly_cost"]["sd"], 0.006)
    check(prefix + "buyer.unhedged.total", sum(bu), B["unhedged_weekly_cost"]["total"], 0.006)
    check(prefix + "buyer.hedged.total", sum(bh), B["hedged_weekly_cost"]["total"], 0.006)
    check(prefix + "buyer.hedged.mean", mean(bh), B["hedged_weekly_cost"]["mean"], 0.006)
    check(prefix + "buyer.surprise_sd.unhedged", sd([x - a for x, a in zip(bu, ac)]), B["sd_of_surprise"]["unhedged"], 0.006)
    check(prefix + "buyer.surprise_sd.hedged", sd([x - a for x, a in zip(bh, ac)]), B["sd_of_surprise"]["hedged"], 0.006)
    check(prefix + "buyer.locked.mean", mean(locks), B["locked_per_week"]["mean"], 0.006)
    check(prefix + "buyer.hedge_cost_total", sum(bh) - sum(bu), B["hedge_cost_total"], 0.011)
    check(prefix + "seller.hedged.sd", sd(sh), Se["hedged_weekly_revenue"]["sd"], 0.006)
    check(prefix + "seller.hedged.total", sum(sh), Se["hedged_weekly_revenue"]["total"], 0.006)
    check(prefix + "seller.unhedged.total", sum(su), Se["unhedged_weekly_revenue"]["total"], 0.006)
    if sd(bu) > 0:
        check(prefix + "buyer.variance_removed", 1 - sd(bh) ** 2 / sd(bu) ** 2, B["variance_removed"], 6e-5)
    # largest week-on-week increase of the buyer's cost, consecutive calendar weeks only
    for key, xs in (("unhedged", bu), ("hedged", bh)):
        best = None
        for i in range(1, len(weeks)):
            if day(weeks[i]["week"]) - day(weeks[i - 1]["week"]) != dt.timedelta(days=7):
                continue
            ch = xs[i] - xs[i - 1]
            if best is None or ch > best[1]:
                best = (weeks[i]["week"], ch)
        got = B["largest_week_on_week_increase"][key]
        check(prefix + "buyer.largest_increase.%s.week" % key, best[0] if best else None, got["to_week"] if got else None, 0)
        check(prefix + "buyer.largest_increase.%s.change" % key, best[1] if best else None, got["change"] if got else None, 0.006)


compare_hedge("neutral.", S["hedge_neutral"], 0.0)
for i, shift in enumerate(SHIFTS):
    check("sensitivity[%d].shift" % i, shift, S["sensitivity"][i]["forward_shift"], 1e-12)
    compare_hedge("shift%+.2f." % shift, S["sensitivity"][i], shift)

# ---- 6. capped weeks ----
capped = []
for w in weeks:
    mid, half, floor, b = band(w["anchor"], rec)
    if w["fixing"] > floor + b or w["fixing"] < floor:
        capped.append(w["week"])
check("capped_weeks", ",".join(capped), ",".join(c["week"] for c in S["capped_weeks"]), 0)

# ---- 7. regime split ----
trough = None
best = None
for i in range(2, len(weeks) - 2):
    v = mean([w["fixing"] for w in weeks[i - 2 : i + 3]])
    if best is None or v < best:
        best, trough = v, weeks[i]["week"]
idx = [w["week"] for w in weeks].index(trough) if trough else -1
if trough is None or idx < 4 or idx > len(weeks) - 5:
    trough = None
check("trough_week", trough, S["regimes"]["trough_week"], 0)

print("verify.py: %d checks, %d mismatches" % (checked[0], len(failures)))
print("  weeks kept %d, recommended band_bps %d, trough %s" % (len(weeks), rec, trough))
for f in failures[:50]:
    print("  MISMATCH " + f)
sys.exit(1 if failures else 0)
