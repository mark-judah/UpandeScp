"""Spread (piece 3c): a greenhouse's or block's patches of neighbouring infested
stations for one observation and ISO week, tracked against the previous
scouted week (spec 2026-10-10-spread-and-pins C1–C5, §3).

Computed on demand (C4), with no stored table. ``get_house_clusters`` caches
the payload in the dashboard aggregate cache, under the same version stamp
and TTL. Scouting comes through piece 2's ``StationWeeks``, so piece 1's crop
scoping (D4/D5) holds. Positions come from ``station_ranks``: the same Zone /
Bed / Orchard Tree order as the 3 × 3 grid. Clusters never notify anyone.
"""

import re
from datetime import date, timedelta

import frappe

from upande_scp.serverscripts.common import clusters as C
from upande_scp.serverscripts.common import crop_catalog
from upande_scp.serverscripts.common import prevalence as P
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows as R
from upande_scp.serverscripts.dashboard_aggregates._common import cached_aggregate
from upande_scp.serverscripts.scouting import thresholds_check as TC

KINDS = ("pest", "disease")
STATION_WORDS = {"bed": "zones", "row": "trees"}
_WEEK = re.compile(r"^(\d{4})-W(\d{1,2})$")


def empty(unit="bed") -> dict:
    return {"week": None, "prev_week": None, "unit": unit, "clusters": [], "gone": []}


def kind_key(kind) -> str:
    """``Pest`` / ``pest`` → ``pest``; refused when it is neither kind."""
    k = (kind or "").strip().lower()
    if k not in KINDS:
        frappe.throw(f"Unknown kind: {kind}.", frappe.ValidationError)
    return k


def normalize_week(week) -> str:
    """``2031-W5`` → ``2031-W05``; ``""`` for blank; refused when unreadable."""
    week = (week or "").strip()
    if not week:
        return ""
    m = _WEEK.match(week)
    if not m or not 1 <= int(m.group(2)) <= 53:
        frappe.throw(f"Unreadable ISO week: {week}.", frappe.ValidationError)
    return f"{m.group(1)}-W{int(m.group(2)):02d}"


def unit_for(warehouse) -> str:
    """``row`` on a Block (orchard rows and trees), else ``bed``."""
    return "row" if frappe.db.get_value("Warehouse", warehouse, "warehouse_type") == "Block" else "bed"


def _window(week, today) -> tuple:
    if week:
        monday = P.week_monday(week)
        return monday, (date.fromisoformat(monday) + timedelta(days=6)).isoformat()
    today = today or TC.now_eat().date()
    return (today - timedelta(days=TC.EVAL_WINDOW_DAYS - 1)).isoformat(), today.isoformat()


def _public(c, unit, i) -> dict:
    return {
        "id": f"P{i}",
        "stations": list(c["stations"]),
        "size": c["size"],
        "centroid": list(c["centroid"]),
        "rows": list(c["rows"]),
        "cols": list(c["cols"]),
        "label": C.label(c, unit),
        "change": c["change"],
        "prev_size": c.get("prev_size"),
    }


def house_clusters(crop, warehouse, observation, kind, stage=None, week=None, today=None) -> dict:
    """``{week, prev_week, unit, clusters, gone}`` for one house, uncached.

    ``week`` (``YYYY-Www``) pins the week; without it, the house's latest
    scouted week in the last 14 days (the alerts' window). ``stage`` narrows to
    one stage; by default every stage counts (C1's live figure). Stations come
    by name, so the maps outline them from their own geometry."""
    kind = kind_key(kind)
    week = normalize_week(week)
    unit = unit_for(warehouse)
    out = empty(unit)
    start, end = _window(week, today)
    weeks = R.StationWeeks.load(start, end, crop, [warehouse], kinds=(kind,))
    latest, previous = weeks.latest_pair(warehouse)
    if not latest:
        return out
    ranks = R.station_ranks(warehouse)
    narrow = (stage or "").strip() or R.ANY
    now = C.clusters(ranks, weeks.infested_set(warehouse, latest, kind, observation, narrow))
    before = (
        C.clusters(ranks, weeks.infested_set(warehouse, previous, kind, observation, narrow), limit=None)
        if previous else []
    )
    tracked, gone = C.track(now, before)
    out.update(
        week=latest,
        prev_week=previous,
        clusters=[_public(c, unit, i) for i, c in enumerate(tracked, start=1)],
        gone=[_public(c, unit, i) for i, c in enumerate(gone, start=1)],
    )
    return out


@frappe.whitelist()
def get_house_clusters(crop, warehouse, observation, kind, stage=None, week=None, force=0) -> dict:
    """C5: the greenhouse modal's Patches and the maps' outlines. Cached with
    the dashboard aggregates; a call without ``week`` is keyed by today (EAT)."""
    crop = crop_catalog.resolve_crop(crop)
    warehouse = (warehouse or "").strip()
    observation = (observation or "").strip()
    if not crop or not warehouse or not observation:
        return empty()
    TC._assert_can_see(crop, frappe.db.get_value("Warehouse", warehouse, "custom_farm"))
    filters = {
        "crop": crop, "warehouse": warehouse, "observation": observation, "kind": kind_key(kind),
        "stage": (stage or "").strip(), "week": normalize_week(week),
    }
    if not filters["week"]:
        filters["today"] = TC.now_eat().date().isoformat()
    return cached_aggregate(
        "house_clusters", filters,
        lambda: house_clusters(crop, warehouse, observation, filters["kind"], filters["stage"], filters["week"]),
        force=str(force).strip().lower() in ("1", "true", "yes"),
    )
