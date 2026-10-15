"""Ranked "Suggested products" for the Application Floor Plan.

Once the creator has picked targets and greenhouse(s), the page should not make
them scroll the whole chemical list. This module answers: which products could
go in this tank *right now*, best first.

Nothing here re-implements a rule. Compliance is `engine.evaluate_candidates`
(the same call the Add-chemical picker uses), per greenhouse, so a product is
judged on target match, FRAC/IRAC rotation, max sprays, known resistance and
tank-mix incompatibility with what is already in the mix, under the crop's own
per-rule modes (Off / Warn / Block (GM override) / Block). Stock is
`reservations.get_item_availability`, so reservations, usable batches and the
effective valuation rate (`batch_stock.effective_valuation`) are exactly what the
floor plan's own batch picker shows.

Ranking (0-100, shown as 1-5 dots):

    coverage   50  share of the selected targets the product is registered for
    rotation   20  days since this product was last sprayed on these greenhouses,
                   against the longest history window (never in window = full)
    stock      15  usable batches in the source store: min(n, 3) / 3 of it
                   (an item that is not batch-tracked scores the full 15 once
                   it has free stock)
    cost       15  cheaper than its rivals scores higher; unknown cost = half

Compliance does not add points, it sorts: products that pass every check come
first, ordered by score; products that only trip a Warn / GM rule follow, each
with its warning; a product that trips a hard Block, or that cannot be issued
(no free stock, or a batch-tracked item with no usable batch), is not listed.
"""

from __future__ import annotations

from datetime import datetime

W_COVERAGE, W_ROTATION, W_STOCK, W_COST = 50.0, 20.0, 15.0, 15.0
LIMIT = 12
_SEVERITY = {"Off": 0, "Warn": 1, "Block (GM override)": 2, "Block": 3}


def dots(score: float) -> int:
	"""1-5 dots for a 0-100 score."""
	return max(1, min(5, int(-(-float(score) // 20))))


def stock_points(tracked: bool, usable_batches: int) -> float:
	if not tracked:
		return W_STOCK
	return W_STOCK * min(int(usable_batches), 3) / 3.0


def rotation_points(days_since, window_days) -> float:
	"""Full marks when never used in the window; otherwise grows with the gap."""
	if days_since is None:
		return W_ROTATION
	window = max(float(window_days or 0), 1.0)
	return W_ROTATION * max(0.0, min(float(days_since) / window, 1.0))


def cost_points(cost, costs) -> float:
	"""`costs` = every candidate's known cost per ha. Unknown cost = half marks."""
	known = sorted(c for c in costs if c)
	if not cost or len(known) < 2:
		return W_COST / 2
	lo, hi = known[0], known[-1]
	if hi <= lo:
		return W_COST
	return W_COST * (hi - cost) / (hi - lo)


def coverage_points(covered: int, wanted: int) -> float:
	return W_COVERAGE * covered / wanted if wanted else 0.0


def last_used_days(item, histories, now):
	"""Days since `item` last appeared in any greenhouse's history, else None."""
	best = None
	for history in histories:
		for h in history:
			if item in h["items"]:
				d = (now - datetime.strptime(str(h["when"])[:19], "%Y-%m-%d %H:%M:%S")).total_seconds() / 86400
				best = d if best is None else min(best, d)
	return None if best is None else max(int(best), 0)


def reason_line(covered, wanted, days, window, batches, tracked, cost_per_ha) -> str:
	parts = [f"covers {covered} of {wanted} target{'s' if wanted != 1 else ''}"]
	parts.append(f"last used {days} day{'s' if days != 1 else ''} ago" if days is not None
	             else f"not used in {int(window)} days")
	parts.append(f"in stock, {batches} usable batch{'es' if batches != 1 else ''}" if tracked
	             else "in stock")
	if cost_per_ha:
		parts.append(f"about {cost_per_ha:,.0f} per ha")
	return " · ".join(parts)


def merge_verdicts(per_greenhouse: list[list[dict]]) -> dict:
	"""One verdict per item across greenhouses: eligible only if eligible everywhere;
	reasons and rules unioned; the worst mode wins."""
	out: dict = {}
	for rows in per_greenhouse:
		for r in rows:
			m = out.setdefault(r["item"], {**r, "reasons": [], "rules": []})
			m["eligible"] = m["eligible"] and r["eligible"]
			if _SEVERITY.get(r["worst_mode"], 0) > _SEVERITY.get(m["worst_mode"], 0):
				m["worst_mode"] = r["worst_mode"]
			for k in ("reasons", "rules"):
				for x in r[k]:
					if x not in m[k]:
						m[k].append(x)
	return out


def rank(entries: list[dict]) -> list[dict]:
	"""Passing products first, then warned ones; best score first inside each group."""
	return sorted(entries, key=lambda e: (not e["eligible"], _SEVERITY.get(e["worst_mode"], 0) if not e["eligible"] else 0,
	                                      -e["score"], e["item_name"].lower()))


def _clean(v):
	return [x.strip() for x in (v or []) if x and str(x).strip()]


def _candidates(targets) -> list[str]:
	"""Spray Products registered for at least one selected target. A product with no
	registered target never appears (see `rules.is_untargeted`)."""
	import frappe
	return frappe.db.sql_list(
		"""select distinct sp.name from `tabSpray Product` sp
		   join `tabChemical Targets` t on t.parent = sp.name and t.parenttype = 'Spray Product'
		        and t.parentfield = 'default_targets'
		   where ifnull(sp.disabled, 0) = 0
		     and coalesce(nullif(t.pest, ''), nullif(t.disease, '')) in %(t)s""",
		{"t": tuple(targets)})


def build_suggestions(targets, greenhouses, source_warehouse, current_items=None, crop=None, when=None,
                      limit=LIMIT) -> dict:
	import frappe
	from ..common import crop_protection as CP
	from ..spray_plan_creator import crop_settings
	from ..spray_plan_creator.reservations import get_item_availability
	from ..store.batch_stock import batch_valuations
	from . import context as C
	from . import engine as E
	from . import rules as R

	targets, greenhouses = _clean(targets), _clean(greenhouses)
	mix = _clean(current_items)
	out = {"suggestions": [], "considered": 0, "unavailable": 0, "blocked": 0, "needs": None}
	if not targets:
		out["needs"] = "targets"
	elif not greenhouses:
		out["needs"] = "greenhouse"
	elif not source_warehouse:
		out["needs"] = "store"
	if out["needs"]:
		return out

	cands = [c for c in _candidates(targets) if c not in mix]
	ctxs = [C.build_context(greenhouse=g, targets=targets, mix=mix, crop=crop or None, when=when)
	        for g in greenhouses]
	ctxs[0]["products"].update(C.load_products([c for c in cands if c not in ctxs[0]["products"]]))
	# Foliars, adjuvants and pH buffers are not pest control: never suggested for targets.
	cands = [c for c in cands if not R.is_non_target(ctxs[0]["products"].get(c))
	         and not R.is_untargeted(ctxs[0]["products"].get(c))]
	for ctx in ctxs[1:]:
		ctx["products"].update({k: v for k, v in ctxs[0]["products"].items() if k not in ctx["products"]})
	verdicts = merge_verdicts([E.evaluate_candidates(ctx, cands) for ctx in ctxs])
	out["considered"] = len(verdicts)

	live = {i: v for i, v in verdicts.items() if v["worst_mode"] != E.BLOCK}
	out["blocked"] = len(verdicts) - len(live)
	avail = get_item_availability(source_warehouse, sorted(live)) if live else {}

	usable, free = {}, {}
	for item, a in avail.items():
		bs = [b for b in a["batches"] if not b["zero_valued"] and not b["expired"] and b["available"] > 1e-6]
		usable[item] = bs
		free[item] = a["ledger"] - a["reserved"]
	stocked = [i for i, a in avail.items()
	           if (usable[i] if a["has_batch_no"] else free[i] > 1e-6)]
	out["unavailable"] = len(live) - len(stocked)

	val = batch_valuations([(i, usable[i][0]["batch_no"], source_warehouse)
	                        for i in stocked if avail[i]["has_batch_no"] and usable[i]])
	bin_rate = {r.item_code: float(r.valuation_rate or 0) for r in frappe.get_all(
		"Bin", filters={"warehouse": source_warehouse, "item_code": ["in", stocked or [""]]},
		fields=["item_code", "valuation_rate"])}
	crop_name = ctxs[0]["crop"]
	window = max(int(crop_settings.value_for("irac_rotation_window_days", crop_name) or 0),
	             int(crop_settings.value_for("frac_rotation_window_days", crop_name) or 0), 30)
	now = datetime.strptime(ctxs[0]["now"], "%Y-%m-%d %H:%M:%S")
	histories = [c["history"] for c in ctxs]

	rows = {}
	for item in stocked:
		p = ctxs[0]["products"].get(item) or {}
		rate = CP.get_product_rate(item, crop_name)[0]
		rate = float(rate) if rate else None
		if avail[item]["has_batch_no"] and usable[item]:
			v = val.get((item, usable[item][0]["batch_no"], source_warehouse))
			unit = v["rate"] if v and v["rate"] > 0 else bin_rate.get(item, 0.0)
		else:
			unit = bin_rate.get(item, 0.0)
		rows[item] = {"p": p, "rate": rate, "cost": rate * unit if rate and unit else None}
	costs = [r["cost"] for r in rows.values()]

	entries = []
	for item, r in rows.items():
		v, p, a = live[item], r["p"], avail[item]
		covered = [t for t in targets if t in (p.get("targets") or [])]
		days = last_used_days(item, histories, now)
		nb = len(usable[item])
		score = (coverage_points(len(covered), len(targets)) + rotation_points(days, window)
		         + stock_points(bool(a["has_batch_no"]), nb) + cost_points(r["cost"], costs))
		info = frappe.db.get_value("Item", item, ["item_name", "stock_uom", "item_group"], as_dict=True) or {}
		entries.append({
			"item_code": item, "item_name": info.get("item_name") or p.get("name") or item,
			"stock_uom": info.get("stock_uom"), "item_group": info.get("item_group"),
			"uoms": CP.item_uom_options(item), "is_fertilizer": False,
			"default_rate": r["rate"], "score": round(score, 1), "dots": dots(score),
			"eligible": v["eligible"], "worst_mode": v["worst_mode"], "warnings": v["reasons"],
			"rules": v["rules"], "codes": v["codes"],
			"covered_targets": covered, "last_used_days": days, "usable_batches": nb,
			"batch_tracked": bool(a["has_batch_no"]), "free_qty": round(free[item], 4),
			"cost_per_ha": round(r["cost"], 2) if r["cost"] else None,
			"reason": reason_line(len(covered), len(targets), days, window, nb, bool(a["has_batch_no"]),
			                      r["cost"]),
		})
	out["suggestions"] = rank(entries)[:limit]
	return out
