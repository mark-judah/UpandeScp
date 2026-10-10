"""By-variety live prevalence and signs for one pest (stage & variety spec S7).

Rose in practice: a station's variety is the variety of the bed it was scouted
on (``Scouting Entry.bed → Bed.variety``; 14,230 of kaitet's 20,668 beds carry
one). Avocado and coffee entries have no bed variety, so the table comes back
empty and the frontend hides it.

Per house, its latest scouted ISO week (``StationWeeks.latest_pair``); a scope
(the Pests tab) is the union of every house's latest week. Figures are raw
shares — infested ÷ scouted stations of the variety — because a variety's beds
are not a 3 × 3 sample, so the section estimator does not apply. A variety with
fewer than ``VARIETY_MIN_N`` scouted stations is ``few`` (greyed "too few").
No per-variety thresholds (S8).
"""

from datetime import datetime, timedelta

import frappe

from upande_scp.serverscripts.common import prevalence as P
from upande_scp.serverscripts.common import stage_roles
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows as R
from upande_scp.serverscripts.dashboard_aggregates._common import parent_filter_conditions

#: S7: a variety with fewer scouted stations than this is greyed "too few".
VARIETY_MIN_N = 10


def _pct(x, n):
    return round(100.0 * x / n, 1) if n else None


def group_by_variety(station_beds, scouted, live, signs=None) -> list:
    """Pure. ``station_beds`` = ``{(house, station): (bed, variety)}``;
    ``scouted`` / ``live`` / ``signs`` are sets of ``(house, station)``. A
    scouted station with no bed row, or a bed with no variety, falls in the
    ``""`` group (listed last). ``signs`` None → the pest has no Sign stage, and
    each row's ``signs`` is None. ``[]`` when no scouted station has a variety."""
    groups: dict = {}
    for key in sorted(scouted):
        bed, variety = station_beds.get(key) or ("", "")
        g = groups.setdefault((variety or "").strip(), {"beds": set(), "scouted": 0, "live": 0, "signs": 0})
        if bed:
            g["beds"].add(bed)
        g["scouted"] += 1
        g["live"] += key in live
        if signs is not None:
            g["signs"] += key in signs
    if not any(groups):
        return []
    rows = [{
        "variety": v,
        "beds": len(g["beds"]),
        "scouted": g["scouted"],
        "infested": g["live"],
        "prevalence": _pct(g["live"], g["scouted"]),
        "signs": _pct(g["signs"], g["scouted"]) if signs is not None else None,
        "few": g["scouted"] < VARIETY_MIN_N,
    } for v, g in groups.items()]
    rows.sort(key=lambda r: (r["variety"] == "", -r["scouted"], r["variety"]))
    return rows


def latest_weeks(weeks, houses=None) -> dict:
    """``{house: its latest scouted ISO week}`` (every house in the window when
    ``houses`` is None)."""
    out = {}
    for wh in (weeks.warehouses() if houses is None else houses):
        week, _previous = weeks.latest_pair(wh)
        if week:
            out[wh] = week
    return out


def station_beds(crop, chosen) -> dict:
    """``{(house, station): (bed, variety)}`` for the chosen (house, ISO week)
    pairs, in one parent-only scan through piece 1's crop scoping (D5). A
    station seen on two beds that week keeps one with a variety."""
    if not chosen:
        return {}
    mondays = sorted(P.week_monday(w) for w in chosen.values())
    last = (datetime.strptime(mondays[-1], "%Y-%m-%d").date() + timedelta(days=6)).isoformat()
    where, params = parent_filter_conditions(mondays[0], last, crop, sorted(chosen))
    pairs = tuple(sorted((wh, int(w.replace("-W", ""))) for wh, w in chosen.items()))
    params["sw_pairs"] = pairs
    out: dict = {}
    for wh, station, bed, variety in frappe.db.sql(
        f"""
        SELECT {R._WH}, {R._STATION}, se.bed, b.variety
        FROM `tabScouting Entry` se
        LEFT JOIN `tabBed` b ON b.name = se.bed
        WHERE {where} AND COALESCE({R._STATION}, '') <> ''{R._pairs_clause(pairs)}
        """,
        params,
    ):
        key = ((wh or "").strip(), (station or "").strip())
        value = ((bed or "").strip(), (variety or "").strip())
        if key not in out or (value[1] and not out[key][1]):
            out[key] = value
    return out


def breakdown(weeks, crop, pest, chosen, beds) -> list:
    """The table for ``pest`` over the ``chosen`` house-weeks (``latest_weeks``)
    with their ``beds`` (``station_beds``)."""
    if not pest or not chosen or not any(v for _bed, v in beds.values()):
        return []
    scouted, live, signs = set(), set(), set()
    for wh, week in chosen.items():
        scouted |= {(wh, s) for s in weeks.scouted_set(wh, week)}
        live |= {(wh, s) for s in weeks.infested_set(wh, week, "pest", pest)}
        signs |= {(wh, s) for s in weeks.infested_set(wh, week, "pest", pest, role=R.SIGNS)}
    with_signs = bool(stage_roles.sign_stages(crop, pest))
    return group_by_variety(beds, scouted, live, signs if with_signs else None)


def variety_breakdown(weeks, crop, pest, houses=None) -> list:
    """``breakdown`` for every house in ``weeks`` (or ``houses``), latest week each."""
    if not pest:
        return []
    chosen = latest_weeks(weeks, houses)
    return breakdown(weeks, crop, pest, chosen, station_beds(crop, chosen))
