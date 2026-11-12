"""A user's own sprays for one day, for the handset's "Today's sprays" screen.

The phone summarises from what it holds locally and works offline. This is the online
enrichment: what the site has *confirmed* (status, when it landed), plus the names the
phone cannot know (greenhouse, farm, item names). It is scoped to the logged-in user:
sessions they pushed (token owner) or that were applied under their login.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone as _tz
from zoneinfo import ZoneInfo

import frappe

from upande_scp.serverscripts.common.timezone import erp_timezone

TOKEN = "Spray Session Token"


def _tz_info():
	try:
		return ZoneInfo(erp_timezone())
	except Exception:
		return _tz.utc


def _utc_iso(value):
	"""A stored site-naive datetime as UTC ISO ("...Z") for the handset."""
	if not value:
		return None
	if isinstance(value, str):
		value = frappe.utils.get_datetime(value)
	if value.tzinfo is None:
		value = value.replace(tzinfo=_tz_info())
	return value.astimezone(_tz.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _day_bounds(date):
	day = frappe.utils.getdate(date)
	start = datetime(day.year, day.month, day.day)
	return start, start + timedelta(days=1)


def _as_list(value):
	if isinstance(value, str):
		try:
			value = json.loads(value)
		except Exception:
			value = []
	return [str(v) for v in (value or []) if v]


@frappe.whitelist()
def my_spray_day(date=None, work_orders=None) -> dict:
	"""Sessions the logged-in user recorded on `date` (site-local day).

	`work_orders` optionally names plans held only on the phone, so their greenhouse and
	farm come back too even when the site has no session for them yet.
	"""
	user = frappe.session.user
	start, end = _day_bounds(date or frappe.utils.nowdate())

	rows = frappe.db.sql(
		"""SELECT name, token, work_order, greenhouse, farm, status, mix_at, started_at,
		          ended_at, synced_at, refusal, past_cutoff
		     FROM `tabSpray Session Token`
		    WHERE (owner = %(u)s OR synced_by = %(u)s)
		      AND ((started_at >= %(s)s AND started_at < %(e)s)
		        OR (ended_at >= %(s)s AND ended_at < %(e)s)
		        OR (mix_at >= %(s)s AND mix_at < %(e)s))
		    ORDER BY COALESCE(started_at, mix_at, ended_at)""",
		{"u": user, "s": start, "e": end},
		as_dict=True,
	)

	item_names: dict = {}
	sessions = []
	for r in rows:
		scans = frappe.get_all(
			"Spray Session Scan",
			filters={"parent": r.name, "parenttype": TOKEN},
			fields=["item_code", "qty", "scanned_at"],
			order_by="idx",
		)
		for s in scans:
			item_names.setdefault(s.item_code, None)
			s["scanned_at"] = _utc_iso(s.get("scanned_at"))
		sessions.append({
			"token": r.token,
			"work_order": r.work_order,
			"greenhouse": r.greenhouse,
			"farm": r.farm,
			"status": r.status,
			"mix_at": _utc_iso(r.mix_at),
			"started_at": _utc_iso(r.started_at),
			"ended_at": _utc_iso(r.ended_at),
			"synced_at": _utc_iso(r.synced_at),
			"refusal": r.refusal,
			"past_cutoff": bool(r.past_cutoff),
			"scans": scans,
		})

	labels: dict = {}
	for wo in _as_list(work_orders)[:200]:
		gh = frappe.db.get_value("Work Order", wo, "custom_greenhouse")
		farm = frappe.db.get_value("Warehouse", gh, "custom_farm") if gh else None
		labels[wo] = {"greenhouse": gh, "farm": farm}

	for code in list(item_names):
		item_names[code] = frappe.db.get_value("Item", code, "item_name") or code

	return {
		"date": str(start.date()),
		"timezone": erp_timezone(),
		"sessions": sessions,
		"labels": labels,
		"item_names": item_names,
	}
