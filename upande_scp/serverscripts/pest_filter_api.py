"""Whitelisted helpers for editing per-crop Pest Filter stages from the desk.

Frappe's nested editable grid inside an expanded row form fails to resolve
the inner grid's docfield (Uncaught TypeError on `df.permlevel`), so the
Crop Scouted form uses a dialog-based editor that calls these methods to
read/write stages on a Pest Filter row directly.
"""

from __future__ import annotations

import json
from typing import Any

import frappe


def _resolve_filter_row(filter_row_name: str) -> dict[str, Any]:
    if not filter_row_name:
        frappe.throw("filter_row_name is required")
    row = frappe.db.get_value(
        "Pest Filter",
        filter_row_name,
        ["name", "parent", "parenttype", "pest"],
        as_dict=True,
    )
    if not row:
        frappe.throw(f"Pest Filter row {filter_row_name!r} not found")
    return row


def _check_parent_write_permission(row: dict[str, Any]) -> None:
    if row.get("parenttype") and row.get("parent"):
        if not frappe.has_permission(row["parenttype"], "write", doc=row["parent"]):
            frappe.throw(
                f"Not permitted to edit {row['parenttype']} '{row['parent']}'"
            )


@frappe.whitelist()
def get_pest_filter_stages(filter_row_name: str) -> list[dict[str, Any]]:
    """Return the stages currently configured on a Pest Filter row."""
    row = _resolve_filter_row(filter_row_name)
    if not frappe.has_permission(row.get("parenttype") or "Crop Scouted", "read", doc=row.get("parent")):
        frappe.throw("Not permitted")
    return frappe.get_all(
        "Pests Stages",
        filters={"parent": filter_row_name, "parenttype": "Pest Filter"},
        fields=["stage", "reading_type", "plant_sections", "symbol", "image", "idx"],
        order_by="idx",
    )


@frappe.whitelist()
def set_pest_filter_stages(filter_row_name: str, stages: Any) -> dict[str, Any]:
    """Replace all stages on a Pest Filter row.

    `stages` is a list of dicts (or JSON string of one). Each dict has
    `stage`, optional `reading_type` (defaults Count), and optional
    `plant_sections`/`symbol`/`image`.
    """
    row = _resolve_filter_row(filter_row_name)
    _check_parent_write_permission(row)

    if isinstance(stages, str):
        stages = json.loads(stages or "[]")
    if not isinstance(stages, list):
        frappe.throw("stages must be a list")

    # Sanitise + drop blank rows
    cleaned = []
    for s in stages:
        if not isinstance(s, dict):
            continue
        stage_name = (s.get("stage") or "").strip()
        if not stage_name:
            continue
        cleaned.append(
            {
                "stage": stage_name,
                "reading_type": s.get("reading_type") or "Count",
                "plant_sections": s.get("plant_sections") or "",
                "symbol": s.get("symbol") or "",
                "image": s.get("image") or "",
            }
        )

    frappe.db.delete(
        "Pests Stages",
        {"parent": filter_row_name, "parenttype": "Pest Filter"},
    )
    for idx, s in enumerate(cleaned, start=1):
        ps = frappe.new_doc("Pests Stages")
        ps.parent = filter_row_name
        ps.parenttype = "Pest Filter"
        ps.parentfield = "stages"
        ps.idx = idx
        ps.stage = s["stage"]
        ps.reading_type = s["reading_type"]
        ps.plant_sections = s["plant_sections"]
        ps.symbol = s["symbol"]
        ps.image = s["image"]
        ps.db_insert()

    frappe.db.commit()

    # Drop the observation_types cache so map/heatmap pick up changes.
    try:
        from upande_scp.serverscripts.cache_utils import invalidate, K_OBSERVATION_TYPES
        invalidate(K_OBSERVATION_TYPES)
    except Exception:
        pass

    return {"ok": True, "count": len(cleaned), "filter_row_name": filter_row_name}
