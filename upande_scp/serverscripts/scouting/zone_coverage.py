"""Zone coverage: how thoroughly each rose greenhouse was scouted, by zone.

A greenhouse is made of beds and each bed of zones (about 4.4 m long; the Zone
doctype holds them). A Scouting Entry names the greenhouse, bed and zone it was
keyed at, so coverage is counted in zones, not in a metres rule:

* **zone coverage** of a greenhouse over a week = distinct zones scouted / all
  its zones. The greenhouse is **Full** when that is MORE than ``FULL_PCT`` and
  **Partial** otherwise (``Not scouted`` with no entry at all).
* a **bed** is **under-scouted** when fewer than ``FULL_PCT`` of its zones were
  scouted; the worst ``TOP_BEDS`` are listed (a bed never keyed is 0 %).
* per week and per day: entries, beds scouted of all beds, average entries per
  bed ("times each bed was keyed") and zones scouted.

Performance, the same way the quality aggregate does it: one cached partial per
capture date (all houses, ``{house: {bed: {zone: entries}}}``), dropped by the
date's generation stamp when a scouting write touches that date, so a range is
assembled from Redis and only dates never read touch the database. The zone
universe (zones per bed) is read once and cached for a day: it only changes when
a greenhouse is re-mapped.
"""
from __future__ import annotations

import heapq
import pickle
import zlib
from datetime import datetime, timedelta

import frappe
from frappe.utils import getdate, nowdate

from upande_scp.serverscripts.common import crop_scope
from upande_scp.serverscripts.common.place_filter import parse_names

FULL_PCT = 80.0
TOP_BEDS = 10
MAX_RANGE_DAYS = 56

K_PART = "scp:zonecov:part:zc1"
K_UNIVERSE = "scp:zonecov:universe:zc1"
TTL_RECENT = 3600
TTL_OLD = 86400
TTL_UNIVERSE = 86400
RECENT_DAYS = 7

SCOUT_ROLES = ("SCP General Manager", "System Manager", "SCP Scouting User")


# ── the zone universe ───────────────────────────────────────────────────────


def universe(force=False) -> dict:
    """``{house: {"zones": n, "beds": {bed: zones}}}`` from the Zone doctype,
    cached for a day (the Zone table carries a heavy geojson column, so a cold
    read is slow; ~0.6 s warm, tens of seconds from a cold disk)."""
    cache = frappe.cache()
    key = cache.make_key(K_UNIVERSE)
    if not force:
        blob = cache.get(key)
        if blob is not None:
            try:
                return pickle.loads(zlib.decompress(blob))
            except Exception:
                pass
    out: dict = {}
    for house, bed, n in frappe.db.sql(
        """SELECT MIN(greenhouse), bed, COUNT(*) FROM `tabZone`
            WHERE IFNULL(bed, '') != '' GROUP BY bed"""
    ):
        if not house:
            continue
        g = out.setdefault(house, {"zones": 0, "beds": {}})
        g["beds"][bed] = int(n)
        g["zones"] += int(n)
    cache.set(key, zlib.compress(pickle.dumps(out, pickle.HIGHEST_PROTOCOL), 1), ex=TTL_UNIVERSE)
    return out


# ── per-day partials ────────────────────────────────────────────────────────


def _partial_key(day, gen) -> str:
    return f"{K_PART}:{day}:{gen}"


def _read_day(day) -> dict:
    """``{house: {bed: {zone: entries}}}`` for one capture date, all houses."""
    out: dict = {}
    for house, bed, zone, n in frappe.db.sql(
        """SELECT se.greenhouse, IFNULL(se.bed, ''), IFNULL(se.zone, ''), COUNT(*)
             FROM `tabScouting Entry` se
            WHERE se.date_of_capture = %s AND IFNULL(se.greenhouse, '') != '' AND se.docstatus < 2
            GROUP BY se.greenhouse, se.bed, se.zone""",
        (day,),
    ):
        out.setdefault(house, {}).setdefault(bed, {})[zone] = int(n)
    return out


def day_partials(days, force=False, fill_only=False) -> dict:
    """``{day: partial}`` from Redis where cached, else read (one query a date)
    and cached. ``fill_only`` (the warmer) returns only what it had to build."""
    from upande_scp.serverscripts.dashboard_aggregates._quality import _gens

    cache = frappe.cache()
    days = [str(d)[:10] for d in days]
    gens = _gens(cache, days)
    keys = {d: cache.make_key(_partial_key(d, gens[d])) for d in days}
    out: dict = {}
    if not force:
        for d, blob in zip(days, cache.mget([keys[d] for d in days])):
            if blob is not None:
                try:
                    out[d] = pickle.loads(zlib.decompress(blob))
                except Exception:
                    pass
    missing = [d for d in days if d not in out]
    recent = (getdate(nowdate()) - timedelta(days=RECENT_DAYS)).isoformat()
    built = {}
    for d in missing:
        part = built[d] = out[d] = _read_day(d)
        cache.set(keys[d], zlib.compress(pickle.dumps(part, pickle.HIGHEST_PROTOCOL), 1),
                  ex=TTL_RECENT if d >= recent else TTL_OLD)
    return built if fill_only else out


# ── assembling (pure) ───────────────────────────────────────────────────────


def _pct(n, total):
    return round(100.0 * n / total, 1) if total else None


def status_of(zone_pct, entries) -> str:
    """Full when MORE than ``FULL_PCT`` of the zones were scouted. Pure."""
    if not entries:
        return "Not scouted"
    return "Full" if (zone_pct or 0) > FULL_PCT else "Partial"


def bed_label(bed, house) -> str:
    prefix = f"{house} - "
    return bed[len(prefix):] if bed.startswith(prefix) else bed


def week_rows(parts: dict, uni: dict, houses, monday, today=None, top=TOP_BEDS) -> list:
    """One row per house for the ISO week starting ``monday``. Pure.

    ``parts``: ``{day: {house: {bed: {zone: entries}}}}`` (days outside the week
    are ignored); ``uni``: ``universe()``; ``houses``: the houses to report.
    """
    days = [monday + timedelta(days=i) for i in range(7)]
    rows = []
    for house in houses:
        u = uni.get(house)
        if not u:
            continue
        bed_zones: dict = {}  # bed -> {zone: n}
        per_day = []
        entries = 0
        for d in days:
            beds = (parts.get(d.isoformat()) or {}).get(house) or {}
            d_entries = d_zones = 0
            d_beds = set()
            for bed, zones in beds.items():
                n = sum(zones.values())
                d_entries += n
                d_beds.add(bed)
                d_zones += len({z for z in zones if z})
                tgt = bed_zones.setdefault(bed, {})
                for z, c in zones.items():
                    tgt[z] = tgt.get(z, 0) + c
            entries += d_entries
            per_day.append({"date": d.isoformat(), "entries": d_entries, "beds": len(d_beds),
                            "zones": d_zones})
        keyed = {b: sum(z.values()) for b, z in bed_zones.items() if b}
        zone_total = u["zones"]
        scouted_zones = 0
        under_n = 0
        partial_under = []  # beds with some, but < FULL_PCT, of their zones scouted
        hit_beds = set()
        for bed, zs in bed_zones.items():
            n_zones = u["beds"].get(bed)
            hit = min(len({z for z in zs if z}), n_zones) if n_zones else 0
            if not hit:
                continue
            hit_beds.add(bed)
            scouted_zones += hit
            pct = _pct(hit, n_zones)
            if pct < FULL_PCT:
                partial_under.append((pct, bed, hit, n_zones))
        # Beds with no zone scouted at all are 0 %: they sort first, by name.
        zero = heapq.nsmallest(top, (b for b in u["beds"] if b not in hit_beds))
        under_n = (len(u["beds"]) - len(hit_beds)) + len(partial_under)
        partial_under.sort()
        under = [
            {"bed": bed_label(b, house), "pct": 0.0, "entries": keyed.get(b, 0), "zones": f"0/{u['beds'][b]}"}
            for b in zero
        ] + [
            {"bed": bed_label(b, house), "pct": pct, "entries": keyed.get(b, 0), "zones": f"{h}/{n}"}
            for pct, b, h, n in partial_under[:top]
        ]
        zone_pct = _pct(scouted_zones, zone_total)
        beds_total = len(u["beds"])
        beds_scouted = len([b for b in keyed if b in u["beds"]])
        rows.append({
            "house": house, "week_start": monday.isoformat(), "entries": entries,
            "beds_total": beds_total, "beds_scouted": beds_scouted,
            "entries_per_bed": round(sum(keyed.values()) / len(keyed), 1) if keyed else None,
            "zones_total": zone_total, "zones_scouted": scouted_zones, "zone_pct": zone_pct,
            "status": status_of(zone_pct, entries),
            "beds_under": under_n if entries else None,
            "under": under[:top] if entries else [],
            "days": per_day,
        })
    return rows


def weeks_between(start, end) -> list:
    """Mondays of every ISO week touching [start, end]. Pure."""
    start, end = getdate(start), getdate(end)
    monday = start - timedelta(days=start.weekday())
    out = []
    while monday <= end:
        out.append(monday)
        monday += timedelta(days=7)
    return out


def summarise(rows) -> dict:
    scouted = [r for r in rows if r["entries"]]
    return {
        "houses": len(rows), "scouted": len(scouted),
        "full": sum(r["status"] == "Full" for r in rows),
        "partial": sum(r["status"] == "Partial" for r in rows),
        "not_scouted": sum(r["status"] == "Not scouted" for r in rows),
    }


# ── the endpoint ────────────────────────────────────────────────────────────


def _assert_role(user=None):
    user = user or frappe.session.user
    if user == "Administrator" or set(frappe.get_roles(user)) & set(SCOUT_ROLES):
        return
    frappe.throw("You do not have access to coverage.", frappe.PermissionError)


def houses_in_scope(farm="", greenhouse="", crop="", user=None) -> list:
    """The houses with zones that the caller may see, narrowed by farm / house."""
    from upande_scp.serverscripts.scouting import scouting_metrics

    farms_map = scouting_metrics.get_farms_and_warehouses() or {}
    visible = crop_scope.visible_farms(None, crop or None, user)
    crop_farms = crop_scope.farms_for_crop(crop) if crop else None
    wanted_farms = set(parse_names(farm))
    wanted_houses = set(parse_names(greenhouse))
    out = []
    for f, hs in farms_map.items():
        if wanted_farms and f not in wanted_farms:
            continue
        if visible is not None and f not in visible:
            continue
        if crop_farms is not None and f not in crop_farms:
            continue
        for h in hs:
            if not wanted_houses or h in wanted_houses:
                out.append(h)
    return sorted(set(out))


def zone_coverage(farm="", greenhouse="", crop="", from_date=None, to_date=None, user=None, force=False) -> dict:
    today = getdate(nowdate())
    end = getdate(to_date) if to_date else today
    start = getdate(from_date) if from_date else end - timedelta(days=27)
    if (end - start).days > MAX_RANGE_DAYS:
        start = end - timedelta(days=MAX_RANGE_DAYS)
    uni = universe(force=force)
    houses = [h for h in houses_in_scope(farm, greenhouse, crop, user) if h in uni]
    mondays = weeks_between(start, end)
    all_days = [mondays[0] + timedelta(days=i) for i in range(7 * len(mondays))] if mondays else []
    parts = day_partials([d.isoformat() for d in all_days if d <= today], force=force)
    weeks = []
    for m in mondays:
        rows = week_rows(parts, uni, houses, m)
        weeks.append({
            "week_start": m.isoformat(), "week_end": (m + timedelta(days=6)).isoformat(),
            "partial": m + timedelta(days=6) >= today, "summary": summarise(rows), "rows": rows,
        })
    return {"from_date": str(start), "to_date": str(end), "full_pct": FULL_PCT, "weeks": weeks}


@frappe.whitelist()
def get_zone_coverage(farm="", greenhouse="", crop="Rose", from_date=None, to_date=None) -> dict:
    """The Coverage page's zone table: per greenhouse and ISO week (and per day)."""
    _assert_role()
    return zone_coverage(farm, greenhouse, crop, from_date, to_date)


def prewarm(weeks=4) -> dict:
    """Fill the last ``weeks`` weeks' partials (the warmer's job)."""
    today = getdate(nowdate())
    days = [(today - timedelta(days=i)).isoformat() for i in range(7 * weeks)]
    built = day_partials(days, fill_only=True)
    universe()
    return {"built": len(built)}
