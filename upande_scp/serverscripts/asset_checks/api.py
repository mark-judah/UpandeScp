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
  and farm x asset-category rows (Scouting and Crop Protection Settings).

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
FREQ_DAYS = {"Daily": 1, "Weekly": 7, "Monthly": 30, "Quarterly": 91, "Yearly": 365}
FAULT_STATUSES = ("Fault / Defect", "Affected")
STATUSES = ("OK", "Fault / Defect", "Affected", "Needs Monitoring", "Not Applicable")
SEVERITIES = ("Low", "Medium", "High", "Critical")
INACTIVE_ASSET_STATUSES = ("Scrapped", "Sold")

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


def _last_checks(assets, template) -> tuple[dict, set]:
	"""(asset -> last submitted check_date, assets with a non-cancelled sheet dated today)."""
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
				"check_date": nowdate(),
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
		nxt = getdate(sch.next_due_date) if sch.next_due_date else None
		due = nxt is None or nxt <= today
		last_out = sch.last_check_date or last_date
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
	for farm in sorted(cats):
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
	return frappe.db.get_value(
		SHEET,
		{CLIENT_ID_FIELD: client_id, "docstatus": ["!=", 2]},
		["name", "docstatus", "overall_status"],
		as_dict=True,
	)


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


@frappe.whitelist()
def submit_asset_check_sheet(payload) -> dict:
	"""Create and submit one Asset Check Sheet from the phone's answers."""
	_require(SCOUT_ROLES)
	if isinstance(payload, str):
		payload = frappe.parse_json(payload)
	payload = payload or {}

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
	tmpl = frappe.get_cached_doc(TEMPLATE, tname)
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

	check_date = getdate(payload.get("check_date") or nowdate())
	if check_date > getdate(nowdate()):
		frappe.throw(_("Check date cannot be in the future."))

	# Due, server-side, by the same rule the config used (today's date, not the backdate).
	last, done = _last_checks([asset], tname)
	due, nxt, _last = _due(
		asset, _schedules([asset], tname), last, done, _interval_days(tmpl), getdate(nowdate())
	)
	if asset in _under_repair([asset]):
		frappe.throw(_("Asset {0} has an open repair; it cannot be checked until that is done.").format(asset))
	if not due:
		if asset in done:
			frappe.throw(_("{0} was already checked today with this template.").format(asset))
		frappe.throw(_("This check is not due yet (next due {0}).").format(nxt or _("later")))

	answers = _answers(payload)
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
	except Exception:
		# a retry racing its own first attempt: the app's one-sheet-a-day rule fires
		frappe.db.rollback()
		again = _existing_by_client_id(client_id)
		if again:
			return _result(again, True)
		raise
	return {
		"name": cs.name,
		"docstatus": cint(cs.docstatus),
		"overall_status": cs.overall_status,
		"duplicate": False,
	}
