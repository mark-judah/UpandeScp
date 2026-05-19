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


def _assert_same_company(company: str, refs: list[tuple[str, str | None]]) -> None:
    """Check that every (label, warehouse_or_kit_name) pair resolves to ``company``.

    `refs` is a list of ``(human_label, warehouse_name)`` tuples. Empty
    warehouse values are skipped. Each warehouse's ``company`` field must
    equal ``company`` or we throw a clear cross-company error.
    """
    for label, warehouse in refs:
        if not warehouse:
            continue
        wh_company = frappe.db.get_value("Warehouse", warehouse, "company")
        if wh_company and wh_company != company:
            frappe.throw(
                f"{label} '{warehouse}' belongs to company '{wh_company}', but "
                f"this plan is for '{company}'. All warehouses on a spray plan "
                "must belong to the same company.",
                title="Cross-company warehouse",
            )


def _coerce_date_str(value) -> str:
    """Return a YYYY-MM-DD string for a date-ish input, or empty string.

    Accepts ISO strings ("2026-05-19T08:00:00"), date strings, datetime /
    date objects (as returned by frappe.db when reading Datetime/Date
    columns). Falsy inputs return "".
    """
    if not value:
        return ""
    if hasattr(value, "date") and callable(value.date):
        try:
            return value.date().isoformat()
        except Exception:
            pass
    if hasattr(value, "isoformat") and callable(value.isoformat):
        try:
            return value.isoformat()[:10]
        except Exception:
            pass
    s = str(value).strip()
    if "T" in s:
        s = s.split("T", 1)[0]
    if " " in s:
        s = s.split(" ", 1)[0]
    return s[:10]


def _find_same_day_duplicates(
    greenhouse: str | None,
    scheduled_iso,
    *,
    exclude_wo: str | None = None,
) -> list[str]:
    """Return the names of other Application-Floor-Plan Work Orders that
    target the same greenhouse on the same calendar day.

    Looks at every WO (own + others) that hasn't been cancelled, so the
    planner sees conflicts across the whole farm. Returns an empty list
    when either input is missing. ``scheduled_iso`` may be a string or a
    ``datetime``.
    """
    if not greenhouse:
        return []
    target_date = _coerce_date_str(scheduled_iso)
    if not target_date:
        return []
    rows = frappe.db.sql(
        """SELECT name FROM `tabWork Order`
           WHERE custom_type = 'Application Floor Plan'
             AND docstatus < 2
             AND custom_greenhouse = %s
             AND DATE(custom_scheduled_application_time) = %s
             AND (%s = '' OR name != %s)
           ORDER BY creation DESC
           LIMIT 10""",
        (greenhouse, target_date, exclude_wo or "", exclude_wo or ""),
    )
    return [r[0] for r in rows]


def _build_duplicate_warning(wo_names: list[str], greenhouse: str, scheduled_iso) -> str | None:
    if not wo_names:
        return None
    date = _coerce_date_str(scheduled_iso)
    others = ", ".join(wo_names[:3])
    extra = f" +{len(wo_names) - 3} more" if len(wo_names) > 3 else ""
    return (
        f"Heads up: {len(wo_names)} other plan(s) already exist for "
        f"{greenhouse} on {date} ({others}{extra})."
    )


def _resolve_kit_warehouse(kit_name: str | None) -> str | None:
    """Look up the warehouse linked to a spray kit. Returns None if the kit
    isn't recognised — the WO will still insert (wip_warehouse stays empty)
    and the operator can fix the kit/warehouse mapping later."""
    if not kit_name:
        return None
    return frappe.db.get_value(
        "Spray Equipment Details", {"kit": kit_name}, "warehouse"
    )


def _derive_plan_company(payload: dict) -> str:
    """Return the Company for a draft plan, derived from the greenhouse.

    Throws if the greenhouse isn't linked to a company.
    """
    greenhouse = payload.get("custom_greenhouse")
    if not greenhouse:
        frappe.throw("Greenhouse is required to derive Company.")
    company = frappe.db.get_value("Warehouse", greenhouse, "company")
    if not company:
        frappe.throw(
            f"Warehouse '{greenhouse}' has no Company set. Configure the "
            "greenhouse's company before creating spray plans for it.",
            title="Warehouse misconfigured",
        )
    return company


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
            # CRITICAL: without this, ERPNext's make_stock_entry skips the
            # row when building Material Transfer for Manufacture, returning
            # an SE with empty items that then fails MandatoryError on insert.
            "include_item_in_manufacturing": 1,
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

    company = _derive_plan_company(payload)
    cost_center = derive_cost_center(payload["custom_greenhouse"])

    # The frontend sends `production_item` as a BOM name (Chemical Mix BOM).
    # ERPNext's Work Order expects `production_item` to be an Item code and
    # the BOM separately as `bom_no`. Resolve the BOM to its FG item here.
    bom_name = payload.get("production_item")
    bom_meta = frappe.db.get_value(
        "BOM", bom_name, ["item", "name", "company"], as_dict=True
    ) if bom_name else None
    if not bom_meta:
        frappe.throw(
            f"BOM {bom_name!r} not found. Pick a valid Chemical Mix tank mix.",
            title="Invalid tank mix",
        )
    if bom_meta.get("company") and bom_meta["company"] != company:
        frappe.throw(
            f"Tank mix '{bom_meta['name']}' belongs to company "
            f"'{bom_meta['company']}', but the greenhouse is for '{company}'. "
            "Pick a tank mix for the same company.",
            title="Cross-company tank mix",
        )

    # Reject any cross-company warehouse references up-front so the user
    # gets a clear error instead of ERPNext's cryptic InvalidWarehouseCompany.
    chem_sources = [
        ((c.get("source_warehouse") or c.get("source")) or None)
        for c in (payload.get("chemicals") or [])
    ]
    _assert_same_company(company, [
        ("Greenhouse", payload["custom_greenhouse"]),
        *[(f"Chemical source {i + 1}", w) for i, w in enumerate(chem_sources)],
    ])

    # Derive WIP warehouse from the picked kit (Spray Equipment Details.warehouse)
    # so ERPNext's make_stock_entry has a target for the Material Transfer.
    wip_warehouse = _resolve_kit_warehouse(payload.get("custom_kit"))

    wo = frappe.new_doc("Work Order")
    wo.flags.ignore_mandatory = True
    wo.company = company
    wo.custom_type = "Application Floor Plan"
    wo.workflow_state = "Pending Submission"
    wo.production_item = bom_meta["item"]
    wo.bom_no = bom_meta["name"]
    wo.qty = 1
    wo.custom_cost_center = cost_center
    wo.fg_warehouse = payload["custom_greenhouse"]
    if wip_warehouse:
        wo.wip_warehouse = wip_warehouse
    _apply_payload(wo, payload)
    wo.insert(ignore_permissions=True)

    warnings: list[str] = []
    dup_warning = _build_duplicate_warning(
        _find_same_day_duplicates(
            payload.get("custom_greenhouse"),
            payload.get("custom_scheduled_application_time"),
            exclude_wo=wo.name,
        ),
        payload["custom_greenhouse"],
        payload.get("custom_scheduled_application_time"),
    )
    if dup_warning:
        warnings.append(dup_warning)

    return {"work_order": wo.name, "summary": _summarize(wo), "warnings": warnings}


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
        dups = _find_same_day_duplicates(
            r["greenhouse"], r["scheduled_date"], exclude_wo=r["name"],
        )
        r["has_warnings"] = bool(dups)
        r["warning_text"] = _build_duplicate_warning(
            dups, r["greenhouse"], r["scheduled_date"],
        )
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

    company = _derive_plan_company(payload) if payload.get("custom_greenhouse") else wo.company
    if payload.get("custom_greenhouse"):
        wo.company = company
        wo.custom_cost_center = derive_cost_center(payload["custom_greenhouse"])

    # See create_draft_spray_plan: the payload `production_item` is the BOM
    # name; the WO needs the BOM's FG Item code on `production_item` and the
    # BOM name on `bom_no`.
    bom_name = payload.get("production_item")
    if bom_name and bom_name != wo.bom_no:
        bom_meta = frappe.db.get_value(
            "BOM", bom_name, ["item", "name", "company"], as_dict=True
        )
        if not bom_meta:
            frappe.throw(
                f"BOM {bom_name!r} not found. Pick a valid Chemical Mix tank mix.",
                title="Invalid tank mix",
            )
        if bom_meta.get("company") and bom_meta["company"] != company:
            frappe.throw(
                f"Tank mix '{bom_meta['name']}' belongs to company "
                f"'{bom_meta['company']}', but this plan is for '{company}'. "
                "Pick a tank mix for the same company.",
                title="Cross-company tank mix",
            )
        wo.production_item = bom_meta["item"]
        wo.bom_no = bom_meta["name"]

    chem_sources = [
        ((c.get("source_warehouse") or c.get("source")) or None)
        for c in (payload.get("chemicals") or [])
    ]
    _assert_same_company(company, [
        ("Greenhouse", payload.get("custom_greenhouse") or wo.custom_greenhouse),
        *[(f"Chemical source {i + 1}", w) for i, w in enumerate(chem_sources)],
    ])

    _apply_payload(wo, payload)
    wo.flags.ignore_mandatory = True
    wo.save(ignore_permissions=True)

    warnings: list[str] = []
    gh_for_check = payload.get("custom_greenhouse") or wo.custom_greenhouse
    sched_for_check = (
        payload.get("custom_scheduled_application_time")
        or wo.custom_scheduled_application_time
    )
    dup_warning = _build_duplicate_warning(
        _find_same_day_duplicates(gh_for_check, sched_for_check, exclude_wo=wo.name),
        gh_for_check,
        sched_for_check,
    )
    if dup_warning:
        warnings.append(dup_warning)
    return {"work_order": wo.name, "summary": _summarize(wo), "warnings": warnings}


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
