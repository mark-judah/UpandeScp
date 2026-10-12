"""One-off, safe repair of the farm <-> cost centre links (B8).

``audit(company, apply=False)``:

* fills ``Warehouse.custom_cost_center`` from the existing name matcher, where empty;
* proposes ``Farm.custom_cost_center`` (the farm's cost-centre group): a group
  named like the farm (``Simotwo  Farm - KR`` — whitespace-tolerant), else the
  group most of its greenhouses' cost centres sit under;
* fills ``Cost Center.custom_farm`` on each farm group and everything under it;
* lists warehouses that match no cost centre, greenhouse cost centres filed
  under the wrong parent (another farm, or Post Harvest), and crop-protection
  expense booked outside every farm's tree (``Main - KR``).

Dry run unless ``apply`` is set, and even then it only fills EMPTY fields. It
never moves a cost centre: moving ``Main - KR``, ``KarenGH10`` or ``Torongo GH18``
changes the ledger's history and is Accounts' decision, so it is reported.
It does not commit — a whitelisted call is committed by the request.
"""
from __future__ import annotations

import re

import frappe
from frappe.utils import cint, flt, getdate, nowdate

from upande_scp.serverscripts.finance import accounts as acc
from upande_scp.serverscripts.finance.cost_centres import _has_column, purchase_leaf_name
from upande_scp.serverscripts.spray_plan_creator.validation import _normalise_name_key

ROLES = {"SCP General Manager", "System Manager", "Administrator"}


def _ensure_role() -> None:
	if frappe.session.user == "Administrator" or ROLES & set(frappe.get_roles()):
		return
	frappe.throw("Only the SCP General Manager can repair cost-centre links.", frappe.PermissionError)


def _key(name: str) -> str:
	return _normalise_name_key(name or "")


def _strip_abbr(name: str, abbr: str) -> str:
	return re.sub(rf"\s*-\s*{re.escape(abbr)}\s*$", "", name or "") if abbr else (name or "")


def _company_farms(company: str) -> list[str]:
	farms = set()
	if _has_column("Farm", "company"):
		farms |= set(frappe.get_all("Farm", filters={"company": company}, pluck="name"))
	farms |= {
		r.custom_farm
		for r in frappe.get_all(
			"Warehouse",
			filters={"company": company, "custom_farm": ("is", "set")},
			fields=["custom_farm"],
			distinct=True,
		)
	}
	return sorted(f for f in farms if f and frappe.db.exists("Farm", f))


def _ancestor_group(cc: dict, by_name: dict, groups_by_name: set) -> str | None:
	"""The nearest group above `cc` that is one of `groups_by_name`."""
	seen = 0
	parent = cc.get("parent_cost_center")
	while parent and seen < 50:
		if parent in groups_by_name:
			return parent
		parent = (by_name.get(parent) or {}).get("parent_cost_center")
		seen += 1
	return None


def propose_farm_group(farm: str, abbr: str, groups: list[dict], leaves: list[dict]) -> tuple[str | None, str | None]:
	"""``(group, how)`` for a farm. Pure.

	1. a group named like the farm — ``<Farm> Farm - <abbr>`` or ``<Farm> - <abbr>``,
	   whitespace and case tolerant (``Simotwo  Farm - KR``);
	2. a top-level group whose name starts with the farm's (``Endebess Coffee - KL``);
	3. the top-most group, below the company root, that holds at least half of the
	   farm's greenhouse cost centres (``leaves``: dicts with lft/rgt).
	The company root is never proposed.
	"""
	roots = {g["name"] for g in groups if not g.get("parent_cost_center")}
	wanted = {_key(f"{farm} Farm - {abbr}"), _key(f"{farm} - {abbr}")}
	for g in groups:
		if g["name"] not in roots and _key(g["name"]) in wanted:
			return g["name"], "name"
	fk = _key(farm)
	for g in sorted(groups, key=lambda g: g["name"]):
		if g.get("parent_cost_center") in roots and fk and _key(g["name"]).startswith(fk):
			return g["name"], "name prefix"
	if not leaves:
		return None, None
	best = None
	for g in groups:
		if g["name"] in roots:
			continue
		n = sum(1 for l in leaves if l["lft"] >= g["lft"] and l["rgt"] <= g["rgt"])
		if n * 2 < len(leaves):
			continue
		# Most leaves first; among equals the widest group, which is the farm's own
		# rather than one block inside it.
		rank = (n, g["rgt"] - g["lft"])
		if best is None or rank > best[0]:
			best = (rank, g["name"], n)
	if best:
		return best[1], f"holds {best[2]} of {len(leaves)} greenhouse cost centres"
	return None, None


def _greenhouse_like(name: str) -> bool:
	"""A greenhouse or crop block, not a store, CSU, flock or cold room. Pure."""
	k = _key(name)
	if any(w in k for w in ("store", "csu", "flock", "coldroom", "tank", "overhead")):
		return False
	return True


def farm_named_leaf(cc_name: str, abbr: str, farms: list[str]) -> str | None:
	"""Which farm a greenhouse-style leaf name points at ("KarenGH10 - KR" -> Karen). Pure."""
	base = _key(_strip_abbr(cc_name, abbr))
	if "gh" not in base:
		return None
	for f in sorted(farms, key=len, reverse=True):
		fk = _key(f)
		if fk and base.startswith(fk) and base[len(fk):].startswith("gh"):
			return f
	return None


@frappe.whitelist()
def audit(company: str, apply=False) -> dict:
	_ensure_role()
	apply = bool(cint(apply))
	abbr = frappe.db.get_value("Company", company, "abbr")
	if not abbr:
		frappe.throw(f"Unknown company {company}.")

	has_cc_farm = _has_column("Cost Center", "custom_farm")
	cc_fields = ["name", "is_group", "parent_cost_center", "lft", "rgt", "disabled"]
	if has_cc_farm:
		cc_fields.append("custom_farm")
	ccs = frappe.get_all("Cost Center", filters={"company": company}, fields=cc_fields, limit_page_length=0)
	by_name = {c.name: c for c in ccs}
	by_key: dict[str, str] = {}
	for c in ccs:
		if not c.disabled:
			by_key.setdefault(_key(c.name), c.name)
	groups = [c for c in ccs if c.is_group]

	farms = _company_farms(company)

	# ── 1. warehouses ─────────────────────────────────────────────────────
	whs = frappe.get_all(
		"Warehouse",
		filters={"company": company, "is_group": 0, "custom_farm": ("is", "set"), "disabled": 0},
		fields=["name", "custom_farm", "custom_cost_center", "warehouse_type"],
		limit_page_length=0,
	)
	already, matched, unmatched = [], [], []
	for w in whs:
		if w.custom_cost_center:
			already.append({"warehouse": w.name, "farm": w.custom_farm, "cost_center": w.custom_cost_center})
			continue
		cc = w.name if w.name in by_name and not by_name[w.name].disabled else by_key.get(_key(w.name))
		if cc:
			matched.append({
				"warehouse": w.name, "farm": w.custom_farm, "cost_center": cc,
				"source": "exact" if cc == w.name else "fuzzy",
			})
		else:
			unmatched.append({"warehouse": w.name, "farm": w.custom_farm, "warehouse_type": w.warehouse_type})

	house_cc = {m["warehouse"]: m["cost_center"] for m in already + matched}
	house_farm = {w.name: w.custom_farm for w in whs}

	# ── 2. farm groups ────────────────────────────────────────────────────
	group_names = {g.name for g in groups}
	farm_rows = []
	farm_group: dict[str, str] = {}
	has_farm_cc = _has_column("Farm", "custom_cost_center")
	for f in farms:
		current = frappe.db.get_value("Farm", f, "custom_cost_center") if has_farm_cc else None
		leaves = [
			by_name[cc]
			for wh, cc in house_cc.items()
			if house_farm.get(wh) == f and cc in by_name and not by_name[cc].is_group
			and _greenhouse_like(wh)
		]
		proposed, how = propose_farm_group(f, abbr, groups, leaves)
		group = current or proposed
		if group:
			farm_group[f] = group
		farm_rows.append({
			"farm": f, "current": current, "proposed": proposed, "how": how,
			"purchase_cost_center": (
				frappe.db.get_value("Farm", f, "custom_purchase_cost_center")
				if _has_column("Farm", "custom_purchase_cost_center") else None
			),
			"purchase_leaf_suggested": purchase_leaf_name(f, company),
		})

	# ── 3. Cost Center.custom_farm, and 4. misfiled leaves ────────────────
	cc_farm: dict[str, str] = {}
	for f, g in farm_group.items():
		node = by_name.get(g)
		if not node:
			continue
		for c in ccs:
			if c.lft >= node.lft and c.rgt <= node.rgt:
				cc_farm.setdefault(c.name, f)
	# A greenhouse leaf matched to a warehouse names its farm better than its
	# parent does. Other leaves (a poultry flock, a store) keep their group's farm.
	for wh, cc in house_cc.items():
		if cc in by_name and not by_name[cc].is_group and house_farm.get(wh) and _greenhouse_like(wh):
			cc_farm[cc] = house_farm[wh]

	group_of_farm = set(farm_group.values())
	misfiled = []
	seen_mis = set()
	candidates = [(wh, cc, house_farm.get(wh)) for wh, cc in house_cc.items() if _greenhouse_like(wh)]
	for c in ccs:
		if not c.is_group:
			f = farm_named_leaf(c.name, abbr, farms)
			if f:
				candidates.append((None, c.name, f))
	for wh, cc, f in candidates:
		node = by_name.get(cc)
		expected = farm_group.get(f)
		if not node or node.is_group or not expected or cc in seen_mis:
			continue
		exp = by_name.get(expected)
		if exp and node.lft >= exp.lft and node.rgt <= exp.rgt:
			continue
		seen_mis.add(cc)
		actual_farm_group = _ancestor_group(node, by_name, group_of_farm)
		owner = next((ff for ff, gg in farm_group.items() if gg == actual_farm_group), None)
		misfiled.append({
			"cost_center": cc,
			"warehouse": wh,
			"farm": f,
			"expected_parent": expected,
			"actual_parent": node.parent_cost_center,
			"under": f"farm {owner}" if owner else node.parent_cost_center,
		})
		cc_farm[cc] = f

	tag_rows = []
	conflicts = []
	if has_cc_farm:
		for cc, f in sorted(cc_farm.items()):
			cur = by_name[cc].get("custom_farm")
			if not cur:
				tag_rows.append({"cost_center": cc, "farm": f})
			elif cur != f:
				conflicts.append({"cost_center": cc, "current_farm": cur, "proposed_farm": f})

	# ── 5. crop-protection expense outside every farm's tree ──────────────
	off_farm = _off_farm_expense(company, ccs, by_name, group_of_farm)

	if apply:
		for m in matched:
			frappe.db.set_value("Warehouse", m["warehouse"], "custom_cost_center", m["cost_center"], update_modified=False)
		if has_cc_farm:
			for t in tag_rows:
				frappe.db.set_value("Cost Center", t["cost_center"], "custom_farm", t["farm"], update_modified=False)
		if has_farm_cc:
			for r in farm_rows:
				if not r["current"] and r["proposed"]:
					frappe.db.set_value("Farm", r["farm"], "custom_cost_center", r["proposed"], update_modified=False)
		_bust_caches()

	return {
		"company": company,
		"applied": apply,
		"counts": {
			"warehouses": len(whs),
			"warehouses_already_linked": len(already),
			"warehouses_matched": len(matched),
			"warehouses_unmatched": len(unmatched),
			"farms": len(farms),
			"farms_with_group": sum(1 for r in farm_rows if r["current"] or r["proposed"]),
			"cost_centres_to_tag": len(tag_rows),
			"cost_centre_farm_conflicts": len(conflicts),
			"misfiled": len(misfiled),
		},
		"farms": farm_rows,
		"warehouses_matched": matched,
		"warehouses_unmatched": unmatched,
		"cost_centres_tagged": tag_rows,
		"cost_centre_conflicts": conflicts,
		"misfiled": misfiled,
		"off_farm_expense": off_farm,
	}


def _bust_caches() -> None:
	"""Direct writes skip doc events, so drop the cached lists they would have."""
	from upande_scp.serverscripts.common import cache_utils

	for dt in ("Warehouse", "Farm", "Cost Center"):
		keys = cache_utils._DOC_INVALIDATIONS.get(dt)
		if keys:
			cache_utils.invalidate(*keys)


def _off_farm_expense(company, ccs, by_name, farm_groups) -> list[dict]:
	"""Year-to-date chemical/foliar GL on cost centres under no farm group."""
	accounts = acc.accounts_for_kind(company, "chemical") + acc.accounts_for_kind(company, "foliar")
	if not accounts:
		return []
	start = getdate(nowdate()).replace(month=1, day=1)
	rows = frappe.db.sql(
		"""SELECT cost_center, SUM(debit - credit) amt FROM `tabGL Entry`
		   WHERE company = %s AND is_cancelled = 0 AND account IN %s AND posting_date >= %s
		   GROUP BY cost_center""",
		(company, tuple(accounts), start),
		as_dict=True,
	)
	out = []
	for r in rows:
		node = by_name.get(r.cost_center)
		inside = bool(node) and any(
			node.lft >= by_name[g].lft and node.rgt <= by_name[g].rgt for g in farm_groups if g in by_name
		)
		if not inside and flt(r.amt):
			out.append({
				"cost_center": r.cost_center or "(none)",
				"parent": node.parent_cost_center if node else None,
				"amount": round(flt(r.amt), 2),
				"since": str(start),
			})
	return sorted(out, key=lambda x: -x["amount"])


@frappe.whitelist()
def create_purchase_cost_center(farm: str, apply=False) -> dict:
	"""Offer the farm's purchase leaf, ``<Farm> Crop Protection - <abbr>``, under its group.

	Dry run by default; never called automatically (B4).
	"""
	_ensure_role()
	from upande_scp.serverscripts.finance.cost_centres import farm_company, farm_cost_center

	company = farm_company(farm)
	group = farm_cost_center(farm)
	name = purchase_leaf_name(farm, company)
	out = {"farm": farm, "company": company, "parent": group, "cost_center": name, "created": False}
	if not (company and group and name):
		out["why"] = "the farm needs a company and Farm.custom_cost_center (its group) first"
		return out
	if frappe.db.exists("Cost Center", name):
		out["exists"] = True
	elif cint(apply):
		frappe.get_doc({
			"doctype": "Cost Center",
			"cost_center_name": f"{farm} Crop Protection",
			"parent_cost_center": group,
			"company": company,
			"is_group": 0,
		}).insert(ignore_permissions=True)
		out["created"] = True
	if cint(apply) and _has_column("Farm", "custom_purchase_cost_center") and frappe.db.exists("Cost Center", name):
		if not frappe.db.get_value("Farm", farm, "custom_purchase_cost_center"):
			frappe.db.set_value("Farm", farm, "custom_purchase_cost_center", name, update_modified=False)
			out["linked"] = True
	return out
