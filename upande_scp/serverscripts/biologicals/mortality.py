"""Expected predator mortality from sprays: a labelled ESTIMATE.

For every completed spray on a greenhouse, how many of the predators released
there (inside the presence window before the spray) the mix is expected to kill:
released quantity x the mix's combined mortality for that predator. Mortality
comes from `Active Ingredient Predator Impact` (IOBC class midpoints unless a
measured value is cited), so the result is "expected", never a count of dead mites.

A release is a pool that every later spray draws down (remaining x mortality), so
two sprays in a week do not each claim the whole release. Pure logic here;
`load_*` read the database.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import frappe
from frappe.utils import flt, getdate

LABEL = "Expected mortality: released quantity x ingredient mortality (IOBC class estimate). Not a count of dead animals."


def _dt(s):
	return datetime.strptime(str(s)[:19], "%Y-%m-%d %H:%M:%S")


def combined_mortality(percentages) -> float:
	"""Independent kills compound: 1 - prod(1 - m). `percentages` are 0-100."""
	survive = 1.0
	for m in percentages:
		survive *= 1 - min(max(flt(m), 0.0), 100.0) / 100.0
	return round((1 - survive) * 100, 2)


def expected_kills(releases, sprays, days) -> list[dict]:
	"""releases = [{id, greenhouse, predator, stage, qty, uom, when}]
	sprays   = [{wo, greenhouse, when, products, mortality: {predator: [pct per product]}}]
	Returns one row per spray x predator that met live releases, in spray order."""
	pools = {}
	for r in sorted(releases, key=lambda r: r["when"]):
		pools.setdefault((r["greenhouse"], r["predator"]), []).append(
			{**r, "left": flt(r["qty"])})
	out = []
	for s in sorted(sprays, key=lambda s: s["when"]):
		when = _dt(s["when"])
		for predator, pcts in sorted((s.get("mortality") or {}).items()):
			pool = pools.get((s["greenhouse"], predator)) or []
			live = [p for p in pool if p["left"] > 0 and when - timedelta(days=days) <= _dt(p["when"]) <= when]
			if not live:
				continue
			m = combined_mortality(pcts)
			if m <= 0:
				continue
			present = sum(p["left"] for p in live)
			killed = 0.0
			for p in live:
				k = p["left"] * m / 100.0
				p["left"] -= k
				killed += k
			out.append({"wo": s["wo"], "when": s["when"], "greenhouse": s["greenhouse"], "predator": predator,
			            "present": round(present, 2), "mortality_pct": m, "expected_kill": round(killed, 2),
			            "uom": live[0].get("uom") or "", "products": s["products"],
			            "releases": [p["id"] for p in live]})
	return out


def summarise(rows) -> dict:
	by_pred, by_gh = {}, {}
	for r in rows:
		by_pred[r["predator"]] = by_pred.get(r["predator"], 0) + r["expected_kill"]
		by_gh[r["greenhouse"]] = by_gh.get(r["greenhouse"], 0) + r["expected_kill"]
	r2 = lambda d: {k: round(v, 2) for k, v in sorted(d.items())}
	return {"by_predator": r2(by_pred), "by_greenhouse": r2(by_gh),
	        "total": round(sum(by_pred.values()), 2)}


# --- database ---------------------------------------------------------------

def _houses(greenhouse=None, farm=None):
	if greenhouse:
		return [greenhouse]
	filters = {"custom_farm": farm} if farm else {"custom_farm": ["is", "set"]}
	return frappe.get_all("Warehouse", filters=filters, pluck="name")


def load_releases(from_date, to_date, houses, until=None) -> list[dict]:
	"""Submitted releases from `from_date` minus a presence window (so a release just before
	the period still counts against sprays inside it) to `to_date`."""
	if not houses:
		return []
	return [{"id": r.name, "greenhouse": r.greenhouse, "predator": r.predator, "stage": r.stage or "",
	         "qty": flt(r.quantity), "uom": r.uom, "when": str(r.released_at)[:19]}
	        for r in frappe.db.sql("""select name, greenhouse, predator, stage, quantity, uom, released_at
	                                  from `tabBiological Release`
	                                  where docstatus=1 and greenhouse in %(h)s
	                                    and released_at between %(a)s and %(b)s order by released_at""",
	                               {"h": tuple(houses), "a": from_date, "b": until or to_date}, as_dict=True)]


def load_sprays(from_date, to_date, houses) -> list[dict]:
	"""Completed spray plans in the period, each with the per-predator mortality of its mix."""
	if not houses:
		return []
	rows = frappe.db.sql("""select wo.name wo, wo.custom_greenhouse greenhouse,
	                               wo.custom_scheduled_application_time `when`, wi.item_code
	                        from `tabWork Order` wo join `tabWork Order Item` wi on wi.parent = wo.name
	                        where wo.custom_type='Application Floor Plan' and wo.workflow_state='Completed'
	                          and wo.custom_greenhouse in %(h)s
	                          and wo.custom_scheduled_application_time between %(a)s and %(b)s
	                        order by wo.custom_scheduled_application_time, wo.name, wi.idx""",
	                     {"h": tuple(houses), "a": from_date, "b": to_date}, as_dict=True)
	from upande_scp.serverscripts.spray_compliance import context as C
	by, order = {}, []
	for r in rows:
		if r.wo not in by:
			by[r.wo] = {"wo": r.wo, "greenhouse": r.greenhouse, "when": str(r.when)[:19], "items": []}
			order.append(by[r.wo])
		by[r.wo]["items"].append(r.item_code)
	impacts = C.load_impacts(sorted({i for s in order for i in s["items"]}))
	products = C.load_products({i for s in order for i in s["items"]})
	for s in order:
		mort = {}
		for item in dict.fromkeys(s["items"]):
			best = {}
			for imp in impacts.get(item, []):
				best[imp["predator"]] = max(best.get(imp["predator"], 0), imp["mortality"])
			for predator, pct in best.items():
				if pct > 0:
					mort.setdefault(predator, []).append(pct)
		s["mortality"] = mort
		s["products"] = [(products.get(i) or {}).get("name") or i for i in dict.fromkeys(s["items"])]
	return order


@frappe.whitelist()
def mortality_report(from_date=None, to_date=None, greenhouse=None, farm=None, crop="Rose"):
	"""Expected kill per completed spray x predator present, per greenhouse over time (roses)."""
	from upande_scp.serverscripts.spray_compliance import context as C
	from upande_scp.serverscripts.sprayers import api as sprayers_api
	sc = sprayers_api.scope(crop)
	to_d = getdate(to_date) if to_date else getdate()
	from_d = getdate(from_date) if from_date else to_d - timedelta(days=90)
	houses = _houses(greenhouse, farm)
	if sc["farms"] is not None:
		allowed = set(frappe.get_all("Warehouse", filters={"custom_farm": ["in", sorted(sc["farms"]) or [""]]}, pluck="name"))
		houses = [h for h in houses if h in allowed]
	days = C.presence_days(crop)
	a = f"{from_d} 00:00:00"
	b = f"{to_d} 23:59:59"
	releases = load_releases(f"{from_d - timedelta(days=days)} 00:00:00", b, houses)
	rows = expected_kills(releases, load_sprays(a, b, houses), days)
	return {"label": LABEL, "from_date": str(from_d), "to_date": str(to_d), "presence_days": days,
	        "rows": rows, **summarise(rows)}
