"""The latest reading at one trap, with the scout who recorded it
(spec 2026-10-11 TM4).

The trap maps aggregate traps from the scouting entries in the browser; those
carry ``scouts_name`` but not the Employee photo. A click on a trap asks this
endpoint for the latest reading in the window, with the recorder's name and
photo (Employee.image).

Scope: the trap must sit in a greenhouse (or farm) the user may see, and only
entries in the user's houses are read.
"""

import frappe

from upande_scp.serverscripts.common import crop_scope
from upande_scp.serverscripts.dashboard_aggregates._common import coerce_date
from upande_scp.serverscripts.dashboard_aggregates._photo_feed import hms, scout_people

_LATEST = """
SELECT se.name, se.scouts_name, se.date_of_capture, se.time_of_capture, c.pest, c.`count`,
       COALESCE(NULLIF(se.block, ''), se.greenhouse)
FROM `tabTrap Scouting Entry` c
JOIN `tabScouting Entry` se ON se.name = c.parent AND se.docstatus < 2
WHERE c.parenttype = 'Scouting Entry' AND c.trap = %(trap)s{where}
ORDER BY se.date_of_capture DESC, se.time_of_capture DESC, se.creation DESC
LIMIT 1
"""


@frappe.whitelist()
def get_latest_trap_reading(trap=None, from_date=None, to_date=None):
    """``{trap, entry, scout, scoutName, image, date, time, count, pest, house}``
    for the newest reading at ``trap`` between the dates (both optional), or
    ``{trap, entry: None}`` when there is none."""
    trap = (trap or "").strip()
    if not trap:
        frappe.throw("A trap is required.", frappe.ValidationError)
    row = frappe.db.get_value("Trap", trap, ["name", "farm", "greenhouse"], as_dict=True)
    if not row:
        frappe.throw(f"Trap {trap} not found.", frappe.DoesNotExistError)

    houses = crop_scope.scoped_greenhouses(None)
    if houses is not None:
        farms = crop_scope.scoped_farms(None) or set()
        ok = (row.greenhouse and row.greenhouse in houses) or (
            not row.greenhouse and row.farm and row.farm in farms)
        if not ok:
            frappe.throw("You do not have access to that trap.", frappe.PermissionError)

    cond, params = [], {"trap": trap}
    if from_date:
        cond.append("se.date_of_capture >= %(from_date)s")
        params["from_date"] = coerce_date(from_date)
    if to_date:
        cond.append("se.date_of_capture <= %(to_date)s")
        params["to_date"] = coerce_date(to_date)
    if houses is not None:
        if not houses:
            return {"trap": trap, "entry": None}
        cond.append("COALESCE(NULLIF(se.block, ''), se.greenhouse) IN %(houses)s")
        params["houses"] = tuple(sorted(houses))
    rows = frappe.db.sql(_LATEST.format(where="".join(f" AND {c}" for c in cond)), params)
    if not rows:
        return {"trap": trap, "entry": None}
    entry, scout, day, time, pest, count, house = rows[0]
    person = scout_people({scout}).get(scout) or {}
    count = float(count or 0)
    return {
        "trap": trap,
        "entry": entry,
        "scout": scout or "",
        "scoutName": person.get("name") or scout or "",
        "image": person.get("image") or "",
        "date": coerce_date(day),
        "time": hms(time),
        "count": int(count) if count.is_integer() else round(count, 2),
        "pest": pest or "",
        "house": house or "",
    }
