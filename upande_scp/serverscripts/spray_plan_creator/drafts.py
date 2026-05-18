"""CRUD endpoints for draft Spray Plan Work Orders (workflow_state='Pending Submission')."""
from __future__ import annotations

import json

import frappe

from .scope import _resolve_user_scope
from .validation import (
    derive_cost_center, validate_preventive_reason, validate_rate_in_limits,
    validate_targets_in_scope,
)


def _require_creator() -> str:
    user = frappe.session.user
    if user == "Administrator":
        return user
    # Use a direct DB query (bypassing the role cache) so that roles added in
    # the same test session are visible immediately.
    has_role = frappe.db.exists(
        "Has Role",
        {"parenttype": "User", "parent": user, "role": "Spray Plan Creator"},
    )
    if not has_role:
        frappe.throw("Only Spray Plan Creator can use this endpoint.", title="Forbidden")
    return user


def _assert_in_scope(payload: dict, scope: dict) -> None:
    gh = payload.get("custom_greenhouse")
    if not gh:
        frappe.throw("Greenhouse is required.")
    if not scope["warehouses"]:
        frappe.throw(f"Greenhouse {gh} is outside your farm scope.", title="Out of scope")
    if gh not in {w["name"] for w in scope["warehouses"]}:
        frappe.throw(f"Greenhouse {gh} is outside your farm scope.", title="Out of scope")
    # Kit (if provided) must be in a warehouse in scope. Kits live in
    # `Spray Equipment Details` (Data field `kit`), but we only check by
    # warehouse - the kit lookup is via custom_kit string.
    team = payload.get("custom_spray_team")
    if team:
        team_farm = frappe.db.get_value("Spray Team", team, "custom_farm")
        if team_farm and team_farm not in scope["farms"]:
            frappe.throw(f"Team {team} belongs to a farm outside your scope.",
                         title="Out of scope")


def _own_draft(wo_name: str) -> "frappe.Document":
    wo = frappe.get_doc("Work Order", wo_name)
    if wo.owner != frappe.session.user and frappe.session.user != "Administrator":
        frappe.throw("You can only modify your own drafts.", title="Forbidden")
    if wo.workflow_state != "Pending Submission":
        frappe.throw("This plan has moved past Pending Submission and cannot be edited.")
    return wo


def _apply_payload(wo, payload: dict) -> None:
    pass_fields = [
        "custom_greenhouse", "custom_classification", "custom_preventive_reason",
        "custom_spray_type", "custom_scope", "custom_scope_details",
        "custom_kit", "custom_spray_team",
        "custom_water_ph", "custom_water_hardness", "custom_water_volume", "custom_area",
        "custom_scheduled_application_time",
    ]
    for f in pass_fields:
        if f in payload:
            wo.set(f, payload[f])

    targets = payload.get("custom_targets") or []
    if isinstance(targets, list):
        wo.custom_targets = "\n".join(targets)
    elif isinstance(targets, str):
        wo.custom_targets = targets

    snap = payload.get("custom_weather_snapshot")
    wo.custom_weather_snapshot = json.dumps(snap) if isinstance(snap, dict) else (snap or "")

    chems = payload.get("chemicals") or []
    wo.required_items = []
    rate_overridden = False
    for c in chems:
        wo.append("required_items", {
            "item_code": c["item_code"],
            "item_name": c.get("item_name"),
            "stock_uom": c.get("uom") or c.get("stock_uom"),
            "source_warehouse": c.get("source_warehouse") or c.get("source"),
            "required_qty": c.get("application_rate") or c.get("rate") or c.get("qty") or 0,
        })
        if c.get("_rate_differs_from_bom"):
            rate_overridden = True
    wo.custom_rate_overridden = 1 if rate_overridden else 0


def _validate_payload(payload: dict, scope: dict) -> None:
    classification = payload.get("custom_classification") or ""
    validate_preventive_reason(classification, payload.get("custom_preventive_reason"))
    if not payload.get("_skip_target_validation"):
        validate_targets_in_scope(
            classification,
            payload.get("custom_targets") or [],
            greenhouse=payload.get("custom_greenhouse"),
        )
    if not payload.get("_skip_bom_validation"):
        bom = payload.get("production_item")
        if not bom:
            frappe.throw("Tank mix (BOM) is required.")
        if not frappe.db.exists("BOM", {"name": bom, "docstatus": 1, "is_active": 1}):
            frappe.throw(f"BOM {bom} is not active.")
    chems = payload.get("chemicals") or []
    if not chems and not payload.get("_allow_zero_chems"):
        frappe.throw("Add at least one chemical to the plan.")
    limits = {}
    for c in chems:
        validate_rate_in_limits(
            c.get("item_code"), c.get("application_rate") or c.get("rate") or 0, limits
        )


@frappe.whitelist()
def create_draft_spray_plan(payload):
    user = _require_creator()
    if isinstance(payload, str):
        payload = frappe.parse_json(payload)
    scope = _resolve_user_scope(user)
    if not scope["farms"] and user != "Administrator":
        frappe.throw("You have no farm access. Please contact an Administrator.", title="No access")
    _assert_in_scope(payload, scope)
    _validate_payload(payload, scope)

    cost_center = derive_cost_center(payload["custom_greenhouse"])

    wo = frappe.new_doc("Work Order")
    wo.flags.ignore_mandatory = True
    wo.custom_type = "Application Floor Plan"
    wo.workflow_state = "Pending Submission"
    wo.production_item = payload.get("production_item")
    wo.qty = 1
    wo.custom_cost_center = cost_center
    _apply_payload(wo, payload)
    wo.insert(ignore_permissions=True)

    return {"work_order": wo.name, "summary": _summarize(wo)}


@frappe.whitelist()
def list_my_draft_plans() -> list[dict]:
    user = _require_creator()
    rows = frappe.get_all(
        "Work Order",
        filters={
            "owner": user,
            "docstatus": 0,
            "workflow_state": "Pending Submission",
            "custom_type": "Application Floor Plan",
        },
        fields=[
            "name", "custom_greenhouse", "custom_classification", "custom_targets",
            "custom_scheduled_application_time", "custom_water_volume",
        ],
        order_by="creation desc",
        limit=200,
    )
    for r in rows:
        r["chemical_count"] = frappe.db.count("Work Order Item", {"parent": r["name"]})
        r["greenhouse"] = r.pop("custom_greenhouse")
        r["classification"] = r.pop("custom_classification")
        r["targets"] = (r.pop("custom_targets") or "").split("\n") if r.get("custom_targets") else []
        r["scheduled_date"] = r.pop("custom_scheduled_application_time")
        r["total_water_volume"] = r.pop("custom_water_volume")
        r["has_warnings"] = False
    return rows


@frappe.whitelist()
def get_draft_plan(name: str) -> dict:
    _require_creator()
    wo = _own_draft(name)
    return _expand_wo(wo)


@frappe.whitelist()
def update_draft_plan(name: str, payload):
    user = _require_creator()
    if isinstance(payload, str):
        payload = frappe.parse_json(payload)
    wo = _own_draft(name)
    scope = _resolve_user_scope(user)
    _assert_in_scope(payload, scope)
    _validate_payload(payload, scope)

    if payload.get("custom_greenhouse"):
        wo.custom_cost_center = derive_cost_center(payload["custom_greenhouse"])

    _apply_payload(wo, payload)
    wo.flags.ignore_mandatory = True
    wo.save(ignore_permissions=True)
    return {"work_order": wo.name, "summary": _summarize(wo)}


@frappe.whitelist()
def delete_draft_plan(name: str) -> dict:
    _require_creator()
    wo = _own_draft(name)
    frappe.delete_doc("Work Order", wo.name, force=1, ignore_permissions=True)
    return {"deleted": name}


def _summarize(wo) -> dict:
    return {
        "name": wo.name,
        "greenhouse": wo.custom_greenhouse,
        "classification": wo.custom_classification,
        "scheduled_date": wo.custom_scheduled_application_time,
        "chemical_count": len(wo.required_items or []),
    }


def _expand_wo(wo) -> dict:
    return {
        "name": wo.name,
        "custom_greenhouse": wo.custom_greenhouse,
        "custom_classification": wo.custom_classification,
        "custom_preventive_reason": wo.custom_preventive_reason,
        "custom_spray_type": wo.custom_spray_type,
        "custom_scope": wo.custom_scope,
        "custom_scope_details": wo.custom_scope_details,
        "custom_kit": wo.custom_kit,
        "custom_spray_team": wo.custom_spray_team,
        "custom_water_ph": wo.custom_water_ph,
        "custom_water_hardness": wo.custom_water_hardness,
        "custom_water_volume": wo.custom_water_volume,
        "custom_area": wo.custom_area,
        "custom_targets": (wo.custom_targets or "").split("\n") if wo.custom_targets else [],
        "production_item": wo.production_item,
        "custom_cost_center": wo.custom_cost_center,
        "custom_scheduled_application_time": wo.custom_scheduled_application_time,
        "custom_rate_overridden": wo.custom_rate_overridden,
        "custom_weather_snapshot": frappe.parse_json(wo.custom_weather_snapshot or "null"),
        "chemicals": [
            {
                "item_code": r.item_code, "item_name": r.item_name,
                "stock_uom": r.stock_uom, "source_warehouse": r.source_warehouse,
                "application_rate": r.required_qty,
            }
            for r in (wo.required_items or [])
        ],
    }
