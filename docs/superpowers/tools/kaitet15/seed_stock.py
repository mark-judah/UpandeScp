"""Seed opening stock so the SCP flows have something to move.

Material Receipt Stock Entries putting QTY of every chemical/fertilizer item into
every warehouse the flows actually use: the stores mapped on Farm
(custom_chemical_store / custom_fertilizer_store) and the CSUs.

Real Stock Entries, not hand-written Bin rows — that is the only way to get
consistent SLE + Bin + GL, which is what the transfer/mix/manufacture path
validates against.

Run inside an initialised frappe context (from the bench's sites/ dir):
    ../env/bin/python -c "import frappe;frappe.init(site='X');frappe.connect();\
        exec(open('seed_stock.py').read())"
"""
import frappe

QTY = 100
BATCH = 150          # items per Stock Entry; keeps each document submittable
FALLBACK_RATE = 100  # 677 of 678 items carry no valuation rate

frappe.flags.in_import = True


def target_items():
    return frappe.db.sql("""
        SELECT name, stock_uom, IFNULL(valuation_rate, 0) AS rate, item_name
        FROM `tabItem`
        WHERE item_group IN ('CHEMICALS', 'Fertilizer')
          AND disabled = 0 AND is_stock_item = 1
          AND IFNULL(has_batch_no, 0) = 0 AND IFNULL(has_serial_no, 0) = 0
        ORDER BY name""", as_dict=True)


def target_warehouses():
    """Stores mapped on Farm, plus the CSUs — grouped by company, since a
    Stock Entry cannot span companies."""
    rows = frappe.db.sql("""
        SELECT DISTINCT w.name, w.company
        FROM `tabWarehouse` w
        WHERE w.is_group = 0 AND (
              w.name IN (SELECT custom_chemical_store FROM `tabFarm`
                         WHERE IFNULL(custom_chemical_store, '') <> '')
           OR w.name IN (SELECT custom_fertilizer_store FROM `tabFarm`
                         WHERE IFNULL(custom_fertilizer_store, '') <> '')
           OR w.name LIKE '%%CSU%%')
        ORDER BY w.company, w.name""", as_dict=True)
    return rows


def seed():
    items = target_items()
    whs = target_warehouses()
    print(f"items: {len(items)} | warehouses: {len(whs)} | "
          f"combinations: {len(items) * len(whs):,}")

    made, failed, skipped = [], [], 0
    for w in whs:
        existing = frappe.db.sql("""SELECT COUNT(*) FROM `tabBin`
                                    WHERE warehouse=%s AND actual_qty > 0""", w.name)[0][0]
        if existing >= len(items):
            skipped += 1
            print(f"  {w.name}: already stocked ({existing} bins), skipped")
            continue

        for start in range(0, len(items), BATCH):
            chunk = items[start:start + BATCH]
            se = frappe.new_doc("Stock Entry")
            se.stock_entry_type = "Material Receipt"
            se.purpose = "Material Receipt"
            se.company = w.company
            se.set_posting_time = 1
            se.posting_date = frappe.utils.nowdate()
            se.posting_time = "00:00:00"
            se.remarks = "kaitet15 opening stock seed"
            for it in chunk:
                se.append("items", {
                    "item_code": it.name,
                    "qty": QTY,
                    "uom": it.stock_uom,
                    "stock_uom": it.stock_uom,
                    "conversion_factor": 1,
                    "t_warehouse": w.name,
                    "basic_rate": it.rate or FALLBACK_RATE,
                    "allow_zero_valuation_rate": 0,
                })
            try:
                se.insert(ignore_permissions=True)
                se.submit()
                made.append(se.name)
            except Exception as e:
                failed.append((w.name, start, str(e)[:160]))
                frappe.db.rollback()
        frappe.db.commit()
        print(f"  {w.name}: done ({len(made)} entries so far)")

    print(f"\nsubmitted {len(made)} Stock Entries | warehouses skipped: {skipped} | failures: {len(failed)}")
    for f in failed[:10]:
        print("  FAIL", f)
    print("bins with stock now:", frappe.db.sql(
        "SELECT COUNT(*) FROM `tabBin` WHERE actual_qty > 0")[0][0])


seed()
