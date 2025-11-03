import frappe
import json

@frappe.whitelist()
def getBomStockBalances():
    try:
        data = frappe.form_dict.get("data")
        item_names = []
        if data:
            item_names = json.loads(data).get("chemicals", [])

        item_code_map = {}
        code_item_map = {}
        item_uom_map = {}

        if item_names:
            items = frappe.get_list(
                "Item",
                filters={"item_name": ("in", item_names)},
                fields=["item_name", "item_code", "stock_uom"],
                as_list=False
            )
            for item in items:
                name = item.get("item_name")
                code = item.get("item_code")
                stock_uom = item.get("stock_uom")
                item_code_map[name] = code
                code_item_map[code] = name
                item_uom_map[name] = stock_uom

        chemicals = list(item_code_map.values())

        source_warehouses = [
            'Chemical Store Chepsito - KR',
            'Chemical Store Kapkolia - KR',
            'Chemical Store Kaptumbo - KR',
            'Chemical Store Simotwo - KR',
            'Chemical Store Torongo - KR'
        ]

        code_stock_balances = {}
        if chemicals:
            bins = frappe.get_list(
                "Bin",
                filters={
                    "item_code": ("in", chemicals),
                    "warehouse": ("in", source_warehouses)
                },
                fields=["item_code", "warehouse", "actual_qty"],
                as_list=False
            )

            for chemical_code in chemicals:
                code_stock_balances[chemical_code] = {}
                for warehouse in source_warehouses:
                    code_stock_balances[chemical_code][warehouse] = 0.0

            for bin_record in bins:
                item_code = bin_record.get('item_code')
                wh = bin_record.get('warehouse')
                qty = bin_record.get('actual_qty')
                if item_code in code_stock_balances and wh in code_stock_balances[item_code]:
                    code_stock_balances[item_code][wh] = qty

        final_stock_balances = {}
        for code, balances in code_stock_balances.items():
            item_name = code_item_map.get(code)
            if item_name:
                final_stock_balances[item_name] = balances

        frappe.response["data"] = {
            "stock_balances": final_stock_balances,
            "item_uom_map": item_uom_map
        }

    except Exception as e:
        frappe.log_error(title="Server Script Error: get_chemical_stock_balances", message=str(e))
        frappe.throw("Error fetching stock balances: " + str(e))