"""Fixed trap locations, estimated from the scouts' own GPS fixes.

A trap does not move, so every scouting entry recorded at it is a GPS fix of
the same spot. `estimate_trap_locations` collects the fixes of every trap in
one query, runs the pure estimator (`trap_geometry.estimate`) per trap and
writes the result onto the Trap:

    geojson            FeatureCollection with one Point (Geolocation field)
    location_source    "GPS estimate" — a "Manual" trap is never overwritten
    location_fixes     fixes kept after outlier removal
    location_spread_m  p90 distance of those fixes from the estimate
    location_updated   when the estimate was last written
    location_flag      "outside house" when the point is far from the house

Only entries that recorded exactly one distinct trap are used: an entry with
several traps has one GPS fix for several places, so it says nothing about
any one of them.
"""

import json

import frappe
from frappe.utils import now_datetime

from upande_scp.serverscripts.traps import trap_geometry as G

RUN_ROLES = ("System Manager", "SCP General Manager")
SOURCE_GPS = "GPS estimate"
SOURCE_MANUAL = "Manual"


def _fixes(farm=None, trap=None):
    """{trap: [(lat, lng, accuracy), ...]} from single-trap entries only."""
    cond, params = [], {"max_acc": G.MAX_ACCURACY_M}
    if farm:
        cond.append("tr.farm = %(farm)s")
        params["farm"] = farm
    if trap:
        cond.append("tr.name = %(trap)s")
        params["trap"] = trap
    where = (" AND " + " AND ".join(cond)) if cond else ""
    rows = frappe.db.sql(
        f"""
        SELECT x.trap, m.latitude, m.longitude, m.gps_accuracy
        FROM (
            SELECT parent, MIN(trap) AS trap
            FROM `tabTrap Scouting Entry`
            WHERE parenttype = 'Scouting Entry' AND IFNULL(trap, '') != ''
            GROUP BY parent
            HAVING COUNT(DISTINCT trap) = 1
        ) x
        JOIN `tabScouting Entry` se ON se.name = x.parent AND se.docstatus < 2
        JOIN `tabScouting Entry Metadata` m ON m.scouting_entry = x.parent
        JOIN `tabTrap` tr ON tr.name = x.trap
        WHERE CAST(m.gps_accuracy AS DECIMAL(12, 4)) > 0
          AND CAST(m.gps_accuracy AS DECIMAL(12, 4)) <= %(max_acc)s
          AND IFNULL(m.latitude, '') != '' AND IFNULL(m.longitude, '') != ''
          {where}
        """,
        params,
    )
    out = {}
    for t, lat, lng, acc in rows:
        out.setdefault(t, []).append((lat, lng, acc))
    return out


def _house_geometry(greenhouses):
    """{warehouse: [geojson, ...]} — the house's Zone lines, or, for a house
    with no zones (an orchard block), its boundary polygon."""
    ghs = sorted({g for g in greenhouses if g})
    if not ghs:
        return {}
    out = {}
    for gh, geo in frappe.db.sql(
        "SELECT greenhouse, geojson FROM `tabZone` WHERE greenhouse IN %(g)s AND IFNULL(geojson, '') != ''",
        {"g": ghs},
    ):
        out.setdefault(gh, []).append(geo)
    missing = [g for g in ghs if g not in out]
    if missing and frappe.db.has_column("Warehouse", "custom_raw_geojson"):
        for name, geo in frappe.db.sql(
            "SELECT name, custom_raw_geojson FROM `tabWarehouse` WHERE name IN %(g)s AND IFNULL(custom_raw_geojson, '') != ''",
            {"g": missing},
        ):
            out[name] = [geo]
    return out


def run_estimate(farm=None, trap=None, dry_run=True):
    """Estimate and (unless dry_run) write trap locations. No permission check —
    callers gate it. Returns a summary dict."""
    filters = {}
    if farm:
        filters["farm"] = farm
    if trap:
        filters["name"] = trap
    traps = frappe.get_all(
        "Trap",
        filters=filters,
        fields=["name", "farm", "greenhouse", "location", "location_source",
                "location_fixes", "location_spread_m", "location_flag", "geojson"],
        limit_page_length=0,
        ignore_permissions=True,
    )
    fixes = _fixes(farm=farm, trap=trap)
    houses = _house_geometry(t.greenhouse for t in traps)
    now = now_datetime()

    summary = {
        "dry_run": bool(dry_run), "traps": len(traps), "placed": 0, "unchanged": 0,
        "skipped_too_few": 0, "no_fixes": 0, "unchanged_manual": 0, "flagged": 0,
        "per_farm": {}, "flagged_traps": [], "spreads": [],
    }
    for t in traps:
        pf = summary["per_farm"].setdefault(t.farm or "", {
            "traps": 0, "placed": 0, "skipped_too_few": 0, "no_fixes": 0,
            "unchanged_manual": 0, "flagged": 0})
        pf["traps"] += 1
        if (t.location_source or "") == SOURCE_MANUAL:
            summary["unchanged_manual"] += 1
            pf["unchanged_manual"] += 1
            continue
        tf = fixes.get(t.name) or []
        if not tf:
            summary["no_fixes"] += 1
            pf["no_fixes"] += 1
            continue
        est = G.estimate(tf)
        if not est:
            summary["skipped_too_few"] += 1
            pf["skipped_too_few"] += 1
            continue
        dist = G.distance_to_geometries(est["lat"], est["lng"], houses.get(t.greenhouse) or [])
        flag = G.flag_for(dist, t.location)
        if flag:
            summary["flagged"] += 1
            pf["flagged"] += 1
            summary["flagged_traps"].append({
                "trap": t.name, "location": t.location, "greenhouse": t.greenhouse,
                "distance_m": round(dist, 1), "fixes": est["fixes"], "spread_m": est["spread_m"]})
        summary["placed"] += 1
        pf["placed"] += 1
        summary["spreads"].append(est["spread_m"])

        geo = G.to_geojson(est["lat"], est["lng"], {
            "trap": t.name, "source": SOURCE_GPS, "fixes": est["fixes"],
            "spread_m": est["spread_m"],
            "house_distance_m": None if dist is None else round(dist, 1)})
        prev = G.point_of(t.geojson) if t.geojson else None
        same = (
            prev is not None
            and (t.location_source or "") == SOURCE_GPS
            and int(t.location_fixes or 0) == est["fixes"]
            and (t.location_flag or "") == (flag or "")
            and G.distance_m(prev[0], prev[1], est["lat"], est["lng"]) < 0.01
        )
        if same:
            summary["unchanged"] += 1
        if dry_run or same:
            continue
        frappe.db.set_value("Trap", t.name, {
            "geojson": json.dumps(geo, separators=(",", ":")),
            "location_source": SOURCE_GPS,
            "location_fixes": est["fixes"],
            "location_spread_m": est["spread_m"],
            "location_updated": now,
            "location_flag": flag,
        }, update_modified=False)

    summary["flagged_traps"].sort(key=lambda r: -r["distance_m"])
    return summary


@frappe.whitelist()
def estimate_trap_locations(farm=None, trap=None, dry_run=1):
    """Desk/API entry point. dry_run defaults to on; pass dry_run=0 to write."""
    frappe.only_for(RUN_ROLES)
    dry = str(dry_run).strip().lower() not in ("0", "false", "no", "")
    summary = run_estimate(farm=farm or None, trap=trap or None, dry_run=dry)
    summary.pop("spreads", None)
    summary["flagged_traps"] = summary["flagged_traps"][:25]
    return summary


def daily_refresh():
    """Scheduler: refine every GPS estimate with the day's new fixes."""
    run_estimate(dry_run=False)
    frappe.db.commit()


@frappe.whitelist()
def get_trap_locations(farm=None):
    """{trap: {lat, lng, source, fixes, spread_m, flag, trap_number, unit_type, unit,
    unit_geometry}} for every trap that has a place on the map. A trap hung on a unit
    (Trap.unit) sits at that unit's centre and carries its geometry (hexagon, tree point,
    bed line); otherwise it sits at its fixed location (Trap.geojson). Maps draw a trap here
    instead of at its entries' average."""
    from upande_scp.serverscripts.traps.trap_units import trap_unit_payload

    filters = {}
    if farm:
        filters["farm"] = farm
    fields = ["name", "trap_number", "geojson", "location_source", "location_fixes",
              "location_spread_m", "location_flag"]
    has_unit = frappe.db.has_column("Trap", "unit")
    if has_unit:
        fields += ["unit_type", "unit"]
    out = {}
    for t in frappe.get_all(
        "Trap", filters=filters, or_filters=(
            [["geojson", "is", "set"], ["unit", "is", "set"]] if has_unit else [["geojson", "is", "set"]]
        ),
        fields=fields, limit_page_length=0,
    ):
        u = trap_unit_payload(t) if has_unit and t.get("unit") else None
        if u and u["lat"] is not None:
            lat, lng = u["lat"], u["lng"]
        else:
            p = G.point_of(t.geojson) if t.geojson else None
            if not p:
                continue
            lat, lng = p
        out[t.name] = {
            "lat": lat, "lng": lng, "source": "Unit" if u and u["unit_geometry"] else (t.location_source or ""),
            "fixes": int(t.location_fixes or 0),
            "spread_m": float(t.location_spread_m or 0),
            "flag": t.location_flag or "",
            "trap_number": t.trap_number or "",
            "unit_type": u["unit_type"] if u else "",
            "unit": u["unit"] if u else "",
            "unit_geometry": u["unit_geometry"] if u else None,
        }
    return out
