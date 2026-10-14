"""Crop-protection finances: what was actually spent on chemicals and foliars,
and which pests and diseases it was spent against.

ACTUAL COST. Every figure is the value product LEFT THE STORE at, read from the
Stock Ledger (``-stock_value_difference`` of the line's outgoing ledger entry),
not the work-order plan and not a re-priced quantity. Where a line has no ledger
entry the Stock Entry line's own ``amount`` stands in, and the report counts how
many lines did that (``ledger_fallback_lines``).

COUNT EACH UNIT ONCE, WHERE IT LEAVES THE STORE FOR USE:

  * ``Material Transfer for Manufacture`` - store into the CSU, against a plan.
  * ``Material Issue`` - issued straight from a store (mona's foliars are mostly
    this).
  * Either one out of a WIP area (CSU) is NOT counted: that stock was already
    counted on the transfer that put it there.

Excluded: ``Manufacture`` (consumes WIP the transfer already counted),
``Material Transfer`` and ``Material Receipt`` (movements, not consumption),
``Chemical Loaning`` / ``Chemical Mixing`` types whatever purpose a site gives them.

ALLOCATION TO PESTS AND DISEASES is `finance_allocation.allocate_product_cost`:
for each product line on a plan with targets T, the first level that applies decides
the shares - registered targets, nutrition/adjuvant line, active-ingredient class,
the 180-day usage radar, then an equal split. Product issued with no plan or no
targets is UNATTRIBUTED. Shares sum to 1 per line, so targets (including the
nutrition line) + unattributed always equal the total spend (`reconciliation`).
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta

import frappe
from frappe.utils import flt, now_datetime

from upande_scp.serverscripts.common import crop_catalog, crop_protection, crop_scope
from upande_scp.serverscripts.reports import finance_allocation as FA
from upande_scp.serverscripts.roles import has_any_role

FINANCE_ROLES = ("General Manager", "System Manager")
UNATTRIBUTED = "Unattributed"
UNASSIGNED_FARM = "Unassigned"
NO_PLAN = "No plan"

CONSUMPTION_PURPOSES = ("Material Transfer for Manufacture", "Material Issue")
#: Custom types that never count, whatever purpose a site maps them to.
EXCLUDED_TYPES = frozenset({"Chemical Loaning", "Chemical Mixing", "Manufacture", "Material Receipt"})

REASON_NO_PLAN = "no_plan"

# The ledger value comes from a pre-aggregated subquery bounded by the period, so
# the (large) ledger is never scanned whole.
_SQL = """
	SELECT se.name AS stock_entry, se.posting_date, se.stock_entry_type, se.purpose,
	       se.work_order, wo.custom_targets AS targets, sed.s_warehouse, sed.item_code, sed.transfer_qty AS qty,
	       sed.stock_uom, sed.amount AS line_amount, sle.val AS ledger_value,
	       sed.cost_center, i.item_group, i.item_name,
	       wo.custom_greenhouse AS greenhouse,
	       gh.custom_farm AS gh_farm, sw.custom_farm AS src_farm
	FROM `tabStock Entry` se
	JOIN `tabStock Entry Detail` sed ON sed.parent = se.name
	JOIN `tabItem` i ON i.name = sed.item_code
	LEFT JOIN (
		SELECT voucher_detail_no, SUM(-stock_value_difference) AS val
		FROM `tabStock Ledger Entry`
		WHERE voucher_type = 'Stock Entry' AND is_cancelled = 0 AND actual_qty < 0
		  AND posting_date BETWEEN %(f)s AND %(t)s
		GROUP BY voucher_detail_no
	) sle ON sle.voucher_detail_no = sed.name
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
	if user == "Administrator" or has_any_role(FINANCE_ROLES, user=user):
		return
	frappe.throw(
		"Crop-protection finances requires the General Manager role.",
		frappe.PermissionError,
	)


def _counted(line, is_wip) -> bool:
	if line.get("stock_entry_type") in EXCLUDED_TYPES:
		return False
	if line.get("purpose") not in CONSUMPTION_PURPOSES:
		return False
	# Out of a CSU it was already counted on the transfer into it.
	return not is_wip(line.get("s_warehouse"))


def _wip_matcher():
	"""`is_wip_area` with the keyword list read once, not once per line."""
	from upande_scp.serverscripts.spray_plan_creator.crop_settings import wip_keywords

	patterns = [
		re.compile(rf"(?<![A-Za-z]){re.escape(w)}(?![A-Za-z])", re.IGNORECASE) for w in wip_keywords()
	]
	return lambda name: any(p.search(name or "") for p in patterns)


def _period_key(d, granularity):
	if isinstance(d, str):
		d = datetime.strptime(d[:10], "%Y-%m-%d").date()
	elif isinstance(d, datetime):
		d = d.date()
	if granularity == "month":
		return d.strftime("%Y-%m")
	monday = d - timedelta(days=d.weekday())
	return monday.isoformat()


def _granularity(from_date, to_date) -> str:
	try:
		span = (datetime.strptime(str(to_date)[:10], "%Y-%m-%d") - datetime.strptime(str(from_date)[:10], "%Y-%m-%d")).days
	except ValueError:
		return "month"
	return "week" if span <= 62 else "month"


def _build(lines, *, classify, is_wip, facts, kinds, farm_scope=None, farm=None, granularity="month") -> dict:
	"""Fold stock lines into the report. Pure apart from the injected lookups.

	facts: {item_code: product dict for allocate_product_cost}; kinds: {target: pest|disease}."""
	names: dict = {}
	totals_by_kind = {"chemical": 0.0, "foliar": 0.0}
	per_target: dict = {}  # target -> {value, houses:set, products:{code: v}, basis:{b: v}}
	per_product: dict = {}  # code -> {item_name, kind, value, attributed, unattributed, targets:{t: v}}
	per_place: dict = {}  # (farm, greenhouse) -> {value, attributed, unattributed}
	per_period: dict = {}  # period -> {value, attributed, unattributed}
	unattributed: dict = {}  # (farm, greenhouse, kind, reason) -> value
	farm_cells: dict = {}  # farm -> (greenhouse, kind) -> target -> value
	no_valuation: list = []
	ledger_fallback = 0
	total = 0.0
	basis_totals: dict = dict.fromkeys(FA.BASES, 0.0)

	for r in lines:
		if not _counted(r, is_wip):
			continue
		f = r.get("gh_farm") or r.get("src_farm") or UNASSIGNED_FARM
		if farm and f != farm:
			continue
		# Spend with no farm at all (issued from an unmapped store, no plan) cannot be
		# scoped to a crop; it is kept and shown as "Unassigned" rather than dropped.
		if farm_scope is not None and f != UNASSIGNED_FARM and f not in farm_scope:
			continue

		code = r["item_code"]
		kind = classify(r.get("item_group")) or "chemical"
		if r.get("ledger_value") is not None:
			amount = flt(r["ledger_value"])
		else:
			amount = flt(r.get("line_amount"))
			ledger_fallback += 1
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
		total += amount
		greenhouse = r.get("greenhouse")

		# ---- allocate over the plan's targets -------------------------------
		plan_targets: list = []
		wo = r.get("work_order")
		if wo and greenhouse:
			for t in (r.get("targets") or "").split("\n"):
				t = t.strip()
				if t and t in kinds and t not in plan_targets:
					plan_targets.append(t)
		product = dict(facts.get(code) or {})
		if kind == "foliar":
			product["nutrition"] = True
		alloc = FA.allocate_product_cost(product, plan_targets, kinds)
		covered = alloc["shares"]
		basis = alloc["basis"]
		reason = REASON_NO_PLAN

		place = per_place.setdefault((f, greenhouse or NO_PLAN), {"value": 0.0, "attributed": 0.0, "unattributed": 0.0})
		period = per_period.setdefault(
			_period_key(r["posting_date"], granularity), {"value": 0.0, "attributed": 0.0, "unattributed": 0.0}
		)
		prod = per_product.setdefault(
			code,
			{"item_code": code, "item_name": names[code], "kind": kind,
			 "value": 0.0, "attributed": 0.0, "unattributed": 0.0, "targets": {}},
		)
		for bucket in (place, period, prod):
			bucket["value"] += amount

		if not covered:
			basis_totals["unattributed"] += amount
			key = (f, greenhouse or NO_PLAN, kind, reason)
			unattributed[key] = unattributed.get(key, 0.0) + amount
			for bucket in (place, period, prod):
				bucket["unattributed"] += amount
			continue

		basis_totals[basis] += amount
		for t, frac in covered.items():
			share = amount * frac
			pt = per_target.setdefault(t, {"value": 0.0, "houses": set(), "products": {}, "basis": {}})
			pt["value"] += share
			pt["basis"][basis] = pt["basis"].get(basis, 0.0) + share
			pt["houses"].add(greenhouse)
			pt["products"][code] = pt["products"].get(code, 0.0) + share
			prod["targets"][t] = prod["targets"].get(t, 0.0) + share
			cells = farm_cells.setdefault(f, {}).setdefault((greenhouse, kind), {})
			cells[t] = cells.get(t, 0.0) + share
		for bucket in (place, period, prod):
			bucket["attributed"] += amount

	# ---- shape the payload ------------------------------------------------
	attributed_total = sum(p["value"] for p in per_target.values())
	unattributed_total = sum(unattributed.values())

	cost_per_target = sorted(
		(
			{
				"target": t,
				"kind": "nutrition" if t == FA.NUTRITION else kinds.get(t),
				"basis": {b: round(v, 2) for b, v in p["basis"].items()},
				"value": round(p["value"], 2),
				"share": round(p["value"] / total, 4) if total else 0.0,
				"houses": len(p["houses"]),
				"products": sorted(
					({"item_code": c, "item_name": names.get(c, c), "value": round(v, 2)} for c, v in p["products"].items()),
					key=lambda x: -x["value"],
				),
			}
			for t, p in per_target.items()
		),
		key=lambda x: (-x["value"], x["target"]),
	)

	unattributed_out = sorted(
		(
			{"farm": fm, "greenhouse": gh, "kind": k, "reason": rs, "value": round(v, 2)}
			for (fm, gh, k, rs), v in unattributed.items()
		),
		key=lambda x: -x["value"],
	)

	by_product = sorted(
		(
			{
				"item_code": p["item_code"],
				"item_name": p["item_name"],
				"kind": p["kind"],
				"value": round(p["value"], 2),
				"attributed": round(p["attributed"], 2),
				"unattributed": round(p["unattributed"], 2),
				"targets": sorted(
					({"target": t, "value": round(v, 2)} for t, v in p["targets"].items()),
					key=lambda x: -x["value"],
				),
			}
			for p in per_product.values()
		),
		key=lambda x: -x["value"],
	)

	by_place = sorted(
		(
			{
				"farm": fm,
				"greenhouse": gh,
				"value": round(p["value"], 2),
				"attributed": round(p["attributed"], 2),
				"unattributed": round(p["unattributed"], 2),
			}
			for (fm, gh), p in per_place.items()
		),
		key=lambda x: (x["farm"], -x["value"]),
	)

	by_period = [
		{
			"period": k,
			"value": round(p["value"], 2),
			"attributed": round(p["attributed"], 2),
			"unattributed": round(p["unattributed"], 2),
		}
		for k, p in sorted(per_period.items())
	]

	# Greenhouse x target matrix per farm, attributed spend only; each row's
	# remainder (its Unattributed) is the gap to by_place.
	farms_out = []
	for f in sorted(farm_cells):
		rows = farm_cells[f]
		targets = sorted({t for cells in rows.values() for t in cells})
		target_totals = dict.fromkeys(targets, 0.0)
		rows_out = []
		for (gh, kind) in sorted(rows):
			cells = rows[(gh, kind)]
			for t, v in cells.items():
				target_totals[t] += v
			rows_out.append({
				"greenhouse": gh,
				"kind": kind,
				"costs": {t: round(cells.get(t, 0.0), 2) for t in targets},
				"total": round(sum(cells.values()), 2),
			})
		farms_out.append({
			"farm": f,
			"targets": targets,
			"rows": rows_out,
			"target_totals": {t: round(v, 2) for t, v in target_totals.items()},
			"total": round(sum(target_totals.values()), 2),
		})

	return {
		"as_of": now_datetime().isoformat(timespec="seconds"),
		"currency": frappe.db.get_default("currency") or "KES",
		"granularity": granularity,
		"item_names": names,
		"grand_total": round(total, 2),
		"attributed_total": round(attributed_total, 2),
		"unattributed_total": round(unattributed_total, 2),
		"unattributed_share": round(unattributed_total / total, 4) if total else 0.0,
		"totals_by_kind": {k: round(v, 2) for k, v in totals_by_kind.items()},
		"cost_per_target": cost_per_target,
		"by_basis": [
			{"basis": b, "value": round(basis_totals[b], 2), "share": round(basis_totals[b] / total, 4) if total else 0.0}
			for b in FA.BASES
		],
		"unattributed": unattributed_out,
		"by_product": by_product,
		"by_place": by_place,
		"by_period": by_period,
		"farms": farms_out,
		"no_valuation": no_valuation,
		"ledger_fallback_lines": ledger_fallback,
		"reconciliation": {
			"total": round(total, 2),
			"targets": round(attributed_total, 2),
			"unattributed": round(unattributed_total, 2),
			"difference": round(total - attributed_total - unattributed_total, 2),
		},
	}


@frappe.whitelist()
def chemical_cost_by_target(
	from_date: str, to_date: str, farm: str | None = None, crop: str | None = None
) -> dict:
	"""Crop-protection spend for the period, allocated to pests and diseases.

	``crop`` (the route crop) limits the farms to that crop's, intersected with
	the farms the user may see."""
	_ensure_finance_role()
	farm_scope = None
	if crop:
		canon = crop_catalog.resolve_crop(crop)
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

	kinds = FA.valid_targets_and_kinds()
	codes = {r["item_code"] for r in lines}
	return _build(
		lines,
		classify=crop_protection.classify_item_group,
		is_wip=_wip_matcher(),
		facts=FA.product_facts(codes, FA.radar(end=to_date, kinds=kinds)),
		kinds=kinds,
		farm_scope=farm_scope,
		farm=farm or None,
		granularity=_granularity(from_date, to_date),
	)
