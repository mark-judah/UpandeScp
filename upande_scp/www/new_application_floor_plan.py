import frappe

def get_context(context):
    context.no_cache = 1
    csrf_token = frappe.sessions.get_csrf_token()
    context.csrf_token = csrf_token
    warehouses = frappe.db.get_list(
        "Warehouse",
        filters={
            "warehouse_type": "Greenhouse"
        },
        fields=["name"]
    )

    context.warehouses_list = warehouses
    return context

@frappe.whitelist()
def get_scouted_greenhouses_by_date(date):
    if not date:
        warehouses = frappe.db.get_list(
            "Warehouse",
            filters={"warehouse_type": "Greenhouse"},
            fields=["name"],
            order_by="name asc"
        )
        return {"greenhouses": warehouses}

    scouting_rows = frappe.get_all(
        "Scouting Entry",
        filters={"date_of_capture": date},
        fields=["greenhouse"],
        group_by="greenhouse"
    )
    scouted_names = [row.greenhouse for row in scouting_rows if row.greenhouse]

    if not scouted_names:
        return {"greenhouses": []}

    warehouses = frappe.db.get_list(
        "Warehouse",
        filters={
            "warehouse_type": "Greenhouse",
            "name": ["in", scouted_names]
        },
        fields=["name"],
        order_by="name asc"
    )
    return {"greenhouses": warehouses}
