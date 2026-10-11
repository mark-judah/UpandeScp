"""Personnel ▸ Scouts: the crop's scouts, ranked, each with a read-only record
(personnel spec P3–P5).

The figures are the per-scout rows of the ``quality`` aggregate — the Coverage
report's — read through its cache, so this page adds no scan of its own;
``common/scout_ranking`` scores them.

Who may open it: SCP General Manager, System Manager and SCP Scouting User,
on the farms ``crop_scope.visible_farms`` gives them (company scope ∩ crop).
"All farms" is offered only when that covers every farm of the crop; otherwise
a farm must be chosen, and the first visible one is used when none is.
"""

from __future__ import annotations

from datetime import timedelta
from importlib import import_module

import frappe
from frappe.utils import getdate, nowdate

from upande_scp.serverscripts.common import crop_catalog, crop_scope
from upande_scp.serverscripts.common import scout_ranking as SR
from upande_scp.serverscripts.scouting import scouting_metrics

# The package re-exports the ``quality`` function under the name ``_quality``,
# shadowing the submodule, so it is imported by its full path.
_quality = import_module("upande_scp.serverscripts.dashboard_aggregates._quality")

SCOUT_ROLES = ("SCP General Manager", "System Manager", "SCP Scouting User")
#: The default window: this many whole ISO weeks, ending last Sunday.
DEFAULT_WEEKS = 4


def _assert_role(user=None):
	user = user or frappe.session.user
	if user == "Administrator" or set(frappe.get_roles(user)) & set(SCOUT_ROLES):
		return
	frappe.throw("You do not have access to the scouts.", frappe.PermissionError)


def default_range(today=None) -> tuple[str, str]:
	"""The last ``DEFAULT_WEEKS`` complete ISO weeks: Monday → the Sunday before today."""
	today = getdate(today or nowdate())
	sunday = today - timedelta(days=today.isoweekday() % 7 or 7)
	monday = sunday - timedelta(days=7 * DEFAULT_WEEKS - 1)
	return monday.isoformat(), sunday.isoformat()


def farm_scope(crop, farm, farms_map, user=None) -> dict:
	"""``{"farm", "farms", "allFarms"}`` — the farm to read ("" = all), the farms
	the picker may offer, and whether "All farms" is allowed. Refuses a farm
	outside the user's scope."""
	visible = crop_scope.visible_farms(None, crop or None, user)
	crop_farms = crop_scope.farms_for_crop(crop) if crop else None
	known = [f for f in farms_map if crop_farms is None or f in crop_farms]
	options = sorted(f for f in known if visible is None or f in visible)
	all_ok = visible is None or set(known) <= visible
	farm = (farm or "").strip()
	if farm:
		if farm not in options:
			frappe.throw(f"You cannot see the scouts of farm {farm}.", frappe.PermissionError)
	elif not all_ok:
		if not options:
			frappe.throw("You have no farm whose scouts you can see.", frappe.PermissionError)
		farm = options[0]
	return {"farm": farm, "farms": options, "allFarms": all_ok}


def _images(ids) -> dict:
	if not ids:
		return {}
	return {
		r.name: r.image or ""
		for r in frappe.get_all("Employee", filters={"name": ["in", list(ids)]},
		                        fields=["name", "image"], limit_page_length=0)
	}


@frappe.whitelist()
def get_scouts(crop=None, farm=None, from_date=None, to_date=None, job_id=None, force=None):
	"""The ranking and every scout's record, for one crop, farm and date range."""
	_assert_role()
	crop = crop_catalog.resolve_crop(crop)
	farms_map = scouting_metrics.get_farms_and_warehouses() or {}
	fs = farm_scope(crop, farm, farms_map)
	if not from_date or not to_date:
		from_date, to_date = default_range()
	q = _quality.quality(
		{"crop": crop, "farm": fs["farm"], "greenhouse": "", "from_date": from_date,
		 "to_date": to_date, "job_id": job_id or ""},
		force=str(force or "").lower() in ("1", "true"),
	)
	farm_of_house = {wh: f for f, whs in farms_map.items() for wh in whs}
	out = SR.rank(q.get("scouts") or [], farm_of_house)
	flags: dict = {}
	for f in q.get("flags") or []:
		if f.get("subject") == "scout":
			flags.setdefault(f["name"], []).append(f)
	images = _images([r["scout"] for r in out["ranked"] + out["notEnoughDays"]])
	for r in out["ranked"] + out["notEnoughDays"]:
		r["image"] = images.get(r["scout"], "")
		r["flags"] = flags.get(r["scout"], [])
	return {
		**out,
		"medians": [{"farm": k, **v} for k, v in sorted(out["medians"].items(), key=lambda kv: kv[0] or "")],
		**fs,
		"range": q.get("range"),
		"clamped": q.get("clamped"),
		"weights": {"effort": SR.EFFORT_WEIGHT, "integrity": SR.INTEGRITY_WEIGHT, "gps": SR.GPS_WEIGHT},
		"minActiveDays": SR.MIN_ACTIVE_DAYS,
		"defaultRange": dict(zip(("from_date", "to_date"), default_range())),
	}
