"""Finish the livestock seeding: the stock the non-feed flows consume.

Beyond feeding, livestock touches stock in three places:
  Animal Drug Issue      -> item_code + source_warehouse
  Animal Health Treatment-> drug_item
  Calf Rearing           -> milk_replacer_item

So: the DRUGS group into the stores those items default to plus the clinic
stores they are issued from, and the milk replacers into the feed and clinic
stores. Milk itself needs no seed — Milk Recording produces it.
"""
import frappe

BATCH = 150

DRUG_WHS = ["Stores - KR", "General Store Karen - KR",
            "Clinic Store - KR", "Clinic Store Kapkolia - KR", "Clinic Store Karen - KR"]
REPLACER_WHS = ["Feed Store - Raw materials - KR", "Feed Store - Concentrate store - KR",
                "Clinic Store - KR", "Clinic Store Karen - KR"]


def receipt(items, warehouse, qty, rate_fallback):
    company = frappe.db.get_value("Warehouse", warehouse, "company")
    made = []
    for start in range(0, len(items), BATCH):
        chunk = items[start:start + BATCH]
        se = frappe.new_doc("Stock Entry")
        se.stock_entry_type = "Material Receipt"
        se.purpose = "Material Receipt"
        se.company = company
        se.set_posting_time = 1
        se.posting_date = frappe.utils.nowdate()
        se.posting_time = "00:00:00"
        se.remarks = "kaitet15 opening stock seed (livestock non-feed)"
        for it in chunk:
            se.append("items", {
                "item_code": it.name, "qty": qty, "uom": it.stock_uom,
                "stock_uom": it.stock_uom, "conversion_factor": 1,
                "t_warehouse": warehouse,
                "basic_rate": it.rate or rate_fallback,
            })
        try:
            se.insert(ignore_permissions=True)
            se.submit()
            made.append(se.name)
            frappe.db.commit()
        except Exception as e:
            print(f"    FAIL {warehouse} [{start}]: {str(e)[:140]}")
            frappe.db.rollback()
    return made


drugs = frappe.db.sql("""
    SELECT name, stock_uom, IFNULL(valuation_rate,0) rate FROM `tabItem`
    WHERE item_group='DRUGS' AND disabled=0 AND is_stock_item=1
      AND IFNULL(has_batch_no,0)=0 AND IFNULL(has_serial_no,0)=0 ORDER BY name""", as_dict=True)
replacers = frappe.db.sql("""
    SELECT name, stock_uom, IFNULL(valuation_rate,0) rate FROM `tabItem`
    WHERE is_stock_item=1 AND disabled=0 AND LOWER(item_name) LIKE '%milk replacer%'
      AND IFNULL(has_batch_no,0)=0 AND IFNULL(has_serial_no,0)=0""", as_dict=True)

print(f"drugs: {len(drugs)} x {len(DRUG_WHS)} whs = {len(drugs)*len(DRUG_WHS):,} | "
      f"replacers: {len(replacers)} x {len(REPLACER_WHS)} = {len(replacers)*len(REPLACER_WHS)}")

total = []
for w in DRUG_WHS:
    if not frappe.db.exists("Warehouse", w):
        print(f"  skip missing warehouse {w}")
        continue
    n = receipt(drugs, w, 100, 100)
    total += n
    print(f"  {w}: {len(n)} entries")
for w in REPLACER_WHS:
    if not frappe.db.exists("Warehouse", w):
        continue
    n = receipt(replacers, w, 500, 200)
    total += n
    print(f"  {w} (replacers): {len(n)} entries")

print(f"\nsubmitted {len(total)} Stock Entries")
print("bins with stock now:", frappe.db.sql("SELECT COUNT(*) FROM `tabBin` WHERE actual_qty>0")[0][0])
