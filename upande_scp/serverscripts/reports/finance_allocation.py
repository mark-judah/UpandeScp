"""Which pest or disease a product's cost belongs to, on a plan.

`allocate_product_cost` is a pure function (no database) so the rule can be
swapped or tested in isolation. For one product on a plan with targets T the
FIRST level that applies decides the shares:

  1. registered  - Spray Product.default_targets intersected with T.
  2. nutrition   - category Foliar, or type Adjuvant / pH Buffer: the product is
                   not crop protection, so it goes to NUTRITION. Checked before
                   levels 3 and 4, AFTER level 1 (a registered target still wins).
  3. ai_class    - the product's active ingredients map (Active Ingredient MoA)
                   to IRAC -> only the pest targets in T, FRAC -> only the
                   disease targets in T.
  4. history     - the product's 180-day usage radar over T, smoothed (+0.5);
                   used only with at least MIN_PLANS plans of history.
  5. equal       - equal split over T.
  -  unattributed - T is empty: no shares, the caller reports it as Unattributed.

Within levels 1 and 3, shares are weighted by the radar when the product has
enough history, otherwise equal. Shares always sum to 1, so spend reconciles.

The radar is built by ONE aggregate query per request (not per product) and
cached for an hour per window-end date.
"""

from __future__ import annotations

import json

import frappe
from frappe.utils import add_days, cint, flt, getdate, today

NUTRITION = "Crop nutrition & adjuvants"
MIN_PLANS = 3
SMOOTHING = 0.5
RADAR_DAYS = 180
SUGGEST_MIN_SHARE = 0.3
NON_PROTECTIVE_TYPES = ("Adjuvant", "pH Buffer")

BASES = ("registered", "ai_class", "history", "nutrition", "equal", "unattributed")


def _weighted(subset, history, plans):
	"""Shares over `subset`: the smoothed radar when there is enough history, else equal."""
	if plans >= MIN_PLANS:
		w = {t: flt(history.get(t)) + SMOOTHING for t in subset}
		total = sum(w.values())
		return {t: v / total for t, v in w.items()}
	n = len(subset)
	return {t: 1.0 / n for t in subset}


def allocate_product_cost(product: dict, plan_targets, target_kinds: dict | None = None) -> dict:
	"""Split one product line's cost over a plan's targets.

	product: {"registered": [targets], "category": str, "type": str,
	          "irac": bool, "frac": bool, "nutrition": bool (optional extra),
	          "history": {target: weight}, "history_plans": int}
	plan_targets: the plan's Pest / Disease names.
	target_kinds: {target: "pest" | "disease"} (needed for level 3).

	Returns {"shares": {target: share}, "basis": one of BASES}; the shares sum to 1,
	or are empty for "unattributed".
	"""
	T = list(dict.fromkeys(t for t in (plan_targets or []) if t))
	if not T:
		return {"shares": {}, "basis": "unattributed"}
	kinds = target_kinds or {}
	history = product.get("history") or {}
	plans = cint(product.get("history_plans"))

	registered = set(product.get("registered") or [])
	hit = [t for t in T if t in registered]
	if hit:
		return {"shares": _weighted(hit, history, plans), "basis": "registered"}

	if (
		product.get("category") == "Foliar"
		or product.get("type") in NON_PROTECTIVE_TYPES
		or product.get("nutrition")
	):
		return {"shares": {NUTRITION: 1.0}, "basis": "nutrition"}

	subset = [
		t
		for t in T
		if (kinds.get(t) == "pest" and product.get("irac")) or (kinds.get(t) == "disease" and product.get("frac"))
	]
	if subset:
		return {"shares": _weighted(subset, history, plans), "basis": "ai_class"}

	if plans >= MIN_PLANS:
		return {"shares": _weighted(T, history, plans), "basis": "history"}

	return {"shares": {t: 1.0 / len(T) for t in T}, "basis": "equal"}


# --- The usage radar ----------------------------------------------------------


def build_radar(rows, valid_targets) -> dict:
	"""{item_code: {"plans": n, "targets": {target: weight}}} from (wo, targets, item) rows.

	A plan with k valid targets gives 1/k to each (a single-target plan gives 1.0).
	A plan with no valid target counts for nothing. Each (plan, item) counts once."""
	valid = set(valid_targets)
	plan_targets: dict = {}
	items: dict = {}
	for r in rows:
		wo = r["wo"]
		if wo not in plan_targets:
			ts = []
			for t in (r.get("targets") or "").split("\n"):
				t = t.strip()
				if t and t in valid and t not in ts:
					ts.append(t)
			plan_targets[wo] = ts
		items.setdefault(wo, set()).add(r["item_code"])
	radar: dict = {}
	for wo, codes in items.items():
		ts = plan_targets[wo]
		if not ts:
			continue
		for code in codes:
			e = radar.setdefault(code, {"plans": 0, "targets": {}})
			e["plans"] += 1
			for t in ts:
				e["targets"][t] = e["targets"].get(t, 0.0) + 1.0 / len(ts)
	return radar


def valid_targets_and_kinds() -> dict:
	kinds = {n: "disease" for n in frappe.get_all("Plant Disease", pluck="name")}
	kinds.update({n: "pest" for n in frappe.get_all("Pest", pluck="name")})
	return kinds


def radar(end=None, kinds=None) -> dict:
	"""The radar over the RADAR_DAYS ending `end` (default today), cached 1h."""
	end = str(getdate(end or today()))
	end = min(end, str(getdate(today())))
	key = f"scp:finance_radar:{end}"
	cache = frappe.cache()
	hit = cache.get_value(key)
	if hit:
		return json.loads(hit) if isinstance(hit, (str, bytes)) else hit
	kinds = kinds if kinds is not None else valid_targets_and_kinds()
	rows = frappe.db.sql(
		"""
		SELECT wo.name AS wo, wo.custom_targets AS targets, ri.item_code
		FROM `tabWork Order` wo
		JOIN `tabWork Order Item` ri ON ri.parent = wo.name
		WHERE wo.docstatus = 1 AND wo.custom_greenhouse IS NOT NULL AND wo.custom_greenhouse != ''
		  AND DATE(COALESCE(wo.custom_scheduled_application_time, wo.creation)) BETWEEN %(a)s AND %(b)s
		""",
		{"a": add_days(end, -RADAR_DAYS), "b": end},
		as_dict=True,
	)
	out = build_radar(rows, kinds.keys())
	cache.set_value(key, json.dumps(out), expires_in_sec=3600)
	return out


# --- Product facts ------------------------------------------------------------


def product_facts(codes, radar_data: dict) -> dict:
	"""{item_code: product dict for allocate_product_cost}. Batched queries."""
	from upande_scp.serverscripts.spray_compliance import ingredients as ING

	codes = sorted({c for c in codes if c})
	if not codes:
		return {}
	sp = {
		r.name: r
		for r in frappe.db.sql(
			"SELECT name, category, IFNULL(type,'') AS type FROM `tabSpray Product` WHERE name IN %(c)s",
			{"c": tuple(codes)},
			as_dict=True,
		)
	}
	registered: dict = {}
	for r in frappe.db.sql(
		"""SELECT parent, COALESCE(NULLIF(pest,''), NULLIF(disease,'')) AS t FROM `tabChemical Targets`
		   WHERE parenttype='Spray Product' AND parentfield='default_targets' AND parent IN %(c)s""",
		{"c": tuple(codes)},
		as_dict=True,
	):
		if r.t:
			registered.setdefault(r.parent, []).append(r.t)

	moa = frappe.get_all(
		"Active Ingredient MoA", fields=["ingredient", "aliases", "irac_code", "frac_code"]
	)
	index = ING.build_index(moa)
	by_canon = {m["ingredient"]: m for m in moa}
	classes: dict = {}
	for r in frappe.db.sql(
		"""SELECT parent, active_ingredient, ingredient FROM `tabActive Ingredient`
		   WHERE parenttype='Spray Product' AND parentfield='active_ingredients' AND parent IN %(c)s""",
		{"c": tuple(codes)},
		as_dict=True,
	):
		candidates = [r.active_ingredient, r.ingredient, *ING.split_ingredients(r.ingredient or "")]
		canon = next((index[k] for k in (ING.normalise(c or "") for c in candidates) if k in index), None)
		m = by_canon.get(canon)
		if m:
			c = classes.setdefault(r.parent, {"irac": False, "frac": False})
			c["irac"] = c["irac"] or bool(m.get("irac_code"))
			c["frac"] = c["frac"] or bool(m.get("frac_code"))

	out = {}
	for code in codes:
		p = sp.get(code)
		rd = radar_data.get(code) or {}
		cls = classes.get(code) or {}
		out[code] = {
			"registered": registered.get(code, []),
			"category": p.category if p else None,
			"type": p.type if p else None,
			"irac": cls.get("irac", False),
			"frac": cls.get("frac", False),
			"history": rd.get("targets") or {},
			"history_plans": rd.get("plans") or 0,
			"has_spray_product": bool(p),
		}
	return out


# --- Suggested registrations --------------------------------------------------

SUGGEST_ROLES = ("General Manager", "SCP General Manager", "System Manager")


def _ensure_gm():
	user = frappe.session.user
	if user == "Administrator" or set(SUGGEST_ROLES) & set(frappe.get_roles(user)):
		return
	frappe.throw("Registering pest targets requires the General Manager role.", frappe.PermissionError)


def suggestions_from_radar(entry: dict | None, kinds: dict) -> list:
	"""Top targets for a product: at least MIN_PLANS plans, each target share >= SUGGEST_MIN_SHARE."""
	if not entry or entry.get("plans", 0) < MIN_PLANS:
		return []
	total = sum(entry["targets"].values())
	if not total:
		return []
	out = [
		{"target": t, "kind": kinds.get(t), "weight": round(w, 2), "share": round(w / total, 4)}
		for t, w in entry["targets"].items()
		if w / total >= SUGGEST_MIN_SHARE
	]
	return sorted(out, key=lambda x: (-x["share"], x["target"]))


@frappe.whitelist()
def suggest_product_targets(product: str) -> dict:
	"""The usage-radar suggestion for one product (GM / System Manager)."""
	_ensure_gm()
	kinds = valid_targets_and_kinds()
	entry = radar(kinds=kinds).get(product)
	return {
		"product": product,
		"plans": (entry or {}).get("plans", 0),
		"suggestions": suggestions_from_radar(entry, kinds),
	}


@frappe.whitelist()
def suggested_registrations() -> list:
	"""Pest-control Spray Products with no default_targets, with their suggestions."""
	_ensure_gm()
	kinds = valid_targets_and_kinds()
	rd = radar(kinds=kinds)
	has_group = frappe.db.has_column("Spray Product", "custom_cost_group")
	grp = ", IFNULL(sp.custom_cost_group,'') AS cost_group" if has_group else ", '' AS cost_group"
	only_pest = "AND IFNULL(sp.custom_cost_group,'') IN ('', 'Pest control')" if has_group else ""
	rows = frappe.db.sql(
		f"""SELECT sp.name, sp.product_name, sp.category, IFNULL(sp.type,'') AS type{grp}
		   FROM `tabSpray Product` sp
		   WHERE sp.disabled = 0 AND IFNULL(sp.category,'') != 'Foliar'
		     AND IFNULL(sp.type,'') NOT IN ('Adjuvant', 'pH Buffer') {only_pest}
		     AND NOT EXISTS (SELECT 1 FROM `tabChemical Targets` ct
		                     WHERE ct.parent = sp.name AND ct.parenttype = 'Spray Product'
		                       AND ct.parentfield = 'default_targets')""",
		as_dict=True,
	)
	out = []
	rest = []
	for r in rows:
		sug = suggestions_from_radar(rd.get(r.name), kinds)
		if sug:
			out.append({"product": r.name, "product_name": r.product_name or r.name,
			            "cost_group": r.cost_group or "Pest control",
			            "plans": rd[r.name]["plans"], "suggestions": sug})
		elif not r.cost_group:
			rest.append(r)
	# Products nobody has placed: no cost group, never on a spray plan, no ingredient or
	# registration known. Finance reports them as "Unclassified"; the GM is asked to set the group.
	if rest:
		from upande_scp.serverscripts.reports import finance_attribution as FAT

		kb = FAT.load_seed()
		uses = FAT.plan_uses(today())
		raw = FAT.raw_products([r.name for r in rest], kb)
		for r in rest:
			res = FAT.resolve_product(raw[r.name], kb)
			if not uses.get(r.name) and not res["evidence"]:
				out.append({"product": r.name, "product_name": r.product_name or r.name, "cost_group": "",
				            "plans": 0, "suggestions": [], "unclassified": True})
	out += _items_without_spray_product(today())
	return sorted(out, key=lambda x: (-x["plans"], x["product_name"]))


def _items_without_spray_product(end) -> list:
	"""Items in a configured chemical / foliar group that have no Spray Product at all and no evidence:
	listed so the GM can place them (setting the group creates the Spray Product)."""
	from upande_scp.serverscripts.common import crop_protection as CP
	from upande_scp.serverscripts.reports import finance_attribution as FAT

	groups = CP.product_groups()
	if not groups:
		return []
	rows = frappe.db.sql(
		"""SELECT i.name, i.item_name FROM `tabItem` i
		   WHERE i.disabled = 0 AND i.item_group IN %(g)s
		     AND NOT EXISTS (SELECT 1 FROM `tabSpray Product` sp WHERE sp.item = i.name)""",
		{"g": tuple(groups)},
		as_dict=True,
	)
	if not rows:
		return []
	kb = FAT.load_seed()
	uses = FAT.plan_uses(end)
	raw = FAT.raw_products([r.name for r in rows], kb)
	out = []
	for r in rows:
		res = FAT.resolve_product(raw[r.name], kb)
		if FAT.cost_group(raw[r.name], True, uses.get(r.name, 0), res["evidence"]) == FAT.UNCLASSIFIED:
			out.append({"product": r.name, "product_name": r.item_name or r.name, "cost_group": "",
			            "plans": 0, "suggestions": [], "unclassified": True, "has_spray_product": False})
	return out


@frappe.whitelist()
def register_product_targets(product: str, targets) -> dict:
	"""Append targets to a Spray Product's default_targets (GM / System Manager).
	Already-registered targets are skipped."""
	_ensure_gm()
	if isinstance(targets, str):
		targets = json.loads(targets)
	kinds = valid_targets_and_kinds()
	doc = frappe.get_doc("Spray Product", product)
	have = {(r.pest or r.disease) for r in doc.get("default_targets") or []}
	added = []
	for t in targets or []:
		if t in have or t not in kinds:
			continue
		doc.append("default_targets", {("pest" if kinds[t] == "pest" else "disease"): t})
		added.append(t)
	if added:
		doc.save()
	return {"product": product, "added": added}


COST_GROUPS = ("Pest control", "Foliar", "Adjuvant", "pH buffer", "Hygiene & sanitation", "Post-harvest")


@frappe.whitelist()
def set_cost_group(product: str, cost_group: str) -> dict:
	"""Set a Spray Product's cost group (GM / System Manager). Finance reads it to decide
	whether the product's spend is attributed to pests at all."""
	_ensure_gm()
	if cost_group not in COST_GROUPS:
		frappe.throw(f"Unknown cost group {cost_group!r}.")
	created = False
	name = frappe.db.get_value("Spray Product", product, "name") or frappe.db.get_value(
		"Spray Product", {"item": product}, "name")
	if not name:
		# Items nobody has made a Spray Product for (their group is configured, the record is missing):
		# create it from the Item, category from its Item Group, rather than silently doing nothing.
		from upande_scp.serverscripts.common import crop_protection as CP

		if not frappe.db.exists("Item", product):
			frappe.throw(f"{product!r} is neither a Spray Product nor an Item.")
		made = CP.ensure_product_record(product)
		if not made:
			frappe.throw(
				f"{product} is not in a configured chemical or foliar Item Group, so it cannot be a Spray Product."
			)
		name, created = made[1], True
	frappe.db.set_value("Spray Product", name, "custom_cost_group", cost_group)
	from upande_scp.serverscripts.reports import finance_attribution as FAT

	FAT.bump_reference_version()
	return {"product": product, "spray_product": name, "cost_group": cost_group, "created": created,
	        "message": "Created a Spray Product from the Item." if created else None}
