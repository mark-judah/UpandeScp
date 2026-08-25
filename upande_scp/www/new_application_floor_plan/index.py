import frappe

from upande_scp.serverscripts.common.cache_utils import (
    K_AFP_SPRAY_EQUIPMENT,
    K_AFP_WAREHOUSES,
    TTL_LONG,
    get_or_set,
)
from upande_scp.serverscripts.geo.warehouse_filter import (
    gh_sort_key,
    is_greenhouse_allowed,
    load_settings,
)


def _build_spray_teams_with_members():
    teams = frappe.get_all(
        "Spray Team",
        filters={"enabled": 1},
        fields=["name", "custom_farm"],
        order_by="name",
        limit_page_length=0,
    )
    for t in teams:
        # Join onto Employee so the picker can show the real name alongside
        # the payroll number; COALESCE keeps rows visible even if an Employee
        # was renamed or deleted out from under the team.
        t["members"] = frappe.db.sql(
            """SELECT std.name1 AS employee,
                      COALESCE(emp.employee_name, std.name1) AS employee_name,
                      emp.designation AS designation,
                      std.role AS role
                 FROM `tabSpray Team Details` std
                 LEFT JOIN `tabEmployee` emp ON emp.name = std.name1
                WHERE std.parent = %s
                ORDER BY std.idx""",
            (t["name"],),
            as_dict=True,
        )
    return teams


def _build_pest_catalog():
    if not frappe.db.table_exists("Pest"):
        return []
    return frappe.get_all("Pest", fields=["name"], order_by="name")


def _build_disease_catalog():
    if not frappe.db.table_exists("Plant Disease"):
        return []
    return frappe.get_all("Plant Disease", fields=["name"], order_by="name")


def _build_cost_centers():
    """All active, non-group Cost Centers — drives the picker's options."""
    return frappe.get_all(
        "Cost Center",
        filters={"disabled": 0, "is_group": 0},
        fields=["name", "company", "custom_farm"],
        order_by="name asc",
        limit_page_length=0,
    )


def _build_warehouses():
    allowed, exclude = load_settings()
    allowed_lower = tuple(f.lower() for f in allowed)
    if not allowed_lower:
        return []
    warehouses = frappe.get_all(
        "Warehouse",
        filters={"warehouse_type": "Greenhouse"},
        fields=["name", "custom_farm", "custom_cost_center"],
        limit_page_length=0,
    )
    filtered = [
        wh
        for wh in warehouses
        if is_greenhouse_allowed(
            wh.get("name") or "",
            allowed_lower,
            exclude,
            has_farm=bool(wh.get("custom_farm")),
        )
    ]
    filtered.sort(
        key=lambda wh: gh_sort_key(wh.get("name") or "", allowed_lower),
    )
    # Cost-center resolution intentionally happens lazily on greenhouse
    # selection (see resolve_warehouse_cost_center) rather than here. Doing
    # it eagerly meant every page load paid the cost of resolving every
    # warehouse in scope — measurable on farms with many warehouses, and
    # wasteful since the operator only ever picks one.
    return filtered


def _build_spray_equipment():
    return frappe.get_all(
        "Spray Equipment Details",
        fields=["kit", "warehouse"],
        order_by="idx ASC",
        limit_page_length=0,
    )


def get_context(context):
    context.no_cache = 1
    context.csrf_token = frappe.sessions.get_csrf_token()

    context.warehouses_list = get_or_set(K_AFP_WAREHOUSES, _build_warehouses, ttl=TTL_LONG)
    context.spray_equipment_list = get_or_set(
        K_AFP_SPRAY_EQUIPMENT, _build_spray_equipment, ttl=TTL_LONG
    )
    context.spray_teams_with_members = get_or_set(
        "scp:afp_spray_teams_with_members_v2",
        _build_spray_teams_with_members,
        ttl=TTL_LONG,
    )
    context.pest_catalog = get_or_set(
        "scp:afp_pest_catalog_v1", _build_pest_catalog, ttl=TTL_LONG
    )
    context.disease_catalog = get_or_set(
        "scp:afp_disease_catalog_v1", _build_disease_catalog, ttl=TTL_LONG
    )
    context.cost_centers = get_or_set(
        "scp:afp_cost_centers_v1", _build_cost_centers, ttl=TTL_LONG
    )
    context.spray_settings_url = "/app/spray-plan-settings"
    return context
