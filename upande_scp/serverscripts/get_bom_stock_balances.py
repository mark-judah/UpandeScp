import frappe
import json

@frappe.whitelist()
def getBomStockBalances():
    try:
        data = frappe.form_dict.get("data")
        item_codes = []
        if data:
            item_codes = json.loads(data).get("item_codes", [])

        item_name_map = {}
        item_uom_map = {}
        stock_balances = {}

        if item_codes:
            items = frappe.get_list(
                "Item",
                filters={"name": ("in", item_codes)},
                fields=["name", "item_name", "stock_uom"],
                as_list=False
            )
            for item in items:
                item_name_map[item.name] = item.item_name
                item_uom_map[item.name] = item.stock_uom

            # Greenhouses are spray targets, not sources — exclude them.
            greenhouse_warehouses = set(
                frappe.get_list(
                    "Warehouse",
                    filters={"warehouse_type": "Greenhouse"},
                    pluck="name",
                )
            )

            bins = frappe.get_list(
                "Bin",
                filters={
                    "item_code": ("in", item_codes),
                    "actual_qty": (">", 0),
                },
                fields=["item_code", "warehouse", "actual_qty"],
                as_list=False,
            )
            bins = [b for b in bins if b.get("warehouse") not in greenhouse_warehouses]

            source_warehouses = sorted({b.get("warehouse") for b in bins})

            for code in item_codes:
                stock_balances[code] = {wh: 0.0 for wh in source_warehouses}

            for bin_record in bins:
                code = bin_record.get("item_code")
                wh = bin_record.get("warehouse")
                qty = bin_record.get("actual_qty")
                if code in stock_balances and wh in stock_balances[code]:
                    stock_balances[code][wh] = qty

        frappe.response["data"] = {
            "stock_balances": stock_balances,
            "item_uom_map": item_uom_map,
            "item_name_map": item_name_map,
        }

    except Exception as e:
        frappe.log_error(title="Server Script Error: get_chemical_stock_balances", message=str(e))
        frappe.throw("Error fetching stock balances: " + str(e))
