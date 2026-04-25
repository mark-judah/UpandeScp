import frappe
from frappe import _

no_cache = 1


def get_context(context):
    if frappe.session.user == "Guest":
        frappe.throw(_("Please log in to view this page."), frappe.PermissionError)

    farm = (frappe.form_dict.get("farm") or "").strip()
    search = (frappe.form_dict.get("q") or "").strip()
    active_only = frappe.form_dict.get("active") != "0"

    bom_filters = [["BOM", "custom_item_group", "=", "Chemical Mix"]]
    if active_only:
        bom_filters.append(["BOM", "is_active", "=", 1])
    if farm:
        bom_filters.append(["BOM", "custom_farm", "=", farm])
    if search:
        bom_filters.append(["BOM", "item", "like", f"%{search}%"])

    boms = frappe.get_list(
        "BOM",
        filters=bom_filters,
        fields=[
            "name",
            "item",
            "item_name",
            "custom_farm",
            "custom_business_unit",
            "custom_water_ph",
            "custom_water_hardness",
            "uom",
            "quantity",
            "is_active",
            "is_default",
            "modified",
            "modified_by",
            "owner",
        ],
        order_by="modified desc",
        limit=200,
    )

    # For each tank mix, fetch its exploded items so the chemicals appear inline
    # with quantities — that's the breakdown the user wants on this page.
    bom_names = [b.name for b in boms]
    items_by_bom = {}
    if bom_names:
        rows = frappe.get_all(
            "BOM Explosion Item",
            filters={"parent": ["in", bom_names], "parenttype": "BOM"},
            fields=[
                "parent",
                "item_code",
                "item_name",
                "stock_qty",
                "stock_uom",
                "rate",
                "amount",
                "idx",
            ],
            order_by="parent asc, idx asc",
            limit=10000,
        )
        for r in rows:
            items_by_bom.setdefault(r.parent, []).append(r)

    for b in boms:
        # Use a non-colliding key — `items` clashes with dict.items in Jinja
        # attribute lookup (`tm.items` would return the bound method).
        chemicals = items_by_bom.get(b.name, [])
        b["chemicals"] = chemicals
        b["item_count"] = len(chemicals)
        b["total_amount"] = sum((it.amount or 0) for it in chemicals)

    farms = sorted({(b.get("custom_farm") or "") for b in boms if b.get("custom_farm")})

    context.no_cache = 1
    context.title = "Tank Mixes"
    context.csrf_token = frappe.sessions.get_csrf_token()
    context.tank_mixes = boms
    context.farms = farms
    context.filters = {
        "farm": farm,
        "q": search,
        "active": "1" if active_only else "0",
    }
    return context
