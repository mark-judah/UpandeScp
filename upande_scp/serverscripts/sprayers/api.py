"""Personnel ▸ Teams and Sprayers pages: spray teams of the user's farms, and the sprayer register.

Who may do what (spec S9):

* **SCP General Manager / System Manager** act on every farm they can see
  (`crop_scope.visible_farms` with no roster — company scope, ∩ crop). They
  also see teams with no farm yet, so they can give them one.
* **SCP Spray Supervisor** acts only on the farms they are rostered on
  (`Farm.spray_supervisors`), and an **SCP Spray Plan Creator** only on the
  farms of the `Farm.spray_plan_creators` roster (personnel spec P3). Holding
  both roles unions the two rosters.

Reads are limited to the same farms. Anyone else is refused.
"""

from __future__ import annotations

import json

import frappe

from upande_scp.serverscripts.common import crop_catalog, crop_scope
from upande_scp.serverscripts.common import exposure_rules as R
from upande_scp.serverscripts.sprayers import register

MANAGER_ROLES = ("SCP General Manager", "System Manager")
SUPERVISOR_ROLE = "SCP Spray Supervisor"
CREATOR_ROLE = "SCP Spray Plan Creator"
#: Rostered (non-manager) roles and the Farm roster each one is scoped by.
ROSTERED_ROLES = {SUPERVISOR_ROLE: "spray_supervisors", CREATOR_ROLE: "spray_plan_creators"}
TEAM_ROLES = ("Supervisor", "Sprayer", "Pump Operator")


def _crop(crop, user=None):
	"""Canonical crop, refused when unknown or not the user's (like finances)."""
	return crop_catalog.resolve_crop(crop, user) if crop else None


def scope(crop=None, user=None) -> dict:
	"""{"manager": bool, "farms": set | None}. Refuses anyone without a role."""
	user = user or frappe.session.user
	roles = set(frappe.get_roles(user))
	crop = _crop(crop, user)
	if user == "Administrator" or roles & set(MANAGER_ROLES):
		return {"manager": True, "farms": crop_scope.visible_farms(None, crop, user)}
	rosters = tuple(field for role, field in ROSTERED_ROLES.items() if role in roles)
	if rosters:
		return {"manager": False, "farms": crop_scope.visible_farms(rosters, crop, user)}
	frappe.throw("You do not have access to spray teams.", frappe.PermissionError)


def _farm_ok(sc, farm) -> bool:
	if not farm:
		# A team or sprayer with no farm yet belongs to no supervisor.
		return sc["manager"]
	return sc["farms"] is None or farm in sc["farms"]


def _assert_farm(sc, farm):
	if not _farm_ok(sc, farm):
		frappe.throw(f"You cannot manage farm {farm or '(none)'}.", frappe.PermissionError)


@frappe.whitelist()
def get_context(crop=None):
	sc = scope(crop)
	farms = sc["farms"]
	if farms is None:
		farms = set(frappe.get_all("Farm", pluck="name"))
	return {"manager": sc["manager"], "farms": sorted(farms)}


def _members(team_names):
	if not team_names:
		return {}
	rows = frappe.db.sql(
		"""SELECT d.parent AS team, d.name1 AS employee, d.role,
		          COALESCE(e.employee_name, d.name1) AS employee_name,
		          e.designation, e.status, s.name AS sprayer
		     FROM `tabSpray Team Details` d
		     LEFT JOIN `tabEmployee` e ON e.name = d.name1
		     LEFT JOIN `tabSprayer` s ON s.employee = d.name1
		    WHERE d.parenttype = 'Spray Team' AND d.parent IN %(teams)s
		    ORDER BY d.parent, d.idx""",
		{"teams": tuple(team_names)},
		as_dict=True,
	)
	out: dict = {}
	for r in rows:
		out.setdefault(r.pop("team"), []).append(r)
	return out


@frappe.whitelist()
def get_spray_teams(crop=None):
	sc = scope(crop)
	teams = [
		t for t in frappe.get_all(
			"Spray Team", fields=["name", "team_name", "enabled", "custom_farm as farm"], order_by="name"
		)
		if _farm_ok(sc, t.farm)
	]
	members = _members([t.name for t in teams])
	for t in teams:
		t["members"] = members.get(t.name, [])
	return teams


def _farm_company(farm):
	return frappe.db.get_value("Farm", farm, "company") if farm else None


@frappe.whitelist()
def search_employees(farm=None, txt="", crop=None):
	"""Active Employees of the farm's company, for adding to a team."""
	sc = scope(crop)
	_assert_farm(sc, farm)
	filters = {"status": "Active"}
	company = _farm_company(farm)
	if not company:
		# No company → no safe pool to add from; set the team's farm first.
		return []
	filters["company"] = company
	txt = (txt or "").strip()
	or_filters = None
	if txt:
		like = f"%{txt}%"
		or_filters = {"name": ["like", like], "employee_name": ["like", like]}
	return frappe.get_all(
		"Employee",
		filters=filters,
		or_filters=or_filters,
		fields=["name as employee", "employee_name", "designation", "company"],
		order_by="employee_name",
		limit_page_length=20,
	)


@frappe.whitelist(methods=["POST"])
def save_spray_team(team, members=None, farm=None, enabled=None, crop=None):
	"""Replace a team's members, and optionally its farm and enabled flag.

	``members`` is [{employee, role}]. The Spray Team on_update hook re-syncs
	everyone added and removed into the sprayer register.
	"""
	sc = scope(crop)
	doc = frappe.get_doc("Spray Team", team)
	_assert_farm(sc, doc.get("custom_farm"))

	new_farm = doc.get("custom_farm") if farm is None else (farm or None)
	if new_farm != doc.get("custom_farm"):
		_assert_farm(sc, new_farm)
		if not new_farm and not sc["manager"]:
			frappe.throw("Only a manager can unassign a team's farm.", frappe.PermissionError)
		doc.custom_farm = new_farm

	if enabled is not None:
		doc.enabled = 1 if str(enabled).lower() in ("1", "true") else 0

	if members is not None:
		if isinstance(members, str):
			members = json.loads(members)
		company = _farm_company(new_farm)
		rows, seen = [], set()
		for m in members or []:
			emp = (m.get("employee") or "").strip()
			role = m.get("role") or "Sprayer"
			if not emp or emp in seen:
				continue
			if role not in TEAM_ROLES:
				frappe.throw(f"Unknown team role: {role}")
			info = frappe.db.get_value("Employee", emp, ["status", "company"], as_dict=True)
			if not info:
				frappe.throw(f"Employee {emp} does not exist.")
			existing = any(r.name1 == emp for r in doc.get("team") or [])
			if not existing:
				if info.status != "Active":
					frappe.throw(f"Employee {emp} is not active.")
				if not company:
					frappe.throw("Set the team's farm (with a company) before adding members.")
				if info.company != company:
					frappe.throw(f"Employee {emp} is not in {company}.")
			seen.add(emp)
			rows.append({"name1": emp, "role": role})
		doc.set("team", rows)

	doc.save(ignore_permissions=True)
	return get_spray_teams_one(doc.name)


def get_spray_teams_one(name):
	t = frappe.db.get_value(
		"Spray Team", name, ["name", "team_name", "enabled", "custom_farm as farm"], as_dict=True
	)
	t["members"] = _members([name]).get(name, [])
	return t


def _sprayer_condition(sc):
	"""SQL WHERE for the Sprayers this scope may read (alias `s`)."""
	farms = sc["farms"]
	if farms is None:
		return "1=1", {}
	parts, params = [], {}
	if farms:
		parts.append("s.farm IN %(farms)s")
		params["farms"] = tuple(sorted(farms))
	if sc["manager"]:
		# A sprayer with no farm yet is placed by their Employee's company.
		companies = crop_scope.allowed_companies()
		if companies is None:
			parts.append("IFNULL(s.farm, '') = ''")
		elif companies:
			parts.append("(IFNULL(s.farm, '') = '' AND e.company IN %(companies)s)")
			params["companies"] = tuple(sorted(companies))
	return ("(" + " OR ".join(parts) + ")") if parts else "1=0", params


@frappe.whitelist()
def get_sprayers(crop=None):
	sc = scope(crop)
	cond, params = _sprayer_condition(sc)
	rows = frappe.db.sql(
		f"""SELECT s.name, s.employee, s.employee_name, s.farm, s.spray_team, s.role,
		           s.status, s.hours_30d, s.weighted_30d, s.hours_total,
		           s.weighted_total, s.last_exposure, e.designation, e.image
		      FROM `tabSprayer` s
		      LEFT JOIN `tabEmployee` e ON e.name = s.employee
		     WHERE {cond}
		     ORDER BY s.weighted_30d DESC, s.weighted_total DESC, s.employee_name""",
		params,
		as_dict=True,
	)
	names = [r.name for r in rows]
	flags = {"no_duration": 0, "hazard_unknown": 0, "rows": 0, "products_unclassified": 0}
	if names:
		f = frappe.db.sql(
			"""SELECT COUNT(*) AS n,
			          SUM(flags LIKE %(nd)s) AS nd,
			          SUM(flags LIKE %(hu)s) AS hu,
			          COUNT(DISTINCT CASE WHEN flags LIKE %(hu)s
			                THEN COALESCE(spray_product, product_name) END) AS pu
			     FROM `tabSprayer Exposure` WHERE sprayer IN %(s)s""",
			{"s": tuple(names), "nd": f"%{R.FLAG_NO_DURATION}%", "hu": f"%{R.FLAG_HAZARD_UNKNOWN}%"},
			as_dict=True,
		)[0]
		flags = {
			"rows": int(f.n or 0),
			"no_duration": int(f.nd or 0),
			"hazard_unknown": int(f.hu or 0),
			"products_unclassified": int(f.pu or 0),
		}
	return {"sprayers": rows, "flags": flags}


@frappe.whitelist()
def get_sprayer_detail(sprayer, crop=None):
	sc = scope(crop)
	cond, params = _sprayer_condition(sc)
	params["name"] = sprayer
	row = frappe.db.sql(
		f"""SELECT s.name, s.employee, s.employee_name, s.farm, s.spray_team, s.role,
		           s.status, s.hours_30d, s.weighted_30d, s.hours_total,
		           s.weighted_total, s.last_exposure, e.designation, e.image
		      FROM `tabSprayer` s LEFT JOIN `tabEmployee` e ON e.name = s.employee
		     WHERE s.name = %(name)s AND {cond}""",
		params,
		as_dict=True,
	)
	if not row:
		frappe.throw("You cannot see this sprayer.", frappe.PermissionError)
	products = frappe.db.sql(
		"""SELECT spray_product, MAX(product_name) AS product_name, MAX(toxicity) AS toxicity,
		          MAX(hazard_weight) AS hazard_weight, COUNT(DISTINCT spray_application_logsheet) AS sessions,
		          SUM(hours) AS hours, SUM(weighted_hours) AS weighted_hours, MAX(date) AS last_date
		     FROM `tabSprayer Exposure` WHERE sprayer = %s
		    GROUP BY COALESCE(spray_product, product_name), spray_product
		    ORDER BY weighted_hours DESC""",
		(sprayer,),
		as_dict=True,
	)
	sessions = frappe.db.sql(
		"""SELECT spray_application_logsheet AS logsheet, MAX(date) AS date,
		          MAX(greenhouse) AS greenhouse, MAX(role) AS role, MAX(ppe_condition) AS ppe_condition,
		          MAX(hours) AS hours, SUM(weighted_hours) AS weighted_hours,
		          GROUP_CONCAT(DISTINCT product_name ORDER BY product_name SEPARATOR ', ') AS products,
		          GROUP_CONCAT(DISTINCT toxicity ORDER BY toxicity SEPARATOR ', ') AS toxicity,
		          MAX(hazard_weight) AS hazard_weight,
		          MAX(flags) AS flags
		     FROM `tabSprayer Exposure` WHERE sprayer = %s
		    GROUP BY spray_application_logsheet
		    ORDER BY MAX(date) DESC, spray_application_logsheet DESC
		    LIMIT 20""",
		(sprayer,),
		as_dict=True,
	)
	return {"sprayer": row[0], "products": products, "sessions": sessions}
