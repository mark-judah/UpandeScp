import frappe
import json

from upande_scp.serverscripts.spray_plan_creator.settings import _kind_of
from upande_scp.upande_scp.doctype.spray_plan_settings.spray_plan_settings import (
    get_allowed_chemical_store_warehouses,
    get_allowed_fertilizer_unit_warehouses,
)


# Kept for backward-compatible imports; classification now goes through
# ``_kind_of`` so the plural/case group-name variants ("Fertilizers") all match.
_FERTILIZER_GROUP = "Fertilizer"


def _zero_balances(codes, warehouses):
    return {code: {wh: 0.0 for wh in warehouses} for code in codes}


def _fill_balances(codes, warehouses):
    balances = _zero_balances(codes, warehouses)
    if not codes or not warehouses:
        return balances
    bins = frappe.get_list(
        "Bin",
        filters={
            "item_code": ("in", codes),
            "warehouse": ("in", warehouses),
        },
        fields=["item_code", "warehouse", "actual_qty"],
    )
    for bin_record in bins:
        code = bin_record.get("item_code")
        wh = bin_record.get("warehouse")
        if code in balances and wh in balances[code]:
            balances[code][wh] = bin_record.get("actual_qty") or 0.0
    return balances


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
        code_group_map = {}

        if item_names:
            items = frappe.get_list(
                "Item",
                filters={"item_name": ("in", item_names)},
                fields=["item_name", "name", "stock_uom", "item_group"],
            )
            for item in items:
                name = item.get("item_name")
                code = item.get("name")
                item_code_map[name] = code
                code_item_map[code] = name
                item_uom_map[name] = item.get("stock_uom")
                code_group_map[code] = item.get("item_group") or ""

        fertilizer_codes = [c for c, g in code_group_map.items() if _kind_of(g) == "fertilizer"]
        chemical_codes = [c for c, g in code_group_map.items() if _kind_of(g) != "fertilizer"]

        chemical_warehouses = get_allowed_chemical_store_warehouses()
        fertilizer_warehouses = get_allowed_fertilizer_unit_warehouses()

        chem_balances_by_code = _fill_balances(chemical_codes, chemical_warehouses)
        fert_balances_by_code = _fill_balances(fertilizer_codes, fertilizer_warehouses)

        def by_item_name(balances_by_code):
            return {
                code_item_map[code]: balances
                for code, balances in balances_by_code.items()
                if code_item_map.get(code)
            }

        chemical_balances = by_item_name(chem_balances_by_code)
        fertilizer_balances = by_item_name(fert_balances_by_code)

        # Legacy combined map — each item maps only to the warehouses
        # relevant to its type. Older callers that read this directly will
        # still work; new callers should prefer the split keys below.
        combined_balances = {**chemical_balances, **fertilizer_balances}

        frappe.response["data"] = {
            "stock_balances": combined_balances,
            "item_uom_map": item_uom_map,
            "chemical_balances": chemical_balances,
            "chemical_warehouses": chemical_warehouses,
            "fertilizer_balances": fertilizer_balances,
            "fertilizer_warehouses": fertilizer_warehouses,
        }

    except Exception as e:
        frappe.log_error(title="Server Script Error: get_chemical_stock_balances", message=str(e))
        frappe.throw("Error fetching stock balances: " + str(e))
