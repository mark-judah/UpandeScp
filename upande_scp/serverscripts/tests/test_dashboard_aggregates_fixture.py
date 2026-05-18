"""Shared Scouting Entry fixture for dashboard aggregate integration tests.

Inserts a deterministic set of entries — 12 total — covering:
  - 3 greenhouses across 2 farms
  - 2 crops (Rose, Coffee)
  - 12 dates spanning two ISO weeks
  - mix of pests / diseases / traps / FCM-flagged moths
  - high / moderate / low severity entries

Tests call ``insert_fixture()`` in ``setUp`` and rely on Frappe's
test-DB rollback to clean up automatically.
"""

import frappe


# Use names that won't collide with production data. Created on demand if
# missing so a fresh test DB still has the master rows.
_TEST_FARM_A = "_TEST Karen Farm"
_TEST_FARM_B = "_TEST Naivasha Farm"
_TEST_GH_1 = "_TEST GH 1"
_TEST_GH_2 = "_TEST GH 2"
_TEST_GH_3 = "_TEST GH 3"
_TEST_BED = "_TEST Bed 1"
_TEST_ZONE = "_TEST Zone 1"
_TEST_PEST_THRIPS = "_TEST Thrips"
_TEST_PEST_FCM = "_TEST False Codling Moth"
_TEST_DISEASE_PM = "_TEST Powdery Mildew"
_TEST_TRAP = "_TEST Yellow Sticky"
_TEST_SCOUT = "_TEST Scout 001"


def _ensure_warehouse(name: str, is_group: int = 0, parent: str = ""):
    if not frappe.db.exists("Warehouse", name):
        doc = frappe.get_doc({
            "doctype": "Warehouse",
            "warehouse_name": name.replace("_TEST ", ""),
            "name": name,
            "is_group": is_group,
            "parent_warehouse": parent,
        })
        doc.insert(ignore_permissions=True, ignore_if_duplicate=True)


def _ensure_pest(name: str):
    if not frappe.db.exists("Pest", name):
        frappe.get_doc({"doctype": "Pest", "pest_name": name}).insert(
            ignore_permissions=True, ignore_if_duplicate=True,
        )


def _ensure_disease(name: str):
    if not frappe.db.exists("Plant Disease", name):
        frappe.get_doc({
            "doctype": "Plant Disease",
            "disease_name": name,
        }).insert(ignore_permissions=True, ignore_if_duplicate=True)


def _ensure_trap(name: str):
    if not frappe.db.exists("Trap", name):
        frappe.get_doc({"doctype": "Trap", "trap_name": name}).insert(
            ignore_permissions=True, ignore_if_duplicate=True,
        )


def _ensure_masters():
    _ensure_warehouse(_TEST_FARM_A, is_group=1)
    _ensure_warehouse(_TEST_FARM_B, is_group=1)
    _ensure_warehouse(_TEST_GH_1, parent=_TEST_FARM_A)
    _ensure_warehouse(_TEST_GH_2, parent=_TEST_FARM_A)
    _ensure_warehouse(_TEST_GH_3, parent=_TEST_FARM_B)
    _ensure_pest(_TEST_PEST_THRIPS)
    _ensure_pest(_TEST_PEST_FCM)
    _ensure_disease(_TEST_DISEASE_PM)
    _ensure_trap(_TEST_TRAP)


_FIXTURE = [
    # (date,        greenhouse,  crop,    pest_obs?,                                disease_obs?,                                trap_obs?)
    ("2026-05-04",  _TEST_GH_1,  "Rose",   [(_TEST_PEST_THRIPS, "Leaf", "Adult",  3)], [],                                          []),
    ("2026-05-05",  _TEST_GH_1,  "Rose",   [(_TEST_PEST_THRIPS, "Leaf", "Adult",  7)], [],                                          []),
    ("2026-05-06",  _TEST_GH_1,  "Rose",   [(_TEST_PEST_THRIPS, "Leaf", "Adult", 22)], [],                                          []),
    ("2026-05-07",  _TEST_GH_2,  "Rose",   [],                                          [(_TEST_DISEASE_PM, "Leaf", "Active")],      []),
    ("2026-05-08",  _TEST_GH_2,  "Rose",   [],                                          [(_TEST_DISEASE_PM, "Leaf", "Moderate")],    []),
    ("2026-05-09",  _TEST_GH_3,  "Coffee", [(_TEST_PEST_FCM,    "Fruit","Adult",  2)], [],                                          [(_TEST_TRAP, _TEST_PEST_FCM, "T1",  5)]),
    ("2026-05-10",  _TEST_GH_3,  "Coffee", [],                                          [],                                          [(_TEST_TRAP, _TEST_PEST_FCM, "T1", 12)]),
    ("2026-05-11",  _TEST_GH_1,  "Rose",   [(_TEST_PEST_THRIPS, "Stem", "Larvae", 4)], [],                                          []),
    ("2026-05-12",  _TEST_GH_2,  "Rose",   [],                                          [(_TEST_DISEASE_PM, "Leaf", "Low")],         []),
    ("2026-05-13",  _TEST_GH_3,  "Coffee", [(_TEST_PEST_FCM,    "Fruit","Adult", 18)], [],                                          [(_TEST_TRAP, _TEST_PEST_FCM, "T2", 30)]),
    ("2026-05-14",  _TEST_GH_1,  "Rose",   [(_TEST_PEST_THRIPS, "Leaf", "Adult", 11)], [(_TEST_DISEASE_PM, "Leaf", "Severe")],      []),
    ("2026-05-15",  _TEST_GH_3,  "Coffee", [],                                          [],                                          [(_TEST_TRAP, _TEST_PEST_FCM, "T1",  1)]),
]


def insert_fixture():
    _ensure_masters()
    names = []
    for i, (date_str, gh, crop, pests, diseases, traps) in enumerate(_FIXTURE):
        doc = frappe.get_doc({
            "doctype": "Scouting Entry",
            "date_of_capture": date_str,
            "time_of_capture": f"08:{i:02d}:00",
            "greenhouse": gh,
            "bed": _TEST_BED,
            "zone": _TEST_ZONE,
            "crop_scouted": crop,
            "scouts_name": _TEST_SCOUT,
            "pests_scouting_entry": [
                {"pest": p[0], "plant_section": p[1], "stage": p[2], "count": p[3]}
                for p in pests
            ],
            "diseases_scouting_entry": [
                {"disease": d[0], "plant_section": d[1], "stage": d[2]}
                for d in diseases
            ],
            "trap_scouting_entry": [
                {"trap": t[0], "pest": t[1], "location": t[2], "count": t[3]}
                for t in traps
            ],
        })
        doc.insert(ignore_permissions=True)
        names.append(doc.name)
    return names
