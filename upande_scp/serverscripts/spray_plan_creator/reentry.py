"""Re-entry and pre-harvest: tell production when a house is sprayed, when it is
safe to walk into again, and when it may be picked.

The clock starts when the spray *ends*, not when it was scheduled. A plan
scheduled for 06:00 and finished at 09:40 keeps its pickers out until 09:40 plus
the interval; counting from 06:00 let them in early.

One entry point for both ways a spray ends. ``spray_session.end_spray_session``
is that point: the live Stop button calls it, and so does the offline replay
(``offline_session.sync_spray_session``), passing the time the spray really ended.
So ``apply_spray_end`` is called from one place and gets the right clock either way.

Both intervals come from the product's ``Spray Product`` sidecar (``reentry_interval_hrs``
and ``phi_days``), taken as the maximum across the tank mix by ``common.crop_protection``.

Notices (bell + email) go out exactly once each, guarded by hidden Check flags on
the Work Order, and the scheduler (`notify_cleared`) sends "safe to re-enter" /
"harvest may resume" when the clocks run out.

``get_entry_status`` is the integration point for a production / harvest module.
"""

from __future__ import annotations

import re
from datetime import timedelta

import frappe
from frappe.utils import cint, flt, get_datetime, now_datetime

from upande_scp.serverscripts.common import crop_protection as CP
from upande_scp.serverscripts.common import crop_scope
from upande_scp.serverscripts.common import notifications as N

CATEGORY = "reentry"

NO_ENTRY = "no_entry"
HARVEST_HELD = "harvest_held"
CLEAR = "clear"

#: Sprays older than this are never re-examined: no re-entry or PHI on a label
#: runs this long, and it bounds both the scheduler's and the board's query.
LOOKBACK_DAYS = 30

#: Who may read the board / API. Farm scope still applies on top.
ENTRY_ROLES = (
	"SCP Production Supervisor",
	"SCP General Manager",
	"SCP Spray Plan Creator",
	"SCP Spray Plan Approver",
	"SCP Spray Supervisor",
	"System Manager",
	"Administrator",
)
#: A user holding only this role is held to the farms they are rostered on.
_ONLY_PRODUCTION = "SCP Production Supervisor"


# --------------------------------------------------------------------------
# Pure helpers (no site needed)
# --------------------------------------------------------------------------


def house_label(warehouse: str | None) -> str:
	"""'Chepsito GH 18 - KR' -> 'Chepsito GH 18' (drop the company abbreviation)."""
	return re.sub(r"\s-\s[A-Za-z0-9]{1,8}$", "", warehouse or "").strip()


def _hhmm(dt) -> str:
	return get_datetime(dt).strftime("%H:%M")


def _when(dt, ref=None) -> str:
	"""'14:30' for today, 'Thu 15 Oct 14:30' otherwise."""
	d = get_datetime(dt)
	ref = get_datetime(ref) if ref else now_datetime()
	if d.date() == ref.date():
		return d.strftime("%H:%M")
	return d.strftime("%a %d %b %H:%M")


def effective_times(ended_at, period_hrs, harvest_after_value=None) -> tuple:
	"""(reentry_time, harvest_after) for a spray that ended at ``ended_at``.

	Always derived from the real end, so a plan finished before this feature
	existed (whose stored re-entry time counted from the *scheduled* time) is still
	classified on the right clock."""
	if not ended_at:
		return None, None
	return CP.reentry_time(ended_at, period_hrs), (
		get_datetime(harvest_after_value) if harvest_after_value else None
	)


def classify(reentry_time, harvest_after, now) -> str:
	"""no_entry while the re-entry clock runs, then harvest_held while the PHI runs,
	then clear."""
	now = get_datetime(now)
	if reentry_time and get_datetime(reentry_time) > now:
		return NO_ENTRY
	if harvest_after and get_datetime(harvest_after) > now:
		return HARVEST_HELD
	return CLEAR


def sprayed_message(house: str, products: list[str], ended_at, reentry_time, harvest_after, hrs) -> str:
	"""'<House> sprayed (<products>) - ended HH:MM. No entry until <time>. Harvest from <date>'."""
	text = f"{house} sprayed ({', '.join(products) or 'no products listed'}) — ended {_hhmm(ended_at)}."
	if flt(hrs) > 0 and reentry_time:
		text += f" No entry until {_when(reentry_time, ended_at)}."
	else:
		text += " No re-entry restriction."
	if harvest_after:
		text += f" Harvest from {get_datetime(harvest_after).strftime('%a %d %b')}."
	return text


# --------------------------------------------------------------------------
# Facts about a Work Order
# --------------------------------------------------------------------------


def _item_codes(wo) -> list[str]:
	return [r.item_code for r in (wo.get("required_items") or []) if r.item_code]


def _products(wo) -> list[str]:
	"""Names of the spray products in the mix (water and the like are left out)."""
	rows = [r for r in (wo.get("required_items") or []) if r.item_code]
	spray = [r for r in rows if CP.is_spray_product(r.item_code)]
	return [r.item_name or r.item_code for r in (spray or rows)]


def houses_of(wo) -> list[str]:
	"""Every house/block the plan sprayed: its block rows if it is a group plan,
	else its one greenhouse."""
	rows = [r.block for r in (wo.get("custom_blocks") or []) if r.get("block")]
	if rows:
		return rows
	return [wo.custom_greenhouse] if wo.get("custom_greenhouse") else []


def _farm_of(house: str | None) -> str | None:
	return frappe.db.get_value("Warehouse", house, "custom_farm") if house else None


def _crop_slug_for_farm(farm: str | None) -> str:
	if farm:
		crops = frappe.get_all(
			"Farm Filter",
			filters={"parenttype": "Crop Scouted", "farm": farm},
			pluck="parent",
			order_by="parent",
			limit=1,
		)
		if crops:
			return re.sub(r"\s+", "-", crops[0].strip().lower())
	return "rose"


def _production_supervisors(farm: str | None) -> list[str]:
	if not farm or not frappe.db.table_exists("Farm Production Supervisor"):
		return []
	return frappe.get_all(
		"Farm Production Supervisor",
		filters={"parent": farm, "parenttype": "Farm"},
		pluck="user",
	)


def _email_for(user: str) -> str | None:
	enabled, email = frappe.db.get_value("User", user, ["enabled", "email"]) or (0, None)
	if not enabled:
		return None
	addr = email or user
	return addr if "@" in (addr or "") else None


# --------------------------------------------------------------------------
# Spray end
# --------------------------------------------------------------------------


def apply_spray_end(wo, ended_at) -> dict:
	"""Stamp the real re-entry / harvest clocks on a plan whose spray just ended,
	and tell the people concerned. Called by ``end_spray_session`` (live and offline).

	``wo`` is the Work Order doc (or its name); ``ended_at`` is when the spray
	actually finished. Writes straight to the row, so it is safe to call after the
	workflow state was set. Notices are best-effort: a failure to notify is logged
	and never undoes the spray end.
	"""
	if isinstance(wo, str):
		wo = frappe.get_doc("Work Order", wo)
	ended = get_datetime(ended_at)
	codes = _item_codes(wo)
	hrs = CP.max_reentry_interval_hrs(codes)
	phi = CP.max_phi_days(codes)
	reentry_time = CP.reentry_time(ended, hrs)
	harvest_after = CP.harvest_after(ended, phi)
	values = {
		"custom_reentry_period_hrs": hrs,
		"custom_reentry_time": reentry_time,
		"custom_phi_days": phi,
		"custom_harvest_after": harvest_after,
		# Nothing to wait for means nothing to announce later: do not send a
		# "safe to re-enter" message for a house that never was unsafe.
		"custom_reentry_cleared_notified": 1 if hrs <= 0 else 0,
		"custom_phi_cleared_notified": 1 if not harvest_after else 0,
	}
	frappe.db.set_value("Work Order", wo.name, values, update_modified=False)
	for k, v in values.items():
		wo.set(k, v)
	wo.set("actual_end_date", ended)  # the doc was loaded before the state change
	try:
		notified = notify_sprayed(wo)
	except Exception:
		frappe.log_error(frappe.get_traceback(), "reentry: notify_sprayed failed")
		notified = []
	return {"reentry_time": reentry_time, "harvest_after": harvest_after, "notified": notified}


def _recipients(wo, farm: str | None) -> tuple[list[str], list[str]]:
	"""(bell recipients, email recipients). Production supervisors of the farm
	plus the plan's creator: they know the plan and are not a crowd. Emails go to
	the same people; live email sits at a daily cap, so no farm-wide fan-out."""
	users = list(_production_supervisors(farm))
	if wo.owner:
		users.append(wo.owner)
	clean = N._clean(users)
	return clean, clean


def _send_email(users: list[str], subject: str, body: str, wo_name: str) -> list[str]:
	sent = []
	for user in users:
		addr = _email_for(user)
		if not addr:
			continue
		try:
			frappe.sendmail(
				recipients=[addr],
				subject=subject,
				message=f"<p>{frappe.utils.escape_html(body)}</p>",
				reference_doctype="Work Order",
				reference_name=wo_name,
			)
			sent.append(addr)
		except Exception:
			frappe.log_error(frappe.get_traceback(), f"reentry email: {user}")
	return sent


def _announce(wo, farm, subject_prefix: str, text: str, houses: list[str]) -> list[str]:
	link = f"#/{_crop_slug_for_farm(farm)}/reentry"
	bell, mail = _recipients(wo, farm)
	notified = N.notify(bell, text, text, "Work Order", wo.name, category=CATEGORY, link=link)
	_send_email(mail, f"{subject_prefix}: {', '.join(house_label(h) for h in houses)}", text, wo.name)
	return notified


def notify_sprayed(wo) -> list[str]:
	"""The 'sprayed, no entry until...' notice. Idempotent via the flag."""
	if cint(frappe.db.get_value("Work Order", wo.name, "custom_reentry_notified")):
		return []
	houses = houses_of(wo)
	farm = _farm_of(houses[0]) if houses else None
	ended = wo.get("actual_end_date") or get_datetime(wo.custom_reentry_time)
	text = sprayed_message(
		" + ".join(house_label(h) for h in houses) or wo.name,
		_products(wo),
		ended,
		wo.custom_reentry_time,
		wo.custom_harvest_after,
		wo.custom_reentry_period_hrs,
	)
	notified = _announce(wo, farm, "Sprayed", text, houses)
	frappe.db.set_value("Work Order", wo.name, "custom_reentry_notified", 1, update_modified=False)
	return notified


# --------------------------------------------------------------------------
# Scheduler: the clocks running out
# --------------------------------------------------------------------------


def notify_cleared(now=None) -> dict:
	"""Cron (every 10 min): announce houses that became safe to enter and houses
	whose pre-harvest interval is over.

	Only plans this feature already announced (``custom_reentry_notified``) are
	considered, so switching it on does not announce a month of old sprays. Bounded
	to the last ``LOOKBACK_DAYS``, and each notice is flagged so it goes out once.
	"""
	now = get_datetime(now) if now else now_datetime()
	cutoff = now - timedelta(days=LOOKBACK_DAYS)
	rows = frappe.db.sql(
		"""SELECT name, custom_reentry_time, custom_harvest_after,
		          custom_reentry_cleared_notified AS rc, custom_phi_cleared_notified AS pc
		   FROM `tabWork Order`
		   WHERE workflow_state = 'Completed'
		     AND actual_end_date >= %(cutoff)s
		     AND custom_reentry_notified = 1
		     AND ((custom_reentry_cleared_notified = 0 AND custom_reentry_time <= %(now)s)
		       OR (custom_phi_cleared_notified = 0 AND custom_harvest_after <= %(now)s))""",
		{"cutoff": cutoff, "now": now},
		as_dict=True,
	)
	sent = {"reentry": [], "harvest": []}
	for r in rows:
		try:
			wo = frappe.get_doc("Work Order", r.name)
			houses = houses_of(wo)
			farm = _farm_of(houses[0]) if houses else None
			label = " + ".join(house_label(h) for h in houses) or wo.name
			if not cint(r.rc) and r.custom_reentry_time and get_datetime(r.custom_reentry_time) <= now:
				_announce(
					wo, farm, "Safe to re-enter",
					f"{label} is safe to re-enter (since {_hhmm(r.custom_reentry_time)}).",
					houses,
				)
				frappe.db.set_value(
					"Work Order", wo.name, "custom_reentry_cleared_notified", 1, update_modified=False
				)
				sent["reentry"].append(wo.name)
			if not cint(r.pc) and r.custom_harvest_after and get_datetime(r.custom_harvest_after) <= now:
				_announce(
					wo, farm, "Harvest may resume",
					f"{label}: pre-harvest interval over, harvest may resume.",
					houses,
				)
				frappe.db.set_value(
					"Work Order", wo.name, "custom_phi_cleared_notified", 1, update_modified=False
				)
				sent["harvest"].append(wo.name)
			frappe.db.commit()
		except Exception:
			frappe.db.rollback()
			frappe.log_error(frappe.get_traceback(), f"reentry notify_cleared: {r.name}")
	return sent


# --------------------------------------------------------------------------
# The board / integration API
# --------------------------------------------------------------------------


def _require_access() -> None:
	roles = set(frappe.get_roles())
	if not roles & set(ENTRY_ROLES):
		frappe.throw("You are not allowed to see re-entry status.", frappe.PermissionError)


def _visible_farms(crop: str | None) -> set[str] | None:
	"""Farms this user may read (None = unrestricted). A user whose only SCP role
	is Production Supervisor is held to the farms they are rostered on."""
	farms = crop_scope.scoped_farms(crop)
	roles = set(frappe.get_roles())
	if _ONLY_PRODUCTION in roles and not (roles & (set(ENTRY_ROLES) - {_ONLY_PRODUCTION})):
		rostered = crop_scope.rostered_farms("production_supervisors")
		return rostered if farms is None else farms & rostered
	return farms


def build_status(farm=None, crop=None, now=None, farms=None) -> list[dict]:
	"""The classified houses. ``farms`` (a set, or None for all) is the permission
	scope the caller already resolved; ``farm``/``crop`` narrow within it."""
	now = get_datetime(now) if now else now_datetime()
	cutoff = now - timedelta(days=LOOKBACK_DAYS)

	scope = farms
	if farm:
		scope = {farm} if scope is None else scope & {farm}
	if scope is not None and not scope:
		return []

	wh_filters = {"custom_farm": ["in", list(scope)]} if scope is not None else {}
	wh_farm = {
		w.name: w.custom_farm
		for w in frappe.get_all("Warehouse", filters=wh_filters, fields=["name", "custom_farm"])
	}
	if not wh_farm:
		return []

	# Bounded by state + end date. A group plan sprays several blocks, so its
	# block rows are read too, whatever its primary greenhouse is.
	wos = frappe.get_all(
		"Work Order",
		filters={"workflow_state": "Completed", "actual_end_date": [">=", cutoff]},
		fields=[
			"name", "custom_greenhouse", "actual_end_date", "custom_reentry_period_hrs",
			"custom_harvest_after",
		],
		limit_page_length=0,
	)
	blocks: dict[str, list[str]] = {}
	if wos and frappe.db.table_exists("Spray Plan Block"):
		for b in frappe.get_all(
			"Spray Plan Block",
			filters={"parent": ["in", [w.name for w in wos]], "parenttype": "Work Order"},
			fields=["parent", "block"],
			limit_page_length=0,
		):
			blocks.setdefault(b.parent, []).append(b.block)

	per_house: dict[str, list[dict]] = {}
	for w in wos:
		if not w.actual_end_date:
			continue
		re_t, ha = effective_times(w.actual_end_date, w.custom_reentry_period_hrs, w.custom_harvest_after)
		spray = {"wo": w.name, "ended_at": get_datetime(w.actual_end_date), "reentry": re_t, "harvest": ha}
		for house in blocks.get(w.name) or [w.custom_greenhouse]:
			if house in wh_farm:
				per_house.setdefault(house, []).append(spray)

	crop_farms = crop_scope.farms_for_crop(crop) if crop else None
	out = []
	for house, sprays in per_house.items():
		if crop_farms is not None and wh_farm[house] not in crop_farms:
			continue
		re_bind = max(
			(s for s in sprays if s["reentry"]), key=lambda s: s["reentry"], default=None
		)
		ha_bind = max(
			(s for s in sprays if s["harvest"]), key=lambda s: s["harvest"], default=None
		)
		reentry_time = re_bind["reentry"] if re_bind else None
		harvest_after = ha_bind["harvest"] if ha_bind else None
		status = classify(reentry_time, harvest_after, now)
		if status == NO_ENTRY:
			shown = re_bind
		elif status == HARVEST_HELD:
			shown = ha_bind
		else:
			shown = max(sprays, key=lambda s: max(filter(None, (s["reentry"], s["harvest"], s["ended_at"]))))
		cleared_at = None
		if status == CLEAR:
			cleared_at = max(filter(None, (reentry_time, harvest_after, shown["ended_at"])))
		out.append({
			"house": house,
			"house_label": house_label(house),
			"farm": wh_farm[house],
			"status": status,
			"reentry_time": reentry_time,
			"harvest_after": harvest_after,
			"work_order": shown["wo"],
			"ended_at": shown["ended_at"],
			"cleared_at": cleared_at,
			"products": [],
		})

	# Products in one query for the shown plans.
	shown_names = {r["work_order"] for r in out}
	if shown_names:
		items: dict[str, list] = {}
		for it in frappe.get_all(
			"Work Order Item",
			filters={"parent": ["in", list(shown_names)], "parenttype": "Work Order"},
			fields=["parent", "item_code", "item_name"],
			order_by="idx",
			limit_page_length=0,
		):
			items.setdefault(it.parent, []).append(it)
		for r in out:
			rows = items.get(r["work_order"], [])
			spray = [i for i in rows if CP.is_spray_product(i.item_code)]
			r["products"] = [i.item_name or i.item_code for i in (spray or rows)]
	out.sort(key=lambda r: (r["status"] != NO_ENTRY, r["status"] != HARVEST_HELD, r["farm"], r["house"]))
	return out


@frappe.whitelist()
def get_entry_status(farm=None, crop=None):
	"""Which houses may be entered or harvested right now.

	**Integration point for a production / harvest module**: read this instead of
	re-deriving intervals. Call it as the logged-in user (``/api/method/upande_scp.
	serverscripts.spray_plan_creator.reentry.get_entry_status``); it respects crop
	scoping and farm rosters, and refuses users without an SCP spray or production role.

	Returns one dict per house sprayed in the last 30 days::

	    {house, house_label, farm,
	     status: "no_entry" | "harvest_held" | "clear",
	     reentry_time,   # spray end + longest re-entry interval in the mix
	     harvest_after,  # spray end + longest pre-harvest interval; None if no PHI
	     work_order,     # the plan that is binding (the one that clears last)
	     ended_at,       # when that spray actually ended
	     cleared_at,     # when the house became clear; None unless status is "clear"
	     products}       # names in the tank mix

	A house that is not in the list has no spray inside the window and is clear.
	Times are site-local naive datetimes, as everywhere else in the app. When several
	sprays overlap, ``no_entry`` / ``harvest_held`` follow the one that ends last.
	"""
	_require_access()
	farm = (farm or "").strip() or None
	crop = (crop or "").strip() or None
	return build_status(farm=farm, crop=crop, farms=_visible_farms(crop))
