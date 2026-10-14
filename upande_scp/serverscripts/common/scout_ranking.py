"""Scout ranking for the Personnel ▸ Scouts page (personnel spec P4) — the pure side.

It reads the per-scout rows the ``quality`` aggregate already computes
(``quality_rules.Fold.scout_rows``), so ranking costs no scan of its own. A
scout's score is out of 100 and is always shown with its three parts:

* **Effort** (``EFFORT_WEIGHT``): stations per active day ÷ the median of the
  ranked scouts of the scout's farm, capped at 1.
* **Integrity** (``INTEGRITY_WEIGHT``): 100 − (too-fast % + duplicate %), ≥ 0.
* **GPS** (``GPS_WEIGHT``): 100 − the scout's off-zone excess over the same
  houses' other scouts, ≥ 0. A scout with no GPS fixes (or no other scout in
  their houses to compare with) gets the farm's average and a note.

Only scouts with ``MIN_ACTIVE_DAYS`` or more are ranked; ties go to the one with
more entries. Approved-leave days are excused (spec C9): the requirement is scaled
to the days of the range the scout was not on leave (``required_active_days``). The weights are constants here, not settings. Nothing in this
module touches the database.
"""

import math

EFFORT_WEIGHT = 0.4
INTEGRITY_WEIGHT = 0.3
GPS_WEIGHT = 0.3
MIN_ACTIVE_DAYS = 5

NOTE_NO_GPS = "no GPS data"
NOTE_NO_BASELINE = "no other scout in their houses to compare GPS with"

#: Figures the scout record compares with the farm median.
MEDIAN_FIELDS = ("stationsPerDay", "entriesPerDay", "entriesPerHour", "tooFastPct",
                 "duplicatePct", "offZonePct", "nothingFoundPct")


def required_active_days(leave_days=0, range_days=None) -> int:
    """``MIN_ACTIVE_DAYS`` scaled to the days not on approved leave:
    ``max(1, ceil(MIN × (range − leave) / range))``. Without a range or leave it
    is ``MIN_ACTIVE_DAYS``."""
    leave = max(0.0, float(leave_days or 0))
    if not leave or not range_days:
        return MIN_ACTIVE_DAYS
    span = float(range_days)
    working = max(0.0, span - min(leave, span))
    return max(1, math.ceil(MIN_ACTIVE_DAYS * working / span - 1e-9))


def median(values):
    """Median of the non-None values; None when there are none."""
    xs = sorted(float(v) for v in values if v is not None)
    if not xs:
        return None
    mid = len(xs) // 2
    return xs[mid] if len(xs) % 2 else (xs[mid - 1] + xs[mid]) / 2.0


def effort(stations_per_day, farm_median):
    """0–100. With no farm median to compare with (nobody walked a station),
    nobody is behind it, so everyone scores full effort."""
    if not farm_median:
        return 100.0
    return round(100.0 * min(1.0, (stations_per_day or 0) / farm_median), 1)


def integrity(too_fast_pct, duplicate_pct):
    return round(max(0.0, 100.0 - (too_fast_pct or 0) - (duplicate_pct or 0)), 1)


def gps(off_zone_pct, house_off_zone_pct, fixes):
    """``(score | None, note | None)`` — None when there is nothing to judge by."""
    if not fixes or off_zone_pct is None:
        return None, NOTE_NO_GPS
    if house_off_zone_pct is None:
        return None, NOTE_NO_BASELINE
    excess = max(0.0, off_zone_pct - house_off_zone_pct)
    return round(max(0.0, 100.0 - excess), 1), None


def score(effort_, integrity_, gps_):
    return round(EFFORT_WEIGHT * effort_ + INTEGRITY_WEIGHT * integrity_ + GPS_WEIGHT * gps_, 1)


def _farms(row, farm_of_house):
    by: dict = {}
    for h in row.get("houses") or []:
        farm = farm_of_house.get(h["house"])
        if farm:
            by[farm] = by.get(farm, 0) + h["entries"]
    return [f for f, _n in sorted(by.items(), key=lambda kv: (-kv[1], kv[0]))]


def _with_derived(row, farm_of_house, leave_days=None, range_days=None):
    out = dict(row)
    leave = (leave_days or {}).get(row["scout"], 0) or 0
    farms = _farms(row, farm_of_house)
    out["farms"] = farms
    out["farm"] = farms[0] if farms else None
    days = row.get("activeDays") or 0
    out["entriesPerDay"] = round(row["entries"] / days, 1) if days else None
    out["leaveDays"] = leave
    out["requiredDays"] = required_active_days(leave, range_days)
    out["eligible"] = days >= out["requiredDays"]
    return out


def farm_medians(rows) -> dict:
    """``{farm: {field: median}}`` over the ranked (eligible) scouts of each farm;
    a farm with none eligible falls back to all its scouts."""
    by_farm: dict = {}
    for r in rows:
        by_farm.setdefault(r["farm"], []).append(r)
    out = {}
    for farm, rs in by_farm.items():
        pool = [r for r in rs if r["eligible"]] or rs
        out[farm] = {f: median(r.get(f) for r in pool) for f in MEDIAN_FIELDS}
        out[farm]["scouts"] = len(pool)
    return out


def rank(scouts, farm_of_house, leave_days=None, range_days=None) -> dict:
    """``{"ranked": [...], "notEnoughDays": [...], "medians": {farm: {...}}}``.

    ``scouts`` are ``Fold.scout_rows``; ``farm_of_house`` maps a house to its farm.
    Each ranked row gains ``farm``, ``farms``, ``effort``, ``integrity``, ``gps``,
    ``gpsNote``, ``score`` and ``rank``; every row gains ``leaveDays`` and
    ``requiredDays``. ``leave_days`` maps scout → approved-leave days in the range
    of ``range_days`` days.
    """
    rows = [_with_derived(r, farm_of_house, leave_days, range_days) for r in scouts]
    medians = farm_medians(rows)
    eligible = [r for r in rows if r["eligible"]]
    for r in eligible:
        r["effort"] = effort(r.get("stationsPerDay"), medians[r["farm"]]["stationsPerDay"])
        r["integrity"] = integrity(r.get("tooFastPct"), r.get("duplicatePct"))
        r["gps"], r["gpsNote"] = gps(r.get("offZonePct"), r.get("houseOffZonePct"), r.get("fixes"))
    # Missing GPS takes the farm's average (else everyone's, else full marks).
    judged = [r for r in eligible if r["gps"] is not None]
    overall = sum(r["gps"] for r in judged) / len(judged) if judged else 100.0
    farm_avg: dict = {}
    for r in judged:
        farm_avg.setdefault(r["farm"], []).append(r["gps"])
    for r in eligible:
        if r["gps"] is None:
            vals = farm_avg.get(r["farm"])
            r["gps"] = round(sum(vals) / len(vals) if vals else overall, 1)
        r["score"] = score(r["effort"], r["integrity"], r["gps"])
    eligible.sort(key=lambda r: (-r["score"], -r["entries"], r.get("scoutName") or r["scout"]))
    for i, r in enumerate(eligible, 1):
        r["rank"] = i
    rest = sorted((r for r in rows if not r["eligible"]),
                  key=lambda r: (-(r.get("activeDays") or 0), -r["entries"], r.get("scoutName") or r["scout"]))
    return {"ranked": eligible, "notEnoughDays": rest, "medians": medians}
