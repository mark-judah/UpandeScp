"""Raw-SQL scouting, band settings and rosters for the thresholds tests (piece 3a).

Same contract as prevalence_fixture: callers roll back in tearDown and pass
force="1" to cached aggregates. Weeks 2031-W20/W21/W22 — no other module seeds
them, and kaitet.local has no real scouting in 2031.
"""

import frappe
from frappe.utils import now

from upande_scp.serverscripts.dashboard_aggregates import _common
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows as R
from upande_scp.serverscripts.tests import prevalence_fixture as PF

WEEK_20 = ("2031-05-12", "2031-05-18")  # 2031-W20
WEEK_21 = ("2031-05-19", "2031-05-25")  # 2031-W21
WEEK_22 = ("2031-05-26", "2031-06-01")  # 2031-W22

#: roster key -> (child doctype, Farm parentfield)
ROSTERS = {
    "creators": ("Farm Spray Plan Creator", "spray_plan_creators"),
    "approvers": ("Farm Spray Plan Approver", "spray_plan_approvers"),
    "supervisors": ("Farm Spray Supervisor", "spray_supervisors"),
}


def seed_week(warehouse, date, *, crop, per_section=3, infested_per_section=1, pest="Thrips",
              stage="Adult", count=3, sections=None, block=False) -> list:
    """`per_section` stations scouted in each 3 × 3 section (only the (row, col)
    pairs in `sections` when given); the first `infested_per_section` of them
    carry `pest` at `stage` with `count`. Same stations on every call."""
    names = []
    for pos, stations in sorted(PF.stations_by_section(R._load_grid(warehouse)).items()):
        if sections is not None and tuple(pos) not in sections:
            continue
        for i, st in enumerate(stations[:per_section]):
            hit = i < infested_per_section
            where = {"block": warehouse, "tree": st} if block else {"greenhouse": warehouse, "zone": st}
            names.append(PF.insert_station_entry(
                date=date, crop=crop, pests=[pest] if hit else [],
                pest_stage=stage, pest_count=count, **where,
            ))
    return names


def set_bands(crop, pest, low, moderate, high, measure="Percentage", stage_bands=None) -> str:
    """Measure + row bands on the crop's Pest Filter for `pest`; every stage band
    zeroed unless given in `stage_bands` = {stage: (low, moderate, high)}."""
    name = frappe.db.get_value("Pest Filter", {"crop_scouted": crop, "pest": pest}, "name")
    frappe.db.set_value("Pest Filter", name, {
        "measure": measure, "low_threshold": low, "moderate_threshold": moderate, "high_threshold": high,
    })
    for s in frappe.get_all("Pests Stages", filters={"parent": name, "parenttype": "Pest Filter"},
                            fields=["name", "stage"]):
        b = (stage_bands or {}).get(s.stage, (0, 0, 0))
        frappe.db.set_value("Pests Stages", s.name, {
            "low_threshold": b[0], "moderate_threshold": b[1], "high_threshold": b[2],
        })
    _common.clear_threshold_cache()
    return name


def clear_all_bands(crop) -> None:
    """Zero every band of the crop, so only what a test sets can classify or alert."""
    for doctype, child in (("Pest Filter", "Pests Stages"), ("Disease Filter", "Disease Stages")):
        for name in frappe.get_all(doctype, filters={"crop_scouted": crop}, pluck="name"):
            frappe.db.sql(
                f"update `tab{doctype}` set low_threshold=0, moderate_threshold=0, high_threshold=0 where name=%s",
                (name,),
            )
            frappe.db.sql(
                f"update `tab{child}` set low_threshold=0, moderate_threshold=0, high_threshold=0 "
                "where parent=%s and parenttype=%s",
                (name, doctype),
            )
    _common.clear_threshold_cache()


def set_roster(farm, roster, users) -> None:
    """Replace one Farm roster (`creators` / `approvers` / `supervisors`) with `users`."""
    child, parentfield = ROSTERS[roster]
    frappe.db.sql(f"delete from `tab{child}` where parent=%s and parenttype='Farm'", (farm,))
    for i, user in enumerate(users, start=1):
        frappe.db.sql(
            f"""insert into `tab{child}`
               (name, creation, modified, owner, modified_by, docstatus, idx, user,
                parent, parentfield, parenttype)
               values (%(n)s, %(ts)s, %(ts)s, 'Administrator', 'Administrator', 0, %(i)s, %(u)s,
                %(f)s, %(pf)s, 'Farm')""",
            {"n": "_TEST-TH-" + frappe.generate_hash(length=10), "ts": now(), "i": i,
             "u": user, "f": farm, "pf": parentfield},
        )


def ensure_user(email) -> str:
    """A committed, enabled user (the test_notifications pattern)."""
    if not frappe.db.exists("User", email):
        frappe.get_doc({
            "doctype": "User", "email": email, "first_name": email.split("@")[0],
            "send_welcome_email": 0, "enabled": 1,
        }).insert(ignore_permissions=True)
        frappe.db.commit()
    return email


ALL_SECTIONS = frozenset((r, c) for r in range(3) for c in range(3))


def seed_hot_section(warehouse, date, *, crop="Rose", hot=(0, 0), hot_infested=4, others=None,
                     others_infested=0, per_section=5, pest="Thrips", stage="Adult", block=False) -> list:
    """`per_section` stations scouted in section `hot` (the first `hot_infested`
    carry `pest`) and in each of `others` (default: the other 8; the first
    `others_infested` carry it). Same stations on every call, so a later call
    with a larger count only adds infested stations."""
    others = (ALL_SECTIONS - {tuple(hot)}) if others is None else set(others)
    names = seed_week(warehouse, date, crop=crop, per_section=per_section, infested_per_section=hot_infested,
                      pest=pest, stage=stage, sections={tuple(hot)}, block=block)
    if others:
        names += seed_week(warehouse, date, crop=crop, per_section=per_section,
                           infested_per_section=others_infested, pest=pest, stage=stage,
                           sections=others, block=block)
    return names
