"""Seed opening stock for the livestock feed flow.

The flow (upande_livestock/api/feeding.py) manufactures a herd's TMR from the
BOM linked on the Herd: raw materials are consumed from **each item's own
default warehouse**, and the output lands in the feed WIP store. So the seed
target is exactly the herd BOMs' raw materials in the warehouses those items
default to — 13 items across 5 stores here, not the whole DAIRY group.

Run like seed_stock.py, inside an initialised frappe context.
"""
import frappe

QTY = 1000            # feed moves in bulk; 100 kg would not cover one manufacture
FALLBACK_RATE = 50

boms = frappe.db.sql("SELECT DISTINCT bom FROM `tabHerds` WHERE IFNULL(bom,'') <> ''", pluck=True)
if not boms:
    print("no herd BOMs — nothing to seed")
else:
    items = frappe.db.sql("""
        SELECT DISTINCT bi.item_code AS name, i.stock_uom, IFNULL(i.valuation_rate,0) AS rate
        FROM `tabBOM Item` bi JOIN `tabItem` i ON i.name = bi.item_code
        WHERE bi.parent IN %s AND i.is_stock_item = 1
          AND IFNULL(i.has_batch_no,0) = 0 AND IFNULL(i.has_serial_no,0) = 0""",
        (tuple(boms),), as_dict=True)

    whs = frappe.db.sql("""
        SELECT DISTINCT w.name, w.company FROM `tabItem Default` id
        JOIN `tabWarehouse` w ON w.name = id.default_warehouse
        WHERE id.parent IN (SELECT DISTINCT bi.item_code FROM `tabBOM Item` bi WHERE bi.parent IN %s)
          AND IFNULL(id.default_warehouse,'') <> '' AND w.is_group = 0""",
        (tuple(boms),), as_dict=True)

    print(f"feed items: {len(items)} | warehouses: {len(whs)} | "
          f"combinations: {len(items) * len(whs)}")

    made, failed = [], []
    for w in whs:
        se = frappe.new_doc("Stock Entry")
        se.stock_entry_type = "Material Receipt"
        se.purpose = "Material Receipt"
        se.company = w.company
        se.set_posting_time = 1
        se.posting_date = frappe.utils.nowdate()
        se.posting_time = "00:00:00"
        se.remarks = "kaitet15 opening stock seed (livestock feed)"
        for it in items:
            se.append("items", {
                "item_code": it.name,
                "qty": QTY,
                "uom": it.stock_uom,
                "stock_uom": it.stock_uom,
                "conversion_factor": 1,
                "t_warehouse": w.name,
                "basic_rate": it.rate or FALLBACK_RATE,
            })
        try:
            se.insert(ignore_permissions=True)
            se.submit()
            made.append(se.name)
            frappe.db.commit()
            print(f"  {w.name}: {se.name}")
        except Exception as e:
            failed.append((w.name, str(e)[:160]))
            frappe.db.rollback()

    print(f"\nsubmitted {len(made)} | failures: {len(failed)}")
    for f in failed:
        print("  FAIL", f)
