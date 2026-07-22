"""Approval-page review endpoint with IRAC/FRAC resistance warnings."""
from __future__ import annotations

import frappe
from frappe.utils import add_days, get_datetime, now_datetime

from upande_scp.serverscripts.spray_plan_creator.quantities import absolute_to_rate

# Table MultiSelect child doctypes for Item IRAC/FRAC codes
_IRAC_CHILD_TABLE = "IRAC Code Filter"
_FRAC_CHILD_TABLE = "FRAC Code Filter"


@frappe.whitelist()
def get_approval_review(wo_name: str) -> dict:
    wo = frappe.get_doc("Work Order", wo_name)
    if wo.custom_type != "Application Floor Plan":
        frappe.throw("This endpoint only supports Application Floor Plan work orders.")

    settings = frappe.get_single("Scouting and Crop Protection Settings")
    irac_window = settings.irac_rotation_window_days or 14
    frac_window = settings.frac_rotation_window_days or 21

    chemicals = []
    for r in (wo.required_items or []):
        item_exists = frappe.db.exists("Item", r.item_code)
        lower = frappe.db.get_value("Item", r.item_code, "custom_lower_rate_limit") if item_exists else None
        upper = frappe.db.get_value("Item", r.item_code, "custom_upper_rate_limit") if item_exists else None
        lower = lower or None
        upper = upper or None

        # Fetch IRAC codes for this item via child table (live DB col: irac_code)
        irac_codes = _get_item_codes(r.item_code, _IRAC_CHILD_TABLE, "custom_irac", "irac_code") if item_exists else []
        # Fetch FRAC codes for this item via child table (live DB col: frac_code)
        frac_codes = _get_item_codes(r.item_code, _FRAC_CHILD_TABLE, "custom_frac", "frac_code") if item_exists else []

        # Rate limits (custom_lower_rate_limit/custom_upper_rate_limit) are
        # per-1000 L; required_qty is the absolute, so derive the rate to compare.
        rate = absolute_to_rate(r.required_qty, wo.custom_water_volume)
        rate_status = "ok"
        if rate is not None:
            if lower is not None and rate < lower:
                rate_status = "below"
            if upper is not None and rate > upper:
                rate_status = "above"

        warnings: list[dict] = []
        for irac_code in irac_codes:
            warnings += _detect_resistance_warnings(
                wo.custom_greenhouse, exclude_wo=wo.name,
                code_kind="irac", code_value=irac_code,
                window_days=irac_window,
            )
        for frac_code in frac_codes:
            warnings += _detect_resistance_warnings(
                wo.custom_greenhouse, exclude_wo=wo.name,
                code_kind="frac", code_value=frac_code,
                window_days=frac_window,
            )

        chemicals.append({
            "item_code": r.item_code,
            "item_name": r.item_name,
            "application_rate": rate,
            "stock_uom": r.stock_uom,
            "rate_limits": {"lower": lower, "upper": upper} if (lower or upper) else None,
            "rate_status": rate_status,
            "irac_codes": irac_codes,
            "frac_codes": frac_codes,
            # Convenience single-value aliases (first code, for backwards compat)
            "irac_code": irac_codes[0] if irac_codes else None,
            "frac_code": frac_codes[0] if frac_codes else None,
            "resistance_warnings": warnings,
        })

    plan_warnings: list[str] = []
    irac_violations = sum(1 for c in chemicals for w in c["resistance_warnings"] if w["kind"] == "irac")
    frac_violations = sum(1 for c in chemicals for w in c["resistance_warnings"] if w["kind"] == "frac")
    rate_violations = sum(1 for c in chemicals if c["rate_status"] != "ok")
    if irac_violations:
        plan_warnings.append(f"{irac_violations} IRAC rotation warning(s)")
    if frac_violations:
        plan_warnings.append(f"{frac_violations} FRAC rotation warning(s)")
    if rate_violations:
        plan_warnings.append(f"{rate_violations} rate out-of-range")

    return {
        "work_order": {
            "name": wo.name,
            "greenhouse": wo.custom_greenhouse,
            "scheduled_date": wo.custom_scheduled_application_time,
            "classification": wo.custom_classification,
            "preventive_reason": wo.custom_preventive_reason,
            "weather_snapshot": frappe.parse_json(wo.custom_weather_snapshot or "null"),
            "team_members": [
                {"employee": m.employee, "employee_name": m.employee_name, "role": m.role}
                for m in (wo.custom_spray_plan_team_members or [])
            ],
            "targets": (wo.custom_targets or "").split("\n") if wo.custom_targets else [],
        },
        "chemicals": chemicals,
        "plan_warnings": plan_warnings,
    }


def _get_item_codes(item_code: str, child_table: str, parent_field: str,
                    code_col: str) -> list[str]:
    """Return the list of code values from a Table MultiSelect child table for an Item.

    ``code_col`` is the actual DB column that holds the code value.  This differs
    between the two child tables:
      - ``tabIRAC Code Filter``: column ``irac_code``
      - ``tabFRAC Code Filter``: column ``frac_code``
    """
    rows = frappe.db.sql(
        f"SELECT `{code_col}` AS code"
        f" FROM `tab{child_table}`"
        f" WHERE parent=%s AND parenttype='Item' AND parentfield=%s",
        (item_code, parent_field),
        as_dict=True,
        debug=0,
    )
    return [r["code"] for r in rows if r.get("code")]


def _detect_resistance_warnings(
    greenhouse: str | None, *, exclude_wo: str,
    code_kind: str, code_value: str,
    window_days: int,
) -> list[dict]:
    """Check for prior WOs in the given window on the same greenhouse using the same code."""
    if not greenhouse or not code_value:
        return []
    if code_kind == "irac":
        child_table = _IRAC_CHILD_TABLE
        parent_field = "custom_irac"
        code_col = "irac_code"
    else:
        child_table = _FRAC_CHILD_TABLE
        parent_field = "custom_frac"
        code_col = "frac_code"

    cutoff = add_days(now_datetime(), -window_days)
    rows = frappe.db.sql(
        f"""SELECT wo.name AS wo,
                   wo.custom_scheduled_application_time AS sched,
                   wi.item_code AS item_code,
                   item.item_name AS item_name
            FROM `tabWork Order` wo
            INNER JOIN `tabWork Order Item` wi ON wi.parent = wo.name
            INNER JOIN `tabItem` item ON item.name = wi.item_code
            INNER JOIN `tab{child_table}` cf
                    ON cf.parent = wi.item_code
                   AND cf.parenttype = 'Item'
                   AND cf.parentfield = %s
                   AND cf.`{code_col}` = %s
            WHERE wo.custom_greenhouse = %s
              AND wo.name != %s
              AND wo.custom_type = 'Application Floor Plan'
              AND wo.workflow_state IN ('Approved', 'Chemical Issued', 'Tank Mix Manufactured',
                                        'Spraying In Progress', 'Completed')
              AND wo.custom_scheduled_application_time >= %s
            ORDER BY wo.custom_scheduled_application_time DESC
            LIMIT 1""",
        (parent_field, code_value, greenhouse, exclude_wo, cutoff),
        as_dict=True,
        debug=0,
    )
    if not rows:
        return []
    r = rows[0]
    sched = get_datetime(r["sched"]) if r["sched"] else None
    days_ago = (now_datetime() - sched).days if sched else None
    return [{
        "kind": code_kind,
        "code": code_value,
        "severity": "warning",
        "message": (
            f"{code_kind.upper()} {code_value} used {days_ago} day(s) ago on this greenhouse "
            f"({r['wo']}, '{r['item_name']}')"
        ),
        "prior_wo": r["wo"],
        "days_ago": days_ago,
    }]
