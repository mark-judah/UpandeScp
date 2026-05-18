"""Whitelisted endpoints for the GM-only Spray Plan Access admin page."""
from __future__ import annotations

import frappe


def _require_admin() -> None:
    user = frappe.session.user
    if user == "Administrator":
        return
    roles = set(frappe.get_roles(user))
    if not ({"General Manager", "System Manager"} & roles):
        frappe.throw(
            "Only General Manager or System Manager can manage Spray Plan access.",
            title="Forbidden",
        )


@frappe.whitelist()
def list_farms_with_creators() -> list[dict]:
    _require_admin()
    farms = frappe.get_all(
        "Farm",
        filters={"disabled": 0} if frappe.db.has_column("Farm", "disabled") else {},
        fields=["name"] + (["farm"] if frappe.db.has_column("Farm", "farm") else [])
            + (["custom_business_unit"] if frappe.db.has_column("Farm", "custom_business_unit") else []),
        order_by="name",
    )
    out = []
    for f in farms:
        creators = frappe.get_all(
            "Farm Spray Plan Creator",
            filters={"parent": f["name"], "parenttype": "Farm"},
            fields=["user", "full_name"],
        )
        out.append({
            "farm": f["name"],
            "farm_name": f.get("farm"),
            "business_unit": f.get("custom_business_unit") or "",
            "creators": creators,
        })
    return out


@frappe.whitelist()
def list_spray_plan_creator_candidates(q: str | None = None) -> list[dict]:
    _require_admin()
    q = (q or "").strip()
    base_sql = """
        SELECT u.name AS user, u.full_name, u.email
        FROM `tabUser` AS u
        INNER JOIN `tabHas Role` AS r
          ON r.parent = u.name AND r.role = 'Spray Plan Creator'
        WHERE u.enabled = 1
    """
    params: list = []
    if q:
        base_sql += " AND (u.name LIKE %s OR u.full_name LIKE %s OR u.email LIKE %s)"
        like = f"%{q}%"
        params += [like, like, like]
    base_sql += " ORDER BY u.full_name LIMIT 50"
    return frappe.db.sql(base_sql, params, as_dict=True)


@frappe.whitelist()
def set_farm_creators(farm: str, users: list[str] | str) -> dict:
    _require_admin()
    if isinstance(users, str):
        users = frappe.parse_json(users) or []

    bad: list[str] = []
    for u in users:
        roles = {r.role for r in frappe.get_all(
            "Has Role", filters={"parent": u}, fields=["role"]
        )}
        if "Spray Plan Creator" not in roles:
            bad.append(u)
    if bad:
        frappe.throw(
            f"These users do not have the 'Spray Plan Creator' role: {', '.join(bad)}.",
            title="Role required",
        )

    farm_doc = frappe.get_doc("Farm", farm)
    farm_doc.set("spray_plan_creators", [])
    for u in users:
        farm_doc.append("spray_plan_creators", {"user": u})
    farm_doc.save(ignore_permissions=True)
    farm_doc.reload()
    return {
        "farm": farm,
        "creators": [{"user": r.user, "full_name": r.full_name} for r in farm_doc.spray_plan_creators],
    }
