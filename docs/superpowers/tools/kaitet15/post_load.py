"""Repairs that a partial production restore always needs on a fresh site.

Run inside an initialised frappe context:
    env/bin/python -c "import frappe;frappe.init(site='kaitet15.local');frappe.connect();\
        exec(open('post_load.py').read())"

Every item here is a failure that actually happened during the v16 restore in
July; they are not speculative.
"""
import json

import frappe

print("\n== 1. installed_apps global ==")
# The dump carries production's 28-app list. Frappe's website renderer loops
# get_installed_apps() UNFILTERED and imports each one, so a phantom app 500s
# every web page. tabInstalled Application and apps.txt stay correct; only this
# DB global diverges.
apps = ["frappe", "erpnext", "upande_kaitet", "upande_scp", "upande_livestock"]
# Delete first: set_global updates one row, so production's row would otherwise
# survive next to ours and get_global() would return a list of two values.
frappe.db.sql("DELETE FROM `tabDefaultValue` WHERE parent='__global' AND defkey='installed_apps'")
frappe.db.set_global("installed_apps", json.dumps(apps))
print("   set to", apps)

print("\n== 2. tabDefaultValue duplicates ==")
# Production rows land on top of the fresh site's, so every global default has
# two rows and frappe.defaults.get_defaults() returns a LIST per key -> desk
# boot dies with SessionBootFailed. Scoped to __default/Administrator only:
# a real user may legitimately hold several rows for the same key.
# __global matters as much as __default: it holds installed_apps, and a
# duplicate there makes get_global() return production's 28-app list, which
# makes `bench migrate` try to import apps this bench does not have.
dupes = frappe.db.sql("""
    SELECT parent, defkey, COUNT(*) n FROM `tabDefaultValue`
    WHERE parent IN ('__default','__global','Administrator')
    GROUP BY parent, defkey HAVING n > 1""", as_dict=True)
for d in dupes:
    rows = frappe.db.sql("""
        SELECT name, defvalue FROM `tabDefaultValue`
        WHERE parent=%s AND defkey=%s ORDER BY (defvalue IS NULL OR defvalue=''), name
    """, (d.parent, d.defkey), as_dict=True)
    for r in rows[1:]:
        frappe.db.sql("DELETE FROM `tabDefaultValue` WHERE name=%s", r.name)
print(f"   deduped {len(dupes)} key(s)")

print("\n== 3. Notification Settings backfill ==")
# SQL-inserted users skip the auto-create hook; a missing doc makes get_bootinfo
# raise DoesNotExistError -> HTTP 500 on /app for that user.
from frappe.desk.doctype.notification_settings.notification_settings import (
    create_notification_settings,
)

missing = frappe.db.sql("""
    SELECT u.name FROM `tabUser` u
    LEFT JOIN `tabNotification Settings` n ON n.name = u.name
    WHERE n.name IS NULL AND u.name NOT IN ('Guest')""", pluck=True)
for u in missing:
    try:
        create_notification_settings(u)
    except Exception as e:
        print("   skip", u, e)
print(f"   created {len(missing)}")

print("\n== 4. setup wizard + global defaults ==")
# On v15 frappe.is_setup_complete() reads tabInstalled Application.is_setup_complete
# for frappe+erpnext — NOT System Settings (that is the v16 shape). Set both.
frappe.db.sql("""UPDATE `tabInstalled Application` SET is_setup_complete = 1
                 WHERE app_name IN ('frappe','erpnext')""")
# A fresh site records desktop:home_page = 'setup-wizard'; it survives the restore
# and keeps sending the desk to the wizard even once setup IS complete.
frappe.db.sql("DELETE FROM `tabDefaultValue` WHERE defkey='desktop:home_page'")
frappe.db.set_single_value("System Settings", "setup_complete", 1)
frappe.db.set_single_value("System Settings", "enable_onboarding", 0)
frappe.db.set_single_value("System Settings", "time_zone", "Africa/Nairobi")
company = frappe.db.get_value("Company", {"name": "Karen Roses"}, "name") or frappe.db.get_value(
    "Company", {}, "name")
if company:
    frappe.db.set_single_value("Global Defaults", "default_company", company)
frappe.db.set_single_value("Global Defaults", "default_currency", "KES")
frappe.db.set_single_value("Global Defaults", "country", "Kenya")
print("   company:", company, "| currency KES | country Kenya")

frappe.db.commit()

print("\n== 5. sanity counts ==")
for dt in ("Scouting Entry", "Farm", "Item", "Warehouse", "BOM", "Work Order", "Bin",
           "Employee", "User", "Zone", "Bed", "Stock Entry"):
    try:
        print(f"   {dt:16} {frappe.db.count(dt):>8}")
    except Exception as e:
        print(f"   {dt:16} ERROR {e}")
