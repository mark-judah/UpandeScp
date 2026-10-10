"""Crop-protection finances — what was spent on chemicals and foliars, and on
what it was spent, over a period. Ported from mona (roadmap item 9).

Cost is the ACTUAL value of product consumed: the submitted Stock Entry lines'
``amount`` (qty x valuation at posting), not the work-order plan.

COUNT EACH UNIT ONCE, WHERE IT LEAVES THE STORE FOR USE (F2):

  * ``Material Transfer for Manufacture`` (kaitet's "CSU Chemical Transfer")
    — store into the CSU, against a work order.
  * ``Material Issue`` — issued straight from a store.
  * kaitet's ``Chemical Spray`` is a Material Issue. It counts only when its
    source is not a WIP area (CSU): product in a CSU was already counted on the
    transfer that put it there. The same holds for any issue out of a CSU.

Excluded: ``Chemical Loaning`` (farm-to-farm move), ``Chemical Mixing`` and
``Manufacture`` (tank-mix internals that consume what the transfer already
counted), ``Material Transfer`` and ``Material Receipt``.

Only lines whose Item sits in a configured crop-protection group count. On
kaitet.local the Chemical Spray lines issue the tank-mix item (group "Chemical
Mix") out of the greenhouse, so they fall out on the group filter — which is
correct: that mix's value is the chemicals already counted on the transfer.

ATTRIBUTION IS A CONVENTION, NOT A MEASUREMENT. One tank is sprayed at one
rate; nothing in the data says how much of a mixed dose was "for" which pest.
Where a product's own targets pin the cost down, the cell is ``attributed``;
otherwise it is divided equally across the plan's targets and marked ``split``.
Foliars never borrow the plan's pest/disease targets: a foliar with no matching
target lands in ``Nutrition``.

Zero-valuation lines (F5) count as 0 and are listed under ``no_valuation`` so a
missing cost is visible instead of silently cheap.
"""

from __future__ import annotations

import re

import frappe
from frappe.utils import flt, now_datetime

from upande_scp.serverscripts.common import crop_catalog, crop_protection, crop_scope

FINANCE_ROLES = ("SCP General Manager", "System Manager")
NUTRITION = "Nutrition"
UNATTRIBUTED = "Unattributed"
UNASSIGNED_FARM = "Unassigned"

CONSUMPTION_PURPOSES = ("Material Transfer for Manufacture", "Material Issue")
#: Custom types that never count, whatever purpose a site maps them to.
EXCLUDED_TYPES = frozenset({"Chemical Loaning", "Chemical Mixing", "Manufacture", "Material Receipt"})

_SQL = """
	SELECT se.name AS stock_entry, se.posting_date, se.stock_entry_type, se.purpose,
	       sed.s_warehouse, sed.item_code, sed.transfer_qty AS qty, sed.stock_uom,
	       sed.amount, sed.cost_center,
	       i.item_group, i.item_name,
	       wo.custom_greenhouse AS greenhouse, wo.custom_targets AS targets,
	       gh.custom_farm AS gh_farm, sw.custom_farm AS src_farm
	FROM `tabStock Entry` se
	JOIN `tabStock Entry Detail` sed ON sed.parent = se.name
	JOIN `tabItem` i ON i.name = sed.item_code
	LEFT JOIN `tabWork Order` wo ON wo.name = se.work_order
	LEFT JOIN `tabWarehouse` gh ON gh.name = wo.custom_greenhouse
	LEFT JOIN `tabWarehouse` sw ON sw.name = sed.s_warehouse
	WHERE se.docstatus = 1
	  AND se.purpose IN %(purposes)s
	  AND se.posting_date BETWEEN %(f)s AND %(t)s
	  AND i.item_group IN %(groups)s
	ORDER BY se.posting_date, se.name, sed.idx
"""


def _ensure_finance_role() -> None:
	user = frappe.session.user
	if user == "Administrator" or set(FINANCE_ROLES) & set(frappe.get_roles(user)):
		return
	frappe.throw(
		"Crop-protection finances requires the SCP General Manager role.",
		frappe.PermissionError,
	)


def _counted(line, is_wip) -> bool:
	"""F2: does this line record product leaving the store for use?"""
	if line.get("stock_entry_type") in EXCLUDED_TYPES:
		return False
	purpose = line.get("purpose")
	if purpose == "Material Transfer for Manufacture":
		return True
	if purpose == "Material Issue":
		# Out of a CSU it was already counted on the transfer into it.
		return not is_wip(line.get("s_warehouse"))
	return False


def _attribute(kind, product_targets, plan_targets):
	"""(buckets, is_split) — see the module docstring.

	"No plan targets" is decided FIRST, for every kind: a line issued straight
	from the store has no greenhouse and no target, and inventing a Nutrition
	bucket for it would file it under a greenhouse that never received it.
	"""
	if not plan_targets:
		return [], False
	relevant = [t for t in plan_targets if t in product_targets]
	if relevant:
		return relevant, False
	if kind == "foliar":
		return [NUTRITION], False
	return list(plan_targets), True


def _new_cell():
	return {"value": 0.0, "attributed": 0.0, "split": 0.0, "split_items": set()}


def _build(lines, *, pests, diseases, product_targets, classify, is_wip, farm_scope=None, farm=None) -> dict:
	"""Fold stock lines into the report. Pure apart from the injected lookups.

	``farm_scope``: None = no restriction; a set = only these farms. A line's
	farm is its work order greenhouse's farm, else its source store's farm.
	"""
	valid = set(pests) | set(diseases)
	names: dict = {}
	data: dict = {}  # farm -> (greenhouse, kind) -> target -> cell
	unattributed: dict = {}  # (farm, cost_center, kind) -> value
	untargeted: dict = {}
	no_valuation: list = []
	per_target: dict = {}  # target -> {value, attributed, split, houses}
	totals_by_kind = {"chemical": 0.0, "foliar": 0.0}

	for r in lines:
		if not _counted(r, is_wip):
			continue
		f = r.get("gh_farm") or r.get("src_farm") or UNASSIGNED_FARM
		if farm and f != farm:
			continue
		if farm_scope is not None and f not in farm_scope:
			continue

		code = r["item_code"]
		kind = classify(r.get("item_group")) or "chemical"
		amount = flt(r.get("amount"))
		if not amount:
			no_valuation.append({
				"stock_entry": r.get("stock_entry"),
				"posting_date": str(r.get("posting_date") or ""),
				"item_code": code,
				"item_name": r.get("item_name") or code,
				"kind": kind,
				"qty": flt(r.get("qty")),
				"uom": r.get("stock_uom"),
				"greenhouse": r.get("greenhouse"),
				"farm": f,
			})
			continue

		names[code] = r.get("item_name") or code
		totals_by_kind[kind] = totals_by_kind.get(kind, 0.0) + amount

		ptargets = product_targets(code)
		if not ptargets:
			u = untargeted.setdefault(
				code, {"item_code": code, "item_name": names[code], "kind": kind, "value": 0.0}
			)
			u["value"] += amount

		# Only real pests/diseases — plans also record husbandry ops like
		# "Re-bending" in custom_targets, which are not a spend target.
		plan_targets = []
		for t in (r.get("targets") or "").split("\n"):
			t = t.strip()
			if t and t in valid and t not in plan_targets:
				plan_targets.append(t)

		buckets, is_split = _attribute(kind, ptargets, plan_targets)
		if not buckets or not r.get("greenhouse"):
			key = (f, r.get("cost_center") or UNATTRIBUTED, kind)
			unattributed[key] = unattributed.get(key, 0.0) + amount
			continue

		share = amount / len(buckets)
		row = data.setdefault(f, {}).setdefault((r["greenhouse"], kind), {})
		for b in buckets:
			cell = row.setdefault(b, _new_cell())
			cell["value"] += share
			if is_split:
				cell["split"] += share
				cell["split_items"].add(code)
			else:
				cell["attributed"] += share
			if b in valid:
				pt = per_target.setdefault(b, {"value": 0.0, "attributed": 0.0, "split": 0.0, "houses": set()})
				pt["value"] += share
				pt["split" if is_split else "attributed"] += share
				pt["houses"].add(r["greenhouse"])

	# ---- shape the payload -------------------------------------------
	farms_out = []
	for f in sorted(data):
		rows = data[f]
		targets = sorted({t for cells in rows.values() for t in cells}, key=lambda t: (t == NUTRITION, t))
		target_totals = dict.fromkeys(targets, 0.0)
		rows_out = []
		for (greenhouse, kind) in sorted(rows):
			cells = rows[(greenhouse, kind)]
			costs = {}
			for t in targets:
				c = cells.get(t)
				costs[t] = {
					"value": round(c["value"], 2) if c else 0.0,
					"attributed": round(c["attributed"], 2) if c else 0.0,
					"split": round(c["split"], 2) if c else 0.0,
					"split_items": sorted(c["split_items"]) if c else [],
				}
				if c:
					target_totals[t] += c["value"]
			rows_out.append({
				"greenhouse": greenhouse,
				"kind": kind,
				"costs": costs,
				"total": round(sum(c["value"] for c in cells.values()), 2),
			})
		farms_out.append({
			"farm": f,
			"targets": targets,
			"rows": rows_out,
			"target_totals": {t: round(v, 2) for t, v in target_totals.items()},
			"total": round(sum(target_totals.values()), 2),
		})

	target_sum = sum(p["value"] for p in per_target.values())
	cost_per_target = sorted(
		(
			{
				"target": t,
				"kind": "pest" if t in pests else "disease",
				"value": round(p["value"], 2),
				"attributed": round(p["attributed"], 2),
				"split": round(p["split"], 2),
				"share": round(p["value"] / target_sum, 4) if target_sum else 0.0,
				"houses": len(p["houses"]),
			}
			for t, p in per_target.items()
		),
		key=lambda x: (-x["value"], x["target"]),
	)

	unattributed_out = sorted(
		(
			{"farm": fm, "cost_center": cc, "kind": k, "value": round(v, 2)}
			for (fm, cc, k), v in unattributed.items()
		),
		key=lambda x: -x["value"],
	)
	untargeted_out = sorted(
		({**u, "value": round(u["value"], 2)} for u in untargeted.values()),
		key=lambda x: -x["value"],
	)

	return {
		"as_of": now_datetime().isoformat(timespec="seconds"),
		"currency": frappe.db.get_default("currency") or "KES",
		# item_code -> item_name, sent once rather than repeated on every cell.
		"item_names": names,
		"farms": farms_out,
		"cost_per_target": cost_per_target,
		"unattributed": unattributed_out,
		"untargeted_items": untargeted_out,
		"no_valuation": no_valuation,
		"totals_by_kind": {k: round(v, 2) for k, v in totals_by_kind.items()},
		"grand_total": round(
			sum(fo["total"] for fo in farms_out) + sum(u["value"] for u in unattributed_out), 2
		),
	}


def _wip_matcher():
	"""`is_wip_area` with the keyword list read once, not once per line."""
	from upande_scp.serverscripts.spray_plan_creator.crop_settings import wip_keywords

	patterns = [re.compile(rf"\b{re.escape(w)}\b", re.IGNORECASE) for w in wip_keywords()]
	return lambda name: any(p.search(name or "") for p in patterns)


def _target_lookup():
	cache: dict = {}

	def lookup(code):
		if code not in cache:
			names = set()
			for t in crop_protection.get_product_targets(code):
				if t.get("pest"):
					names.add(t["pest"])
				if t.get("disease"):
					names.add(t["disease"])
			cache[code] = names
		return cache[code]

	return lookup


@frappe.whitelist()
def chemical_cost_by_target(
	from_date: str, to_date: str, farm: str | None = None, crop: str | None = None
) -> dict:
	"""Greenhouse x target crop-protection spend for the period.

	``crop`` (the route crop) limits the farms to that crop's, intersected with
	the farms the user may see (piece 1 crop scoping).
	"""
	_ensure_finance_role()
	canon = crop_catalog.resolve_crop(crop) if crop else ""
	farm_scope = crop_scope.scoped_farms(canon or None)

	groups = crop_protection.product_groups()
	lines = []
	if groups:
		# No configured groups: `IN ()` is a syntax error, and an unconfigured
		# site genuinely has nothing to report.
		lines = frappe.db.sql(
			_SQL,
			{"f": from_date, "t": to_date, "groups": groups, "purposes": CONSUMPTION_PURPOSES},
			as_dict=True,
		)

	return _build(
		lines,
		pests=set(frappe.get_all("Pest", pluck="name")),
		diseases=set(frappe.get_all("Plant Disease", pluck="name")),
		product_targets=_target_lookup(),
		classify=crop_protection.classify_item_group,
		is_wip=_wip_matcher(),
		farm_scope=farm_scope,
		farm=farm or None,
	)
