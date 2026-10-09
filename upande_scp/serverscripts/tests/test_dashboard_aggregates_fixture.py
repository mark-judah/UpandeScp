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


def _ensure_warehouse_type(name: str):
    if not frappe.db.exists("Warehouse Type", name):
        frappe.get_doc({"doctype": "Warehouse Type", "name": name}).insert(
            ignore_permissions=True, ignore_if_duplicate=True,
        )


def _ensure_farm(name: str):
    """Warehouse.custom_farm is mandatory, so every test warehouse needs a Farm.
    Farm also wants a company, abbreviation and farm types the fixture does not
    care about, hence ignore_mandatory (as test_field_unit_automation does)."""
    if not frappe.db.exists("Farm", name):
        doc = frappe.get_doc({"doctype": "Farm", "farm_name": name})
        doc.flags.ignore_mandatory = True
        doc.insert(ignore_permissions=True, ignore_if_duplicate=True)


def _ensure_warehouse(name: str, is_group: int = 0, parent: str = "",
                      warehouse_type: str = "", farm: str = ""):
    if not frappe.db.exists("Warehouse", name):
        if warehouse_type:
            _ensure_warehouse_type(warehouse_type)
        _ensure_farm(farm)
        doc = frappe.get_doc({
            "doctype": "Warehouse",
            "warehouse_name": name.replace("_TEST ", ""),
            "is_group": is_group,
            "parent_warehouse": parent,
            "warehouse_type": warehouse_type or None,
            "custom_farm": farm,
        })
        # Warehouse autonames "<warehouse_name> - <company abbr>"; the fixture
        # and its tests refer to the warehouses by these exact names.
        doc.insert(ignore_permissions=True, ignore_if_duplicate=True, set_name=name)


def _ensure_pest(name: str):
    if not frappe.db.exists("Pest", name):
        # Pest is named by its common name.
        frappe.get_doc({"doctype": "Pest", "pest_name": name, "common_name": name}).insert(
            ignore_permissions=True, ignore_if_duplicate=True,
        )


def _ensure_disease(name: str):
    if not frappe.db.exists("Plant Disease", name):
        frappe.get_doc({
            "doctype": "Plant Disease",
            "disease_name": name,
            "common_name": name,  # Plant Disease is named by its common name.
        }).insert(ignore_permissions=True, ignore_if_duplicate=True)


def _ensure_trap(name: str):
    if not frappe.db.exists("Trap", name):
        # Trap autonames "{farm} - {trap_number}"; keep the fixture's name.
        _ensure_farm(_TEST_FARM_B)
        frappe.get_doc({"doctype": "Trap", "farm": _TEST_FARM_B, "trap_number": "1"}).insert(
            ignore_permissions=True, ignore_if_duplicate=True, set_name=name,
        )


def _ensure_masters():
    _ensure_warehouse(_TEST_FARM_A, is_group=1, farm=_TEST_FARM_A)
    _ensure_warehouse(_TEST_FARM_B, is_group=1, farm=_TEST_FARM_B)
    _ensure_warehouse(_TEST_GH_1, parent=_TEST_FARM_A, warehouse_type="Greenhouse", farm=_TEST_FARM_A)
    _ensure_warehouse(_TEST_GH_2, parent=_TEST_FARM_A, warehouse_type="Greenhouse", farm=_TEST_FARM_A)
    _ensure_warehouse(_TEST_GH_3, parent=_TEST_FARM_B, warehouse_type="Greenhouse", farm=_TEST_FARM_B)
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
    ("2026-05-09",  _TEST_GH_3,  "Coffee", [(_TEST_PEST_FCM,    "Fruit","Adult",  2)], [],                                          [(_TEST_TRAP, _TEST_PEST_FCM, "Indoor",  5)]),
    ("2026-05-10",  _TEST_GH_3,  "Coffee", [],                                          [],                                          [(_TEST_TRAP, _TEST_PEST_FCM, "Indoor", 12)]),
    ("2026-05-11",  _TEST_GH_1,  "Rose",   [(_TEST_PEST_THRIPS, "Stem", "Larvae", 4)], [],                                          []),
    ("2026-05-12",  _TEST_GH_2,  "Rose",   [],                                          [(_TEST_DISEASE_PM, "Leaf", "Low")],         []),
    ("2026-05-13",  _TEST_GH_3,  "Coffee", [(_TEST_PEST_FCM,    "Fruit","Adult", 18)], [],                                          [(_TEST_TRAP, _TEST_PEST_FCM, "Outdoor", 30)]),
    ("2026-05-14",  _TEST_GH_1,  "Rose",   [(_TEST_PEST_THRIPS, "Leaf", "Adult", 11)], [(_TEST_DISEASE_PM, "Leaf", "Severe")],      []),
    ("2026-05-15",  _TEST_GH_3,  "Coffee", [],                                          [],                                          [(_TEST_TRAP, _TEST_PEST_FCM, "Indoor",  1)]),
]


def _clear_fixture_entries():
    """FrappeTestCase rolls back per class, not per test, so a setUp that
    inserts the fixture would stack a second copy on the first. Start clean."""
    old = frappe.get_all("Scouting Entry", filters={"greenhouse": ["in", [_TEST_GH_1, _TEST_GH_2, _TEST_GH_3]]},
                         pluck="name")
    if not old:
        return
    for child in ("Pests Scouting Entry", "Diseases Scouting Entry", "Trap Scouting Entry"):
        frappe.db.delete(child, {"parent": ["in", old]})
    frappe.db.delete("Scouting Entry", {"name": ["in", old]})


def insert_fixture():
    _ensure_masters()
    _clear_fixture_entries()
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
            # A capture position is mandatory; any point will do for the aggregates.
            "latitude": 0.0679,
            "longitude": 35.7543,
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
        # Scout, bed and zone are placeholder names, not real Employee / Bed /
        # Zone records — the aggregates read them as text.
        doc.flags.ignore_links = True
        doc.insert(ignore_permissions=True)
        names.append(doc.name)
    return names


# --- Station prevalence (common/prevalence.py) ------------------------------
# Severity is now fed each greenhouse's station prevalence in its LATEST scouted
# ISO week, over stations SCOUTED (spec D1/D4). The fixture greenhouses have no
# Zone rows, so tests patch _prevalence_rows.station_grid with this grid. Every
# fixture entry sits on _TEST_ZONE, so a greenhouse-week has one scouted station:
# no section reaches 3, the adjusted prevalence falls back to raw, and a cell
# reads 100% when its observation was recorded that week and 0% when it was not.
STATION_GRID = {_TEST_ZONE: (0, 0), "_TEST Zone 2": (2, 2)}


def fixture_station_grid(warehouse: str) -> dict:
    """Stand-in for _prevalence_rows.station_grid on the fixture greenhouses."""
    return dict(STATION_GRID) if warehouse in (_TEST_GH_1, _TEST_GH_2, _TEST_GH_3) else {}


def configure_rose_thresholds():
    """Rose bands for the fixture: _TEST Thrips stage "Adult" is High at 50%;
    its other stages fall back to the aggregate band, where 50% is Low.
    _TEST Powdery Mildew is High at 50% on its aggregate band."""
    import upande_scp.serverscripts.dashboard_aggregates._common as common

    for doctype, field, name in (("Pest Filter", "pest", _TEST_PEST_THRIPS),
                                 ("Disease Filter", "disease", _TEST_DISEASE_PM)):
        for old in frappe.get_all(doctype, filters={"crop_scouted": "Rose", field: name}, pluck="name"):
            frappe.delete_doc(doctype, old, force=True, ignore_permissions=True)
    frappe.get_doc({
        "doctype": "Pest Filter", "crop_scouted": "Rose", "pest": _TEST_PEST_THRIPS,
        "low_threshold": 10, "moderate_threshold": 60, "high_threshold": 90,
        "stages": [{"stage": "Adult", "low_threshold": 10, "moderate_threshold": 30, "high_threshold": 50}],
    }).insert(ignore_permissions=True)
    frappe.get_doc({
        "doctype": "Disease Filter", "crop_scouted": "Rose", "disease": _TEST_DISEASE_PM,
        "low_threshold": 10, "moderate_threshold": 20, "high_threshold": 40,
    }).insert(ignore_permissions=True)
    # load_thresholds memoises per request on frappe.local.
    if hasattr(frappe.local, common._THRESHOLD_CACHE_ATTR):
        delattr(frappe.local, common._THRESHOLD_CACHE_ATTR)
