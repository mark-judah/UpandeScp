"""Asset Check Sheets filled by scouts in the Scout app.

The sheets, templates and schedules belong to ``upande_asset``, which SCP treats
as OPTIONAL: nothing here imports it, and every read first asks whether its
tables exist. Without it ``get_asset_check_config`` answers ``enabled: false``
and the settings endpoints report ``installed: false``; nothing raises.

* ``get_asset_check_config()`` — what the phone should offer today: every asset on
  the scout's farms whose asset category is switched on for that farm, each with
  every template of its category (the scout picks one) and whether it is due.
* ``submit_asset_check_sheet(payload)`` — turn one filled sheet into a submitted
  Asset Check Sheet. Idempotent on the phone's ``client_id``.
* ``get_asset_check_settings`` / ``save_asset_check_settings`` — the GM's switch
  and farm x asset-category rows (Scouting and Crop Protection Settings on this branch).

Who may call: Scout, General Manager, System Manager (with or without the
``SCP `` prefix, since sites spell roles differently). A scout sees the farms of
their Employee's company tree (``crop_scope.allowed_farms`` where this app has it,
the same walk done locally where it does not); the GM and System Manager see every
enabled farm.

Which farm an asset belongs to: where Asset has a ``farm`` column, that. Where it
does not (mona), the asset belongs to every farm of its company (Farm.company). If
Farm has no company link either, an asset belongs to every farm.

The sheet is built the way the app's own ``create_check_sheet_from_mobile`` does
(template labels and rows copied across, then ``validate`` computes thresholds and
``overall_status``) — those rules run unchanged on insert and submit. Scouts hold
no Maintenance role, hence ``ignore_permissions``; the owner stays the session user.
"""

from __future__ import annotations

import hashlib
import json
from contextlib import contextmanager

import frappe
from frappe import _
from frappe.utils import add_days, cint, flt, getdate, nowdate

try:  # not every branch of this app carries crop_scope
	from upande_scp.serverscripts.common import crop_scope
except ImportError:
	crop_scope = None

SETTINGS = "Scouting and Crop Protection Settings"
SHEET = "Asset Check Sheet"
TEMPLATE = "Asset Check Sheet Template"
SCHEDULE = "Asset Check Sheet Schedule"
CLIENT_ID_FIELD = "custom_scp_client_id"

SECTION_KEYS = ("a", "b", "c", "d", "e", "f")
# upande_asset's own table where it exposes one, so a sheet is never "due" on a
# different day here than in its scheduler; 90 for Quarterly if it does not.
FREQ_DAYS = {"Daily": 1, "Weekly": 7, "Monthly": 30, "Quarterly": 90, "Yearly": 365}
try:
	from upande_asset.upande_asset.doctype.asset_check_sheet_schedule.asset_check_sheet_schedule import (
		FREQ_DAYS as _ASSET_FREQ_DAYS,
	)

	FREQ_DAYS = {**FREQ_DAYS, **{k: int(v) for k, v in _ASSET_FREQ_DAYS.items()}}
except Exception:  # upande_asset absent or restructured
	pass
BACKDATE_DAYS = 3  # a sheet may be dated at most this many days before today
LOCK_TIMEOUT = 10  # seconds a retry waits for its twin to finish
FAULT_STATUSES = ("Fault / Defect", "Affected")
STATUSES = ("OK", "Fault / Defect", "Affected", "Needs Monitoring", "Not Applicable")
SEVERITIES = ("Low", "Medium", "High", "Critical")
INACTIVE_ASSET_STATUSES = ("Scrapped", "Sold")



class TemplateChanged(frappe.ValidationError):
	"""The template was edited after the phone downloaded it; the answers no longer line up."""


TEMPLATE_CHANGED = "TEMPLATE_CHANGED"

SCOUT_ROLES = {"Scout", "Scouting & Crop Protection User", "General Manager", "System Manager"}
MANAGER_ROLES = {"General Manager", "System Manager"}


# ── guards ───────────────────────────────────────────────────────────────


def installed() -> bool:
	"""True when upande_asset's check-sheet tables exist on this site."""
	return all(frappe.db.table_exists(dt) for dt in (SHEET, TEMPLATE, "Asset"))


def _bare(role: str) -> str:
	"""Role name without the ``SCP `` namespace prefix, lower-cased."""
	r = (role or "").strip().lower()
	return r[4:] if r.startswith("scp ") else r


def _roles(user=None) -> set:
	"""The user's roles, bare and lower-cased, so either spelling matches."""
	user = user or frappe.session.user
	roles = {_bare(r) for r in frappe.get_roles(user)}
	if user == "Administrator":
		roles.add("system manager")
	return roles


def _require(allowed: set):
	if not (_roles() & {_bare(r) for r in allowed}):
		frappe.throw(_("You do not have access to asset checks."), frappe.PermissionError)


def _sees_all(user=None) -> bool:
	return bool(_roles(user) & {_bare(r) for r in MANAGER_ROLES})


def _farm_has_company() -> bool:
	# a column check, not get_meta: some sites carry the Farm table without its DocType
	return frappe.db.has_column("Farm", "company")


def _farms(company=None, companies=None) -> list:
	"""Farm names, optionally of one company / a list of companies. Plain SQL for the
	same reason as ``_farm_has_company``."""
	if companies is not None:
		if not companies:
			return []
		return frappe.db.sql_list(
			"select name from `tabFarm` where company in %(c)s order by name", {"c": tuple(companies)}
		)
	if company is not None:
		return frappe.db.sql_list("select name from `tabFarm` where company = %s order by name", company)
	return frappe.db.sql_list("select name from `tabFarm` order by name")


def _asset_has_farm() -> bool:
	return bool(frappe.get_meta("Asset").has_field("farm"))


def _company_tree_farms(user) -> set:
	"""Farms of the user's Employee company and its descendants (no crop_scope here)."""
	company = frappe.db.get_value("Employee", {"user_id": user, "status": "Active"}, "company")
	if not company:
		return set()
	bounds = frappe.db.get_value("Company", company, ["lft", "rgt"], as_dict=True)
	if bounds and bounds.lft is not None:
		companies = frappe.get_all(
			"Company", filters={"lft": [">=", bounds.lft], "rgt": ["<=", bounds.rgt]}, pluck="name"
		)
	else:
		companies = [company]
	return set(_farms(companies=companies))


def _scope_farms(user=None):
	"""The farms this user may check: ``None`` = all (GM / System Manager)."""
	if _sees_all(user):
		return None
	user = user or frappe.session.user
	if crop_scope is not None:
		return crop_scope.allowed_farms(user) or set()
	if not _farm_has_company():
		return None  # no company link to scope by: every farm
	return _company_tree_farms(user)


def _farms_of_asset(asset) -> list:
	"""Farms an asset (dict with farm/company) belongs to — see the module docstring."""
	if _asset_has_farm():
		return [asset.get("farm")] if asset.get("farm") else []
	if _farm_has_company():
		return _farms(company=asset.get("company"))
	return _farms()


def _asset_filters_for_farm(farm) -> dict | None:
	"""Asset filters that select the assets of ``farm``; None when none can belong."""
	if _asset_has_farm():
		return {"farm": farm}
	if _farm_has_company():
		company = frappe.db.sql("select company from `tabFarm` where name = %s", farm)
		company = company[0][0] if company else None
		return {"company": company} if company else None
	return {}


def _has_client_id_column() -> bool:
	return frappe.db.has_column(SHEET, CLIENT_ID_FIELD)


# ── settings ─────────────────────────────────────────────────────────────


def _setting_rows() -> list[dict]:
	doc = frappe.get_single(SETTINGS)
	return [
		{
			"farm": r.farm,
			"asset_category": r.asset_category,
			"enabled": cint(r.enabled),
		}
		for r in (doc.get("asset_check_farms") or [])
	]


def _feature_on() -> bool:
	# get_single reads the DB; get_single_value would serve a cached value
	return bool(cint(frappe.get_single(SETTINGS).asset_checks_enabled))


@frappe.whitelist()
def get_asset_check_settings() -> dict:
	"""The GM's switch, rows, and what the pickers may offer."""
	_require(MANAGER_ROLES)
	out = {
		"installed": installed(),
		"enabled": int(_feature_on()),
		"rows": _setting_rows(),
		"farms": [],
		"categories": [],
	}
	out["farms"] = _farms()
	if out["installed"]:
		# only categories that have at least one template are worth switching on
		out["categories"] = sorted(
			set(frappe.get_all(TEMPLATE, pluck="asset_category", limit_page_length=0))
		)
	return out


@frappe.whitelist()
def save_asset_check_settings(payload) -> dict:
	"""Save ``{"enabled": 0|1, "rows": [{farm, asset_category, enabled}]}``."""
	_require(MANAGER_ROLES)
	if isinstance(payload, str):
		payload = frappe.parse_json(payload)
	payload = payload or {}
	if not installed():
		frappe.throw(_("The Upande Asset app is not installed on this site."))

	rows, seen = [], set()
	farms = set(_farms())
	for r in payload.get("rows") or []:
		farm = (r.get("farm") or "").strip()
		cat = (r.get("asset_category") or "").strip()
		if not farm and not cat:
			continue
		if not farm or not cat:
			frappe.throw(_("Every row needs both a farm and an asset category."))
		if farm not in farms:
			frappe.throw(_("Farm {0} does not exist.").format(farm))
		if not frappe.db.exists("Asset Category", cat):
			frappe.throw(_("Asset Category {0} does not exist.").format(cat))
		if (farm, cat) in seen:
			frappe.throw(_("{0} + {1} is listed twice.").format(farm, cat))
		seen.add((farm, cat))
		rows.append({"farm": farm, "asset_category": cat, "enabled": 1 if cint(r.get("enabled", 1)) else 0})

	doc = frappe.get_single(SETTINGS)
	if "enabled" in payload:
		doc.asset_checks_enabled = 1 if cint(payload["enabled"]) else 0
	doc.set("asset_check_farms", [])
	for r in rows:
		doc.append("asset_check_farms", r)
	# the other links on this Single (e.g. allowed farms) are not ours to validate, and
	# on a site carrying the Farm table without its DocType they would block the save;
	# farm and category are checked above.
	doc.flags.ignore_links = True
	doc.save(ignore_permissions=True)
	return get_asset_check_settings()


# ── config ───────────────────────────────────────────────────────────────


def _interval_days(tmpl) -> int:
	if tmpl.frequency == "Custom":
		return cint(tmpl.custom_frequency_days)
	return FREQ_DAYS.get(tmpl.frequency, 0)


def _sections(tmpl) -> list[dict]:
	out = []
	for key in SECTION_KEYS:
		items = [
			{
				"idx": cint(r.idx),
				"check_factor": r.check_factor,
				"threshold_percent": flt(r.threshold_percent) if r.threshold_percent is not None else None,
				"notes": r.notes or None,
			}
			for r in (tmpl.get(f"section_{key}_items") or [])
		]
		if items:
			out.append({"key": key, "label": tmpl.get(f"section_{key}_name") or f"Section {key.upper()}", "items": items})
	return out


def _fingerprint(tmpl, secs=None) -> str:
	"""A hash of everything an answer's meaning depends on: the ordered
	(section, idx, check_factor, threshold) rows and the two require flags. The
	phone sends back the one it filled against; any edit to the template changes it."""
	secs = secs if secs is not None else _sections(tmpl)
	rows = [[s["key"], i["idx"], i["check_factor"], i["threshold_percent"]] for s in secs for i in s["items"]]
	raw = json.dumps(
		[rows, cint(tmpl.require_incident_percent), cint(tmpl.require_proposed_action)],
		separators=(",", ":"),
		default=str,
	)
	return hashlib.sha1(raw.encode()).hexdigest()[:16]


def _home_farms(user=None) -> set:
	"""Farms of the user's own Employee company: the label a scout expects to see."""
	user = user or frappe.session.user
	company = frappe.db.get_value("Employee", {"user_id": user, "status": "Active"}, "company")
	if not company or not _farm_has_company():
		return set()
	return set(_farms(company=company))


def _enabled_categories(scope) -> dict:
	"""{farm: [asset_category, ...]} from enabled rows, narrowed to ``scope``."""
	out: dict = {}
	for r in _setting_rows():
		if not r["enabled"] or not r["farm"] or not r["asset_category"]:
			continue
		if scope is not None and r["farm"] not in scope:
			continue
		if r["asset_category"] not in out.setdefault(r["farm"], []):
			out[r["farm"]].append(r["asset_category"])
	return out


def _templates_of(category) -> list:
	"""Every template of a category with at least one section item, default first."""
	names = frappe.get_all(
		TEMPLATE,
		filters={"asset_category": category},
		order_by="is_default desc, template_name asc",
		pluck="name",
		limit_page_length=0,
	)
	out = []
	for n in names:
		t = frappe.get_cached_doc(TEMPLATE, n)
		secs = _sections(t)
		if secs:
			out.append((t, secs))
	return out


def _last_checks(assets, template, on_date=None) -> tuple[dict, set]:
	"""(asset -> last submitted check_date, assets with a non-cancelled sheet dated
	``on_date`` — today unless given)."""
	if not assets:
		return {}, set()
	last: dict = {}
	for r in frappe.get_all(
		SHEET,
		filters={"asset": ["in", assets], "check_sheet_template": template, "docstatus": 1},
		fields=["asset", "check_date"],
		order_by="check_date asc",
		limit_page_length=0,
	):
		last[r.asset] = r.check_date  # ascending, so the newest wins
	today = set(
		frappe.get_all(
			SHEET,
			filters={
				"asset": ["in", assets],
				"check_sheet_template": template,
				"check_date": str(on_date or nowdate()),
				"docstatus": ["!=", 2],
			},
			pluck="asset",
			limit_page_length=0,
		)
	)
	return last, today


def _schedules(assets, template) -> dict:
	if not assets or not frappe.db.table_exists(SCHEDULE):
		return {}
	return {
		r.asset: r
		for r in frappe.get_all(
			SCHEDULE,
			filters={"asset": ["in", assets], "check_sheet_template": template, "enabled": 1},
			fields=["asset", "next_due_date", "last_check_date"],
			limit_page_length=0,
		)
	}


def _under_repair(assets) -> set:
	if not assets or not frappe.db.table_exists("Asset Repair"):
		return set()
	return set(
		frappe.get_all(
			"Asset Repair",
			filters={"asset": ["in", assets], "repair_status": ["in", ["Pending", "In Progress"]]},
			pluck="asset",
			limit_page_length=0,
		)
	)


def _due(asset, schedules, last, today_done, interval, today) -> tuple[bool, str | None, str | None]:
	"""(due, next_due_date, last_check_date) for one asset under one template."""
	last_date = last.get(asset)
	sch = schedules.get(asset)
	if sch:
		# the schedule's date can lag a sheet filed from the phone: never earlier
		# than the newest submitted sheet plus the interval
		cands = []
		if sch.next_due_date:
			cands.append(getdate(sch.next_due_date))
		if last_date is not None and interval:
			cands.append(add_days(getdate(last_date), interval))
		nxt = max(cands) if cands else None
		due = nxt is None or nxt <= today
		last_out = sch.last_check_date or last_date
		if last_date is not None and (last_out is None or getdate(last_date) > getdate(last_out)):
			last_out = last_date
	else:
		last_out = last_date
		if last_date is None:
			nxt, due = None, True
		else:
			nxt = add_days(getdate(last_date), interval)
			due = nxt <= today
	if asset in today_done:
		due = False
	return due, (str(nxt) if nxt else None), (str(last_out) if last_out else None)


@frappe.whitelist()
def get_asset_check_config() -> dict:
	"""What the Scout app should offer today. ``enabled`` false = show nothing.

	``assets``: one entry per asset on an enabled farm + category, carrying every
	template of that category (the scout picks which sheet to fill), each with its
	own ``due`` flag; ``any_due`` is true when at least one of them is due.
	"""
	_require(SCOUT_ROLES)
	today = nowdate()
	off = {"enabled": False, "today": today, "assets": []}
	if not installed() or not _feature_on():
		return off

	today_d = getdate(today)
	cats = _enabled_categories(_scope_farms())
	templates_by_cat: dict = {}
	seen_assets: dict = {}
	home = _home_farms()
	# the scout's own farm first, so an asset on two farms carries the label they know
	for farm in sorted(cats, key=lambda f: (f not in home, f)):
		scope_filters = _asset_filters_for_farm(farm)
		if scope_filters is None:
			continue
		for cat in cats[farm]:
			if cat not in templates_by_cat:
				templates_by_cat[cat] = _templates_of(cat)
			if not templates_by_cat[cat]:
				continue
			assets = frappe.get_all(
				"Asset",
				filters={
					**scope_filters,
					"docstatus": 1,
					"asset_category": cat,
					"status": ["not in", list(INACTIVE_ASSET_STATUSES)],
				},
				fields=["name", "asset_name", "asset_category", "company"],
				order_by="asset_name, name",
				limit_page_length=0,
			)
			names = [a.name for a in assets]
			repairing = _under_repair(names)
			per_tmpl = {}
			for tmpl, _secs in templates_by_cat[cat]:
				last, done = _last_checks(names, tmpl.name)
				per_tmpl[tmpl.name] = (last, done, _schedules(names, tmpl.name), _interval_days(tmpl))
			for a in assets:
				if a.name in seen_assets:  # an asset on two farms of one company: list it once
					continue
				entries = []
				for tmpl, secs in templates_by_cat[cat]:
					last, done, sched, interval = per_tmpl[tmpl.name]
					due, nxt, last_date = _due(a.name, sched, last, done, interval, today_d)
					if a.name in repairing:
						due = False  # the app refuses a new sheet while a repair is open
					entries.append(
						{
							"template": tmpl.name,
							"template_name": tmpl.template_name or tmpl.name,
							"frequency": tmpl.frequency,
							"is_default": bool(cint(tmpl.is_default)),
							"due": bool(due),
							"next_due_date": nxt,
							"last_check_date": last_date,
							"require_incident_percent": bool(cint(tmpl.require_incident_percent)),
							"require_proposed_action": bool(cint(tmpl.require_proposed_action)),
							"fingerprint": _fingerprint(tmpl, secs),
							"sections": secs,
						}
					)
				seen_assets[a.name] = {
					"asset": a.name,
					"asset_name": a.asset_name or a.name,
					"asset_category": a.asset_category,
					"company": a.company,
					"farm": farm,
					"any_due": any(e["due"] for e in entries),
					"templates": entries,
				}
	return {"enabled": True, "today": today, "assets": list(seen_assets.values())}


# ── submit ───────────────────────────────────────────────────────────────


def _existing_by_client_id(client_id):
	if not client_id or not _has_client_id_column():
		return None
	# a locking read: it sees what a twin request committed after this one began
	return frappe.db.get_value(
		SHEET,
		{CLIENT_ID_FIELD: client_id, "docstatus": ["!=", 2]},
		["name", "docstatus", "overall_status"],
		as_dict=True,
		for_update=True,
	)


def _existing_sheet(asset, template, check_date):
	"""The submitted sheet this user already filed for asset + template + date.

	What makes a retry idempotent where the client-id column is absent (upande_asset
	installed after SCP, or the field not yet created), and what resolves upande_asset's
	one-sheet-a-day refusal when two attempts race."""
	return frappe.db.get_value(
		SHEET,
		{
			"asset": asset,
			"check_sheet_template": template,
			"check_date": str(check_date),
			"owner": frappe.session.user,
			"docstatus": 1,
		},
		["name", "docstatus", "overall_status"],
		as_dict=True,
		for_update=True,
	)


# ── single-flight lock ───────────────────────────────────────────────────


def _lock_key(payload) -> str:
	base = (payload.get("client_id") or "").strip() or "|".join(
		str(payload.get(k) or "") for k in ("asset", "template", "check_date")
	)
	return "scp_ac:" + hashlib.md5(f"{frappe.local.site}|{base}".encode()).hexdigest()


def _get_lock(key, timeout) -> bool:
	"""MariaDB advisory lock: held by this connection, survives a rollback, and is
	released if the worker dies."""
	return bool(cint(frappe.db.sql("select get_lock(%s, %s)", (key, timeout))[0][0]))


def _release_lock(key):
	frappe.db.sql("select release_lock(%s)", (key,))


@contextmanager
def _client_lock(key, timeout=None):
	"""Yield True when this request holds the lock, False when it timed out waiting."""
	got = _get_lock(key, LOCK_TIMEOUT if timeout is None else timeout)
	try:
		yield got
	finally:
		if got:
			_release_lock(key)


def _result(row, duplicate: bool) -> dict:
	return {
		"name": row["name"],
		"docstatus": cint(row["docstatus"]),
		"overall_status": row["overall_status"],
		"duplicate": duplicate,
	}


def _answers(payload) -> dict:
	"""{(section_key, idx): answer} from the payload, refusing a malformed one."""
	out = {}
	secs = payload.get("sections") or {}
	if not isinstance(secs, dict):
		frappe.throw(_("sections must be an object keyed by section letter."))
	for key, rows in secs.items():
		key = str(key).lower()
		if key not in SECTION_KEYS:
			frappe.throw(_("Unknown section {0}.").format(key))
		for r in rows or []:
			out[(key, cint(r.get("idx")))] = r
	return out


def _blank(v):
	return v is None or (isinstance(v, str) and not v.strip())


def _check_row(tmpl, key, row, ans, label):
	"""Validate one answered row against the template's rules; return the item dict."""
	where = _("{0}, row {1} ({2})").format(label, row.idx, row.check_factor)
	if ans is None or _blank(ans.get("status")):
		frappe.throw(_("{0}: a status is required.").format(where))
	status = ans["status"]
	if status not in STATUSES:
		frappe.throw(_("{0}: {1} is not a valid status.").format(where, status))
	item = {
		"check_factor": row.check_factor,
		"threshold_percent": row.threshold_percent or None,
		"status": status,
		"severity": "",
		"fault_description": "",
		"incident_percent": None,
		"proposed_action": "",
	}
	if status in FAULT_STATUSES:
		sev = ans.get("severity")
		if _blank(sev):
			frappe.throw(_("{0}: severity is required when the status is {1}.").format(where, status))
		if sev not in SEVERITIES:
			frappe.throw(_("{0}: {1} is not a valid severity.").format(where, sev))
		if _blank(ans.get("fault_description")):
			frappe.throw(_("{0}: describe the fault when the status is {1}.").format(where, status))
		if cint(tmpl.require_incident_percent) and ans.get("incident_percent") in (None, ""):
			frappe.throw(_("{0}: incident % is required for this check sheet.").format(where))
		if cint(tmpl.require_proposed_action) and _blank(ans.get("proposed_action")):
			frappe.throw(_("{0}: a proposed action is required for this check sheet.").format(where))
		item["severity"] = sev
		item["fault_description"] = (ans.get("fault_description") or "").strip()
		if ans.get("incident_percent") not in (None, ""):
			item["incident_percent"] = flt(ans["incident_percent"])
		item["proposed_action"] = (ans.get("proposed_action") or "").strip()
	return item


def _assert_template_unchanged(tmpl, secs, payload, answers):
	"""Refuse answers that were given against a different version of the template.

	Rows are matched by (section, idx), which alone would silently slide answers onto
	the wrong checks once an item is inserted or removed — so each row must also carry
	the check_factor it was answered for, and the phone's template fingerprint must
	still match."""
	changed = _(
		"{0}: this checklist was updated after you opened it. Refresh and review your answers."
	).format(TEMPLATE_CHANGED)
	fp = (payload.get("template_fingerprint") or "").strip()
	if fp and fp != _fingerprint(tmpl, secs):
		frappe.throw(changed, TemplateChanged)
	live = {(s["key"], i["idx"]): i["check_factor"] for s in secs for i in s["items"]}
	if set(answers) - set(live):
		frappe.throw(changed, TemplateChanged)
	for k, factor in live.items():
		a = answers.get(k)
		if a is not None and (a.get("check_factor") or "") != (factor or ""):
			frappe.throw(changed, TemplateChanged)


@frappe.whitelist()
def submit_asset_check_sheet(payload) -> dict:
	"""Create and submit one Asset Check Sheet from the phone's answers.

	Idempotent on ``client_id`` (or, without the column, on asset + template + date +
	owner) and single-flight: concurrent retries serialise on a lock and the loser
	gets the winner's sheet back with ``duplicate: true``. A template edited since the
	phone downloaded it is refused with ``TEMPLATE_CHANGED`` (a ``TemplateChanged``,
	HTTP 417) so the app can refresh and re-map instead of filing misaligned answers."""
	_require(SCOUT_ROLES)
	if isinstance(payload, str):
		payload = frappe.parse_json(payload)
	payload = payload or {}

	with _client_lock(_lock_key(payload)) as got:
		if not got:
			# the twin is still working: hand back its sheet if it is already there
			twin = _existing_by_client_id((payload.get("client_id") or "").strip())
			if twin:
				return _result(twin, True)
			frappe.throw(_("This sheet is already being submitted. Try again shortly."), frappe.ServiceUnavailableError)
		return _submit_locked(payload)


def _submit_locked(payload) -> dict:
	client_id = (payload.get("client_id") or "").strip()
	dup = _existing_by_client_id(client_id)
	if dup:
		return _result(dup, True)

	if not installed() or not _feature_on():
		frappe.throw(_("Asset checks are not switched on."))

	asset, tname = payload.get("asset"), payload.get("template")
	if not asset or not tname:
		frappe.throw(_("asset and template are required."))
	if not frappe.db.exists(TEMPLATE, tname):
		frappe.throw(_("Asset Check Sheet Template {0} does not exist.").format(tname))
	if not frappe.db.exists("Asset", asset):
		frappe.throw(_("Asset {0} does not exist.").format(asset))

	a = frappe.db.get_value(
		"Asset",
		asset,
		["asset_category", "company", "docstatus", "status"] + (["farm"] if _asset_has_farm() else []),
		as_dict=True,
	)
	tmpl = frappe.get_doc(TEMPLATE, tname)  # fresh: never a cached copy of an edited template
	if a.docstatus != 1 or a.status in INACTIVE_ASSET_STATUSES:
		frappe.throw(_("Asset {0} is not in service.").format(asset))
	if tmpl.asset_category != a.asset_category:
		frappe.throw(_("Template {0} is not for {1} assets.").format(tname, a.asset_category))
	scope = _scope_farms()
	candidates = _farms_of_asset(a)
	if payload.get("farm"):
		candidates = [f for f in candidates if f == payload["farm"]]
	in_scope = [f for f in candidates if scope is None or f in scope]
	if not in_scope:
		frappe.throw(_("You cannot check assets of this farm."), frappe.PermissionError)
	enabled = _enabled_categories(None)
	if not any(a.asset_category in enabled.get(f, []) for f in in_scope):
		frappe.throw(
			_("Asset checks for {0} are not switched on for farm {1}.").format(a.asset_category, ", ".join(in_scope))
		)

	today = getdate(nowdate())
	check_date = getdate(payload.get("check_date") or nowdate())
	if check_date > add_days(today, 1):
		frappe.throw(_("Check date cannot be in the future."))
	if check_date > today:
		# one day of leeway for a phone ahead of the server's time zone: stored as today
		check_date = today
	if check_date < add_days(today, -BACKDATE_DAYS):
		frappe.throw(_("Check date cannot be more than {0} days ago.").format(BACKDATE_DAYS))

	if not _has_client_id_column():
		# no column to find a retry by: the same scout's sheet for this day is the retry
		again = _existing_sheet(asset, tname, check_date)
		if again:
			return _result(again, True)

	secs = _sections(tmpl)
	answers = _answers(payload)
	_assert_template_unchanged(tmpl, secs, payload, answers)

	# Due, server-side, by the same rule the config used — but for the sheet's own
	# date, so a backdated sheet is judged on that day, not on today.
	last, done = _last_checks([asset], tname, check_date)
	due, nxt, _last = _due(asset, _schedules([asset], tname), last, done, _interval_days(tmpl), check_date)
	if asset in _under_repair([asset]):
		frappe.throw(_("Asset {0} has an open repair; it cannot be checked until that is done.").format(asset))
	if not due:
		if asset in done:
			frappe.throw(_("{0} was already checked on {1} with this template.").format(asset, check_date))
		frappe.throw(_("This check is not due yet (next due {0}).").format(nxt or _("later")))

	cs = frappe.new_doc(SHEET)
	cs.asset = asset
	cs.asset_category = a.asset_category
	cs.check_sheet_template = tname
	cs.check_date = check_date
	cs.company = a.company
	cs.additional_notes = payload.get("additional_notes") or ""
	for key in SECTION_KEYS:
		label = tmpl.get(f"section_{key}_name") or ""
		cs.set(f"section_{key}_label", label)
		for row in tmpl.get(f"section_{key}_items") or []:
			cs.append(
				f"section_{key}_items",
				_check_row(tmpl, key, row, answers.get((key, cint(row.idx))), label or f"Section {key.upper()}"),
			)
	if client_id and _has_client_id_column():
		cs.set(CLIENT_ID_FIELD, client_id)

	cs.flags.ignore_permissions = True
	try:
		cs.insert(ignore_permissions=True)
		cs.submit()
	except Exception as e:
		# a retry racing its own first attempt: the app's one-sheet-a-day rule fires
		frappe.db.rollback()
		again = _existing_by_client_id(client_id)
		if not again and "already exists" in str(e):
			again = _existing_sheet(asset, tname, check_date)
		if again:
			return _result(again, True)
		raise
	return {
		"name": cs.name,
		"docstatus": cint(cs.docstatus),
		"overall_status": cs.overall_status,
		"duplicate": False,
	}
