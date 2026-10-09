"""Raw-SQL Scouting Entries placed on real stations, for the station-prevalence tests.

Same contract as crop_scoping_fixture: raw inserts skip the controller and the
cache-busting doc events, so callers roll back in tearDown and pass ``force="1"``
to cached aggregates. Dated 2031–2033: kaitet.local has no scouting there (its
data runs 2026-07-01 → 2026-09-09), so a window holds only what a test inserted.
"""

import frappe
from frappe.utils import now

from upande_scp.serverscripts.tests import crop_scoping_fixture as F

WEEK_10 = ("2031-03-03", "2031-03-09")  # 2031-W10
WEEK_11 = ("2031-03-10", "2031-03-16")  # 2031-W11
WEEK_53 = ("2032-12-27", "2033-01-02")  # 2032-W53 — 2033-01-02 (a Sunday) still belongs to it
WEEK_01 = ("2033-01-03", "2033-01-09")  # 2033-W01


def rose_greenhouses(n: int = 2) -> list:
    """The first `n` Rose greenhouses (by name) that have Zone rows."""
    farms = tuple(r[0] for r in frappe.db.sql(
        "select farm from `tabFarm Filter` where parenttype='Crop Scouted' and parent='Rose'"))
    return [r[0] for r in frappe.db.sql(
        """select w.name from `tabWarehouse` w
           where w.custom_farm in %(f)s and w.is_group=0 and w.warehouse_type='Greenhouse'
             and w.disabled=0 and w.name like '%%GH%%'
             and exists (select 1 from `tabZone` z where z.greenhouse = w.name)
           order by w.name limit %(n)s""",
        {"f": farms, "n": n},
    )]


def insert_station_entry(*, date, greenhouse=None, zone=None, block=None, tree=None,
                         crop=None, pests=(), diseases=(), pest_count=3, pest_stage="Adult") -> str:
    """One Scouting Entry on a real Zone (rose) or Orchard Tree (avocado)."""
    name = "_TEST-SP-" + frappe.generate_hash(length=10)
    bed = frappe.db.get_value("Zone", zone, "bed") if zone else None
    row = frappe.db.get_value("Orchard Tree", tree, "row") if tree else None
    stamp = now()
    frappe.db.sql(
        """insert into `tabScouting Entry`
           (name, creation, modified, owner, modified_by, docstatus, idx, naming_series,
            scouts_name, greenhouse, block, zone, bed, tree, `row`, date_of_capture,
            time_of_capture, crop_scouted, latitude, longitude)
           values (%(name)s, %(ts)s, %(ts)s, 'Administrator', 'Administrator', 0, 0,
            'SCE-.YYYY.-', %(scout)s, %(gh)s, %(block)s, %(zone)s, %(bed)s, %(tree)s, %(row)s,
            %(date)s, '08:00:00', %(crop)s, '0', '0')""",
        {
            "name": name, "ts": stamp, "scout": F._scout(),
            "gh": greenhouse, "block": block, "zone": zone, "bed": bed,
            "tree": tree, "row": row, "date": date, "crop": crop,
        },
    )
    for i, pest in enumerate(pests, start=1):
        frappe.db.sql(
            """insert into `tabPests Scouting Entry`
               (name, creation, modified, owner, modified_by, docstatus, idx, parent,
                parenttype, parentfield, pest, stage, plant_section, `count`)
               values (%(n)s, %(ts)s, %(ts)s, 'Administrator', 'Administrator', 0, %(i)s,
                %(p)s, 'Scouting Entry', 'pests_scouting_entry', %(pest)s, %(stage)s, 'Leaf', %(c)s)""",
            {"n": frappe.generate_hash(length=12), "ts": stamp, "i": i, "p": name,
             "pest": pest, "stage": pest_stage, "c": pest_count},
        )
    for i, disease in enumerate(diseases, start=1):
        frappe.db.sql(
            """insert into `tabDiseases Scouting Entry`
               (name, creation, modified, owner, modified_by, docstatus, idx, parent,
                parenttype, parentfield, disease, stage, plant_section)
               values (%(n)s, %(ts)s, %(ts)s, 'Administrator', 'Administrator', 0, %(i)s,
                %(p)s, 'Scouting Entry', 'diseases_scouting_entry', %(d)s, 'Active', 'Leaf')""",
            {"n": frappe.generate_hash(length=12), "ts": stamp, "i": i, "p": name, "d": disease},
        )
    return name


def stations_by_section(grid: dict) -> dict:
    """{(row, col): [station names sorted]}"""
    out: dict = {}
    for name, pos in grid.items():
        out.setdefault(tuple(pos), []).append(name)
    return {k: sorted(v) for k, v in out.items()}


def seed_even_week(warehouse, date, *, crop, per_section=3, infested_per_section=1,
                   pest="Thrips", disease=None, block=False) -> list:
    """`per_section` stations scouted in each of the 9 sections on `date`; the first
    `infested_per_section` of them carry `pest` (and `disease`). Same stations every
    call, so two weeks seeded this way share their scouted set."""
    from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows as R

    names = []
    for _pos, stations in sorted(stations_by_section(R._load_grid(warehouse)).items()):
        for i, st in enumerate(stations[:per_section]):
            hit = i < infested_per_section
            where = {"block": warehouse, "tree": st} if block else {"greenhouse": warehouse, "zone": st}
            names.append(insert_station_entry(
                date=date, crop=crop,
                pests=[pest] if hit and pest else [],
                diseases=[disease] if hit and disease else [],
                **where,
            ))
    return names
