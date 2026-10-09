"""Raw-SQL Scouting Entries for the crop-scoping tests.

Raw inserts skip the Scouting Entry controller and the doc events that bust the
caches. Callers therefore roll back in tearDown, pass ``force="1"`` to cached
aggregates, and delete any observations week key they touch.

Dates are in 2031 — no real data exists there (kaitet.local max is 2026-09), so a
window holds only what the test inserted. Each test module uses its own ISO week so
cached results from one module can never satisfy another's assertions.
"""

import frappe
from frappe.utils import now

WEEK_A = ("2031-01-06", "2031-01-12")  # 2031-W02 — test_crop_scoped_aggregates
WEEK_B = ("2031-01-13", "2031-01-19")  # 2031-W03 — test_crop_scoped_aggregate_detail
WEEK_C = ("2031-01-20", "2031-01-26")  # 2031-W04 — test_crop_scoped_observations
WEEK_D = ("2031-01-27", "2031-02-02")  # 2031-W05 — test_crop_scoped_spray_plan

PETER = "pkamuren@karenroses.com"  # SCP General Manager at Karen Roses: Rose only


def _first(sql, params=None):
    rows = frappe.db.sql(sql, params or {})
    return rows[0][0] if rows else None


def rose_greenhouse() -> str:
    farms = tuple(r[0] for r in frappe.db.sql(
        "select farm from `tabFarm Filter` where parenttype='Crop Scouted' and parent='Rose'"))
    return _first(
        """select name from `tabWarehouse` where custom_farm in %(f)s and is_group=0
           and warehouse_type='Greenhouse' and disabled=0 and name like '%%GH%%'
           order by name limit 1""",
        {"f": farms},
    )


def avocado_block() -> str:
    return _first(
        """select name from `tabWarehouse` where custom_farm='Lokitela' and is_group=0
           and warehouse_type='Block' and disabled=0 order by name limit 1""")


def _scout() -> str:
    return _first("select name from `tabEmployee` order by name limit 1")


def insert_entry(*, greenhouse=None, block=None, crop=None, date, pests=(), diseases=()) -> str:
    """One Scouting Entry with optional pest/disease child rows. Returns its name."""
    name = "_TEST-CS-" + frappe.generate_hash(length=10)
    where = greenhouse or block
    stamp = now()
    frappe.db.sql(
        """insert into `tabScouting Entry`
           (name, creation, modified, owner, modified_by, docstatus, idx, naming_series,
            scouts_name, greenhouse, block, zone, bed, date_of_capture, time_of_capture,
            crop_scouted, latitude, longitude)
           values (%(name)s, %(ts)s, %(ts)s, 'Administrator', 'Administrator', 0, 0,
            'SCE-.YYYY.-', %(scout)s, %(gh)s, %(block)s, %(zone)s, %(bed)s, %(date)s,
            '08:00:00', %(crop)s, '0', '0')""",
        {
            "name": name, "ts": stamp, "scout": _scout(),
            "gh": greenhouse, "block": block,
            "zone": f"{where} - Bed 1 - Zone 1", "bed": f"{where} - Bed 1",
            "date": date, "crop": crop,
        },
    )
    for i, pest in enumerate(pests, start=1):
        frappe.db.sql(
            """insert into `tabPests Scouting Entry`
               (name, creation, modified, owner, modified_by, docstatus, idx, parent,
                parenttype, parentfield, pest, stage, plant_section, `count`)
               values (%(n)s, %(ts)s, %(ts)s, 'Administrator', 'Administrator', 0, %(i)s,
                %(p)s, 'Scouting Entry', 'pests_scouting_entry', %(pest)s, 'Adult', 'Leaf', 3)""",
            {"n": frappe.generate_hash(length=12), "ts": stamp, "i": i, "p": name, "pest": pest},
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


def add_creator_roster(farm: str, user: str = "Administrator") -> None:
    """Put `user` on a farm's Spray Plan Creator roster (raw, rolled back)."""
    frappe.db.sql(
        """insert into `tabFarm Spray Plan Creator`
           (name, creation, modified, owner, modified_by, docstatus, idx, user,
            parent, parentfield, parenttype)
           values (%(n)s, %(ts)s, %(ts)s, 'Administrator', 'Administrator', 0, 99, %(u)s,
            %(f)s, 'spray_plan_creators', 'Farm')""",
        {"n": "_TEST-CS-" + frappe.generate_hash(length=10), "ts": now(), "u": user, "f": farm},
    )
