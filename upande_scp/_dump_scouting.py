"""Dump Scouting Entries for the target push, in bulk.

One get_doc per entry is far too slow at this scale: the parents come back in a
single query and the child rows in one query per table, grouped in memory.
"""
import json
import time

import frappe

OUT = "/tmp/claude-1001/-home-ubuntu-stive-code-frappe15-apps-upande-scp/b6c1bfb1-0cbb-4dc9-8993-2881a8b84c4a/scratchpad/"
CHILD = {
    "pests_scouting_entry": "Pests Scouting Entry",
    "diseases_scouting_entry": "Diseases Scouting Entry",
    "predators_scouting_entry": "Predators Scouting Entry",
    "weeds_scouting_entry": "Weeds Scouting Entry",
    "incidents_scouting_entry": "Incidents Scouting Entry",
    "physiological_disorders_entry": "Physiological Disorders Entry",
    "trap_scouting_entry": "Trap Scouting Entry",
    "crop_modelling_entry": "Crop Modelling Entry",
}
DROP = {"name", "owner", "creation", "modified", "modified_by", "docstatus",
        "parent", "parenttype", "parentfield", "idx", "doctype", "_user_tags",
        "_comments", "_assign", "_liked_by"}


def run(crop="Rose", limit=10000, out="rose_entries.json", offset=0):
    t0 = time.time()
    meta = frappe.get_meta("Scouting Entry")
    parent_fields = [f.fieldname for f in meta.fields
                     if f.fieldtype not in ("Section Break", "Column Break", "Tab Break",
                                            "HTML", "Button", "Table")]
    parents = frappe.get_all(
        "Scouting Entry", filters={"crop_scouted": crop},
        fields=["name"] + parent_fields, order_by="creation asc",
        limit_page_length=limit, limit_start=offset,
    )
    print("parents: {} (offset {}) in {:.1f}s".format(len(parents), offset, time.time() - t0))
    names = [p["name"] for p in parents]
    by_name = {p["name"]: p for p in parents}
    for p in parents:
        p["doctype"] = "Scouting Entry"

    total_child = 0
    for field, dt in CHILD.items():
        cmeta = frappe.get_meta(dt)
        cfields = [f.fieldname for f in cmeta.fields
                   if f.fieldtype not in ("Section Break", "Column Break", "Tab Break", "HTML", "Button")]
        rows = frappe.get_all(dt, filters={"parent": ["in", names]},
                              fields=["parent", "idx"] + cfields, limit_page_length=0)
        if not rows:
            continue
        total_child += len(rows)
        grouped = {}
        for r in sorted(rows, key=lambda x: (x["parent"], x["idx"])):
            grouped.setdefault(r["parent"], []).append(
                {k: v for k, v in r.items() if k not in DROP and k != "parent" and v not in (None, "")}
            )
        for parent, kids in grouped.items():
            by_name[parent][field] = kids
        print("  {:<32} {:>7} rows".format(dt, len(rows)))

    docs = [{k: v for k, v in p.items() if v not in (None, "")} for p in parents]
    json.dump(docs, open(OUT + out, "w"), default=str)
    size = len(open(OUT + out).read())
    print("\ndumped {} parents, {} child rows, {:.1f} MB in {:.1f}s".format(
        len(docs), total_child, size / 1e6, time.time() - t0))
