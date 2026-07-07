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
        # Older sites that haven't migrated may not have the approver
        # child table yet — guard the read so this endpoint stays usable
        # before fixtures sync.
        if frappe.db.table_exists("Farm Spray Plan Approver"):
            approvers = frappe.get_all(
                "Farm Spray Plan Approver",
                filters={"parent": f["name"], "parenttype": "Farm"},
                fields=["user", "full_name"],
            )
        else:
            approvers = []
        store_keepers = frappe.get_all(
            "Farm Store Keeper",
            filters={"parent": f["name"], "parenttype": "Farm"},
            fields=["user", "full_name"],
        )
        farm_stores = frappe.db.get_value(
            "Farm", f["name"],
            ["custom_chemical_store", "custom_fertilizer_store"], as_dict=True
        ) or {}
        out.append({
            "farm": f["name"],
            "farm_name": f.get("farm"),
            "business_unit": f.get("custom_business_unit") or "",
            "creators": creators,
            "approvers": approvers,
            "store_keepers": store_keepers,
            "chemical_store": farm_stores.get("custom_chemical_store"),
            "fertilizer_store": farm_stores.get("custom_fertilizer_store"),
        })
    return out


@frappe.whitelist()
def list_spray_plan_creator_candidates(q: str | None = None) -> list[dict]:
    return _candidates_for_role("Spray Plan Creator", q)


@frappe.whitelist()
def list_spray_plan_approver_candidates(q: str | None = None) -> list[dict]:
    return _candidates_for_role("Spray Plan Approver", q)


def _candidates_for_role(role: str, q: str | None) -> list[dict]:
    _require_admin()
    q = (q or "").strip()
    base_sql = """
        SELECT u.name AS user, u.full_name, u.email
        FROM `tabUser` AS u
        INNER JOIN `tabHas Role` AS r
          ON r.parent = u.name AND r.role = %s
        WHERE u.enabled = 1
    """
    params: list = [role]
    if q:
        base_sql += " AND (u.name LIKE %s OR u.full_name LIKE %s OR u.email LIKE %s)"
        like = f"%{q}%"
        params += [like, like, like]
    base_sql += " ORDER BY u.full_name LIMIT 50"
    return frappe.db.sql(base_sql, params, as_dict=True)


@frappe.whitelist()
def set_farm_creators(farm: str, users: list[str] | str) -> dict:
    return _set_farm_roster(
        farm,
        users,
        role="Spray Plan Creator",
        child_field="spray_plan_creators",
    )


@frappe.whitelist()
def set_farm_approvers(farm: str, users: list[str] | str) -> dict:
    result = _set_farm_roster(
        farm,
        users,
        role="Spray Plan Approver",
        child_field="spray_plan_approvers",
    )
    # Caller (AccessTab) expects ``approvers`` to mirror the ``creators``
    # shape from set_farm_creators — keep the field naming explicit.
    return {"farm": result["farm"], "approvers": result["roster"]}


def _set_farm_roster(
    farm: str,
    users: list[str] | str,
    role: str,
    child_field: str,
) -> dict:
    _require_admin()
    if isinstance(users, str):
        users = frappe.parse_json(users) or []

    bad: list[str] = []
    for u in users:
        roles = {r.role for r in frappe.get_all(
            "Has Role", filters={"parent": u}, fields=["role"]
        )}
        if role not in roles:
            bad.append(u)
    if bad:
        frappe.throw(
            f"These users do not have the '{role}' role: {', '.join(bad)}.",
            title="Role required",
        )

    farm_doc = frappe.get_doc("Farm", farm)
    farm_doc.set(child_field, [])
    for u in users:
        farm_doc.append(child_field, {"user": u})
    farm_doc.save(ignore_permissions=True)
    farm_doc.reload()
    return {
        "farm": farm,
        "roster": [
            {"user": r.user, "full_name": r.full_name}
            for r in farm_doc.get(child_field) or []
        ],
        # Back-compat alias for callers (and tests) that expect the
        # creator-shaped response from set_farm_creators.
        "creators": [
            {"user": r.user, "full_name": r.full_name}
            for r in farm_doc.get(child_field) or []
        ] if child_field == "spray_plan_creators" else [],
    }


@frappe.whitelist()
def list_store_keeper_candidates(q: str | None = None) -> list[dict]:
    return _candidates_for_role("Store Keeper", q)


@frappe.whitelist()
def set_farm_store_keepers(farm: str, users: list[str] | str) -> dict:
    return _set_farm_roster(
        farm,
        users,
        role="Store Keeper",
        child_field="store_keepers",
    )


@frappe.whitelist()
def list_store_warehouse_candidates(q: str | None = None) -> list[dict]:
    _require_admin()
    filters = {
        "is_group": 0,
        "disabled": 0,
        "warehouse_type": ("not in", ["Greenhouse", "Work In Progress"]),
    }
    if q:
        filters["name"] = ("like", f"%{q}%")
    return frappe.get_all(
        "Warehouse", filters=filters, fields=["name", "custom_farm"],
        order_by="custom_farm, name", limit_page_length=200,
    )


@frappe.whitelist()
def set_farm_stores(farm: str, chemical_store: str | None = None, fertilizer_store: str | None = None) -> dict:
    _require_admin()
    doc = frappe.get_doc("Farm", farm)
    doc.custom_chemical_store = chemical_store or None
    doc.custom_fertilizer_store = fertilizer_store or None
    doc.save(ignore_permissions=True)
    return {
        "farm": farm,
        "chemical_store": doc.custom_chemical_store,
        "fertilizer_store": doc.custom_fertilizer_store,
    }
