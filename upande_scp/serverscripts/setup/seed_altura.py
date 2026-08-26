"""Minimal structure for altura.local, plus a synthetic bed in open ocean.

The bed sits at roughly 5S 150W — a thousand miles from any land — so it can
never be confused with, or overlap, a real farm's geometry. It exists so the
spray and scouting flows have something to resolve against before Altura's own
survey data arrives.
"""
import frappe
import json


def execute():
    """Run with: bench --site altura.local execute
    upande_scp.serverscripts.setup.seed_altura.execute
    """
    frappe.set_user("Administrator")
    out = {}

    COMPANY, ABBR = "Altura Farms", "ALT"
    FARM, GREENHOUSE = "Altura Main", "Altura GH 01"
    LAT, LON = -5.0, -150.0          # mid South Pacific
    ZONES = 10

    # --- warehouse types ------------------------------------------------------
    # A site created without the ERPNext setup wizard has none, and creating a
    # Company trips over the missing "Transit" while building its default
    # warehouses. mona carries exactly these three.
    for wt in ("Transit", "Greenhouse", "Stores"):
        if not frappe.db.exists("Warehouse Type", wt):
            frappe.get_doc({"doctype": "Warehouse Type", "name": wt}).insert(ignore_permissions=True)
    frappe.db.commit()
    out["warehouse_types"] = frappe.get_all("Warehouse Type", pluck="name")

    # --- system settings the setup wizard would have filled -------------------
    # language and country are NULL on a wizard-less site, and Frappe's
    # get_locale_value raises UnboundLocalError rather than falling back when
    # language is unset — so any code path that formats a date blows up.
    _ss = frappe.get_single("System Settings")
    for field, value in (("language", "en"), ("country", "Kenya"),
                         ("currency", "KES"), ("time_zone", "Africa/Nairobi"),
                         ("date_format", "dd-mm-yyyy"), ("time_format", "HH:mm:ss")):
        if _ss.meta.get_field(field) and not _ss.get(field):
            _ss.set(field, value)
    _ss.flags.ignore_mandatory = True
    _ss.save(ignore_permissions=True)
    frappe.db.commit()
    frappe.clear_cache()
    out["system_settings"] = {f: frappe.db.get_single_value("System Settings", f)
                              for f in ("language", "country", "time_zone")}

    # --- other records the setup wizard would have made -----------------------
    # Gender is required on Employee, and Employee is required before anyone can
    # file a scouting entry.
    for g in ("Male", "Female", "Other"):
        if not frappe.db.exists("Gender", g):
            frappe.get_doc({"doctype": "Gender", "gender": g}).insert(ignore_permissions=True)
    frappe.db.commit()
    out["genders"] = frappe.db.count("Gender")

    # --- company -------------------------------------------------------------
    if not frappe.db.exists("Company", COMPANY):
        frappe.get_doc({"doctype": "Company", "company_name": COMPANY,
                        "abbr": ABBR, "default_currency": "KES",
                        "country": "Kenya"}).insert(ignore_permissions=True)
    out["company"] = COMPANY

    # --- farm (upande_harvest owns this; Warehouse.custom_farm points at it) ---
    if frappe.db.exists("DocType", "Farm") and not frappe.db.exists("Farm", FARM):
        f = frappe.new_doc("Farm")
        for field, value in (("farm_name", FARM), ("name1", FARM), ("farm", FARM)):
            if f.meta.get_field(field):
                f.set(field, value)
        f.insert(ignore_permissions=True)
    out["farm"] = FARM if frappe.db.exists("Farm", FARM) else "(not created)"

    # --- greenhouse warehouse -------------------------------------------------
    wh_name = f"{GREENHOUSE} - {ABBR}"
    if not frappe.db.exists("Warehouse", wh_name):
        w = frappe.new_doc("Warehouse")
        w.warehouse_name = GREENHOUSE
        w.company = COMPANY
        if w.meta.get_field("warehouse_type"):
            w.warehouse_type = "Greenhouse"
        if w.meta.get_field("custom_farm") and frappe.db.exists("Farm", FARM):
            w.custom_farm = FARM
        w.insert(ignore_permissions=True)
    out["greenhouse"] = wh_name

    # --- the bed --------------------------------------------------------------
    bed_doc = frappe.new_doc("Bed")
    bed_doc.greenhouse = wh_name
    if bed_doc.meta.get_field("unit_type"):
        bed_doc.unit_type = "Bed"
    if bed_doc.meta.get_field("bed"):
        bed_doc.bed = "1"
    bed_name = f"{wh_name} - Bed 1"
    if not frappe.db.exists("Bed", bed_name):
        bed_doc.insert(ignore_permissions=True)
        bed_name = bed_doc.name
    out["bed"] = bed_name

    # --- zones, as parallel line segments across the bed ----------------------
    made = []
    for i in range(1, ZONES + 1):
        zname = f"{bed_name} - Zone {i}"
        if frappe.db.exists("Zone", zname):
            made.append(zname + " (existed)")
            continue
        # ~10m of longitude per column, each a 20m north-south line.
        lon_i = LON + (i - 1) * 0.0001
        line = {"type": "FeatureCollection", "features": [{
            "type": "Feature", "properties": {},
            "geometry": {"type": "LineString",
                         "coordinates": [[lon_i, LAT - 0.0001], [lon_i, LAT + 0.0001]]}}]}
        z = frappe.new_doc("Zone")
        z.bed = bed_name
        z.greenhouse = wh_name
        if z.meta.get_field("zone"):
            z.zone = str(i)
        z.raw_geojson = json.dumps(line)
        z.insert(ignore_permissions=True)
        made.append(z.name)
    frappe.db.commit()
    out["zones"] = len(made)
    out["zone_sample"] = made[:2]
    print("SEED " + json.dumps(out, indent=1, default=str))
    return out
