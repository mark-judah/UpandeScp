"""Seed Spray Plan Settings with the farms and exclude keywords that the
www/new_application_floor_plan dropdown previously hardcoded.

Idempotent: only adds farms / keywords that are missing. Skips farms whose
Farm record does not exist in the target site.
"""

import frappe


SEED_FARMS = ("Chepsito", "Kaptumbo", "Kapkolia", "Torongo", "Simotwo", "Karen")
SEED_KEYWORDS = ("phase", "tunnel", "ipm", "wetland")


def execute():
    if not frappe.db.table_exists("Spray Plan Settings"):
        return

    settings = frappe.get_single("Spray Plan Settings")

    existing_farms = {row.farm for row in (settings.allowed_farms or [])}
    for farm_name in SEED_FARMS:
        if farm_name in existing_farms:
            continue
        if not frappe.db.exists("Farm", farm_name):
            continue
        settings.append("allowed_farms", {"farm": farm_name})

    existing_keywords = {(row.keyword or "").lower() for row in (settings.exclude_keywords or [])}
    for keyword in SEED_KEYWORDS:
        if keyword.lower() in existing_keywords:
            continue
        settings.append("exclude_keywords", {"keyword": keyword})

    settings.save(ignore_permissions=True)
    frappe.db.commit()
