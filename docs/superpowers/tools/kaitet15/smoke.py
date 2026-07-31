"""Drive the load-bearing SCP endpoints on kaitet15.local.

Paths are the kaitet15-branch ones: the serverscripts/ functional regrouping
landed 2026-07-21, after this branch's cut, so everything is still flat under
serverscripts/ (not serverscripts/store/, /geo/, /scouting/ ...).
"""
import traceback

import frappe

CALLS = [
    ("getFarmsAndGreenhouses", "upande_scp.serverscripts.get_heatmap_data.getFarmsAndGreenhouses", {}),
    ("getCropsScouted", "upande_scp.serverscripts.mobile.get_crops_scouted.getCropsScouted", {}),
    ("fetch_creator_bootstrap", "upande_scp.serverscripts.spray_plan_creator.bootstrap.fetch_creator_bootstrap", {}),
    ("creator_stock_overview", "upande_scp.serverscripts.spray_plan_creator.stock.creator_stock_overview", {}),
    ("chemical_stock_overview", "upande_scp.serverscripts.store_keeper_api.chemical_stock_overview", {}),
    ("getAllChemicals", "upande_scp.serverscripts.create_bom.getAllChemicals", {}),
]


def shape(v):
    if isinstance(v, dict):
        return "{" + ", ".join(f"{k}: {shape(x)}" for k, x in list(v.items())[:4]) + "}"
    if isinstance(v, (list, tuple)):
        return f"[{len(v)} items]"
    s = str(v)
    return s[:40]


ok = fail = 0
for label, path, kwargs in CALLS:
    try:
        out = frappe.call(path, **kwargs)
        ok += 1
        print(f"  PASS  {label:26} -> {shape(out)}")
    except Exception as e:
        fail += 1
        print(f"  FAIL  {label:26} -> {type(e).__name__}: {str(e)[:120]}")
        traceback.print_exc(limit=2)

print(f"\n{ok} passed, {fail} failed")
