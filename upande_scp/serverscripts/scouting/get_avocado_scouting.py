"""Avocado-only scouting payload for the 3D orchard map.

Returns just the rows the avocado page needs — no zone GeoJSON, no
greenhouse-shaped summaries. Filters on `crop_scouted = "Avocado"` server-side
so the payload stays small even on busy days.
"""

import frappe
from frappe.utils import time_diff_in_seconds


@frappe.whitelist()
def get_avocado_scouting():
    date_str = frappe.form_dict.get("date")
    if not date_str:
        frappe.throw("The date is required.")

    block = frappe.form_dict.get("block") or ""

    filters = {
        "date_of_capture": date_str,
        "crop_scouted": "Avocado",
    }
    if block:
        filters["block"] = block

    entries = frappe.get_all(
        "Scouting Entry",
        fields=[
            "name", "scouts_name", "tree", "block", "row",
            "time_of_capture", "date_of_capture",
            "latitude", "longitude", "creation",
        ],
        filters=filters,
        order_by="time_of_capture asc",
    )

    if not entries:
        return {
            "scouting_entries": [],
            "scout_movement_timeline": [],
            "scouting_summary": {
                "total_unique_scouts": 0,
                "total_trees_scouted": 0,
                "total_blocks_covered": 0,
                "average_minutes_per_tree": 0,
            },
        }

    # Resolve scout id → employee_name (mirrors get_scouting_analysis).
    scout_ids = {e.get("scouts_name") for e in entries if e.get("scouts_name")}
    employee_map = {}
    if scout_ids:
        for emp in frappe.get_all(
            "Employee",
            filters={"name": ("in", list(scout_ids))},
            fields=["name", "employee_name"],
        ):
            employee_map[emp["name"]] = emp.get("employee_name") or emp["name"]
    for e in entries:
        sid = e.get("scouts_name")
        if sid and sid in employee_map:
            e["scouts_name"] = employee_map[sid]

    # Per-scout × per-block sessions for the timeline.
    sessions = {}
    for e in entries:
        scout = e.get("scouts_name")
        blk = e.get("block")
        t = e.get("time_of_capture")
        if not (scout and blk and t is not None):
            continue
        sessions.setdefault(scout, {}).setdefault(blk, []).append(e)

    timeline = []
    total_minutes = 0.0
    total_trees = 0
    blocks_covered = set()

    for scout, by_block in sessions.items():
        for blk, rows in by_block.items():
            rows.sort(key=lambda r: r["time_of_capture"])
            start = rows[0]["time_of_capture"]
            end = rows[-1]["time_of_capture"]
            trees_in_session = {r["tree"] for r in rows if r.get("tree")}
            seconds = time_diff_in_seconds(end, start)
            minutes = max(seconds, 0) / 60.0
            mpt = (minutes / len(trees_in_session)) if trees_in_session else 0.0

            timeline.append({
                "name": scout,
                "block": blk,
                "start": str(start),
                "end": str(end),
                "trees": len(trees_in_session),
                "minutesPerTree": round(mpt, 2),
            })
            total_minutes += minutes
            total_trees += len(trees_in_session)
            blocks_covered.add(blk)

    timeline.sort(key=lambda t: t["start"])

    summary = {
        "total_unique_scouts": len(sessions),
        "total_trees_scouted": total_trees,
        "total_blocks_covered": len(blocks_covered),
        "average_minutes_per_tree": (
            round(total_minutes / total_trees, 2) if total_trees else 0
        ),
    }

    return {
        "scouting_entries": entries,
        "scout_movement_timeline": timeline,
        "scouting_summary": summary,
    }
