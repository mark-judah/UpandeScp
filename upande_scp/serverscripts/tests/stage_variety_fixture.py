"""Stage roles, weights and bed varieties for the stage & variety tests (piece 4).

Callers roll back in tearDown and THEN call ``reset()``: the stage-roles catalog
lives in Redis, which a rollback does not touch, so a test's role or weight
would otherwise be served to the live site for up to an hour. Weeks 2031-W44 /
W45 — no other module seeds them, and kaitet.local has no real scouting in 2031.
"""

import frappe

from upande_scp.serverscripts.common import stage_roles
from upande_scp.serverscripts.dashboard_aggregates import _common
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows as R
from upande_scp.serverscripts.tests import prevalence_fixture as PF

WEEK_44 = ("2031-10-27", "2031-11-02")  # 2031-W44
WEEK_45 = ("2031-11-03", "2031-11-09")  # 2031-W45


def reset() -> None:
    """Drop every cached copy of roles, weights and bands."""
    stage_roles.invalidate_stage_roles()
    _common.clear_threshold_cache()


def set_role(stage, role) -> None:
    frappe.db.sql("update `tabStage` set stage_role=%s where name=%s", (role, stage))
    reset()


def set_master_weight(stage, weight) -> None:
    frappe.db.sql("update `tabStage` set weight=%s where name=%s", (weight, stage))
    reset()


def set_override(crop, pest, stage, weight) -> None:
    """The crop's Pests Stages weight for `pest` × `stage` (0 = the Stage's)."""
    parent = frappe.db.get_value("Pest Filter", {"crop_scouted": crop, "pest": pest}, "name")
    frappe.db.sql(
        "update `tabPests Stages` set weight=%s where parent=%s and parenttype='Pest Filter' and stage=%s",
        (weight, parent, stage),
    )
    reset()


def seeded_stations(warehouse, rows=(0, 1, 2), per_section=3) -> list:
    """The stations `thresholds_fixture.seed_week` uses, in the grid rows given
    (row r = the r-th third of the house's beds)."""
    out = []
    for (r, _c), stations in sorted(PF.stations_by_section(R._load_grid(warehouse)).items()):
        if r in rows:
            out.extend(stations[:per_section])
    return out


def set_bed_variety(stations, variety) -> set:
    """Set (rolled back) the variety of the beds those zones lie on; returns the beds."""
    beds = {b for b in (frappe.db.get_value("Zone", s, "bed") for s in stations) if b}
    for bed in beds:
        frappe.db.sql("update `tabBed` set variety=%s where name=%s", (variety, bed))
    return beds
