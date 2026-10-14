"""Crop-protection finance, redesigned: two tunnels, each attributed to pests.

  SPRAY PLAN path. A plan counts only if it went through to the end: its Work Order
  has a submitted Manufacture entry AND a submitted Material Issue of the tank mix
  out of a greenhouse warehouse with a cost centre. (Mona's end-of-spray endpoint
  builds that Material Issue without a work_order, so it is matched back to the
  Manufacture by greenhouse, tank-mix item and quantity, earliest first.)
  Spend is the stock-ledger value of the chemicals the Manufacture consumed
  (its raw-material lines). Why not the Material Issue: that issue is valued at the
  greenhouse warehouse's moving average of the generic tank-mix item, which carries
  earlier mixes, so it does not equal what this plan consumed. The Manufacture's raw
  lines are the chemicals leaving the CSU at their cost, and by construction they sum
  to the tank-mix's finished-good value.
  Greenhouse = the warehouse the tank mix was issued from; period = the date of that issue.
  Plans not completed are excluded and reported in `in_progress`.

  DIRECT path. Material Issues with no work order for chemical / foliar items, tagged by
  whether they came from a Material Request. The greenhouse is unknown, so they are
  reported at farm level with their cost centre.

Attribution is `finance_attribution.allocate`; non-pest cost groups (foliar, adjuvant, pH buffer, hygiene, post-harvest) are reported separately.
"""

from __future__ import annotations

import re
from collections import defaultdict
from datetime import datetime, timedelta

import frappe
from frappe.utils import add_days, flt, getdate, today

from upande_scp.serverscripts.common import crop_protection
from upande_scp.serverscripts.reports import finance_attribution as FAT

AFP_TYPE = "Application Floor Plan"
FARM_LEVEL = "Farm level — issue has no greenhouse"
UNATTRIBUTED = "Unattributed"
NONPEST = "Non-pest inputs"
MATCH_DAYS = 30
EXCLUDED_TYPES = ("Chemical Loaning", "Chemical Mixing")
PATHS = ("spray", "direct")


# --- Completed-plan detection ----------------------------------------------------


def _dt(date, time=None):
	d = getdate(date)
	t = time
	if isinstance(t, timedelta):
		return datetime.combine(d, datetime.min.time()) + t
	if t is None:
		return datetime.combine(d, datetime.min.time())
	if isinstance(t, str):
		try:
			t = datetime.strptime(t.split(".")[0], "%H:%M:%S").time()
		except ValueError:
			return datetime.combine(d, datetime.min.time())
	return datetime.combine(d, t)


def match_completed(manufactures, issues, max_days: int = MATCH_DAYS) -> dict:
	"""{wo: issue} for every Manufacture that has a matching tank-mix Material Issue.

	manufactures: [{wo, name, dt, item, warehouse, qty}]; issues: [{name, dt, item, warehouse, qty, ...}].
	An issue matches the earliest-unmatched Manufacture of the same tank-mix item out of the
	same warehouse with the same quantity, posted on or after it (within `max_days`)."""
	pool: dict = defaultdict(list)
	for i in sorted(issues, key=lambda x: x["dt"]):
		pool[(i["warehouse"], i["item"])].append(i)
	used = set()
	out = {}
	for m in sorted(manufactures, key=lambda x: x["dt"]):
		for i in pool.get((m["warehouse"], m["item"]), []):
			if i["name"] in used or i["dt"] < m["dt"] or (i["dt"] - m["dt"]).days > max_days:
				continue
			if abs(flt(i["qty"]) - flt(m["qty"])) > 1e-6:
				continue
			used.add(i["name"])
			out[m["wo"]] = i
			break
	return out


# --- Data collection ---------------------------------------------------------------

_MANUFACTURES = """
	SELECT se.name, se.work_order AS wo, se.posting_date, se.posting_time,
	       fg.item_code AS item, fg.t_warehouse AS warehouse, fg.transfer_qty AS qty
	FROM `tabStock Entry` se
	JOIN `tabWork Order` wo ON wo.name = se.work_order AND wo.custom_type = %(afp)s
	JOIN `tabStock Entry Detail` fg ON fg.parent = se.name AND fg.is_finished_item = 1
	WHERE se.docstatus = 1 AND se.purpose = 'Manufacture'
	  AND se.posting_date BETWEEN %(a)s AND %(b)s
"""

_ISSUES = """
	SELECT se.name, se.posting_date, se.posting_time, sed.item_code AS item, sed.s_warehouse AS warehouse,
	       sed.transfer_qty AS qty, sed.cost_center
	FROM `tabStock Entry` se
	JOIN `tabStock Entry Detail` sed ON sed.parent = se.name
	WHERE se.docstatus = 1 AND se.purpose = 'Material Issue' AND IFNULL(se.work_order, '') = ''
	  AND sed.item_code IN %(items)s AND IFNULL(sed.cost_center, '') != ''
	  AND se.posting_date BETWEEN %(a)s AND %(b)s
"""

_RAW = """
	SELECT sed.parent AS se_name, sed.name AS detail, sed.item_code, sed.transfer_qty AS qty, sed.stock_uom, sed.amount AS line_amount,
	       sle.val AS ledger_value, i.item_group, i.item_name
	FROM `tabStock Entry Detail` sed
	JOIN `tabItem` i ON i.name = sed.item_code
	LEFT JOIN (
		SELECT voucher_detail_no, SUM(-stock_value_difference) AS val
		FROM `tabStock Ledger Entry`
		WHERE voucher_type = 'Stock Entry' AND is_cancelled = 0 AND actual_qty < 0
		  AND posting_date BETWEEN %(a)s AND %(b)s
		GROUP BY voucher_detail_no
	) sle ON sle.voucher_detail_no = sed.name
	WHERE sed.parent IN %(se)s AND IFNULL(sed.is_finished_item, 0) = 0 AND i.item_group IN %(groups)s
"""


def _farm_of(warehouse, cache):
	if warehouse not in cache:
		cache[warehouse] = (
			frappe.db.get_value("Warehouse", warehouse, "custom_farm")
			if warehouse and frappe.db.has_column("Warehouse", "custom_farm")
			else None
		)
	return cache[warehouse]


def collect_spray(from_date, to_date, groups, kinds) -> dict:
	"""Lines of completed plans whose final Material Issue is in the period, plus the
	in-progress note. Returns {"lines": [...], "plans": n, "in_progress": {...}}."""
	a, b = str(add_days(from_date, -MATCH_DAYS)), str(to_date)
	manufactures = frappe.db.sql(_MANUFACTURES, {"afp": AFP_TYPE, "a": a, "b": b}, as_dict=True)
	if not manufactures:
		return {"lines": [], "plans": 0, "in_progress": _in_progress(from_date, to_date, groups, set(), {})}
	items = tuple({m["item"] for m in manufactures})
	issue_end = min(str(add_days(to_date, MATCH_DAYS)), str(getdate(today())))
	# The explicit link (owned by another change): Stock Entry.custom_spray_plan, with its
	# custom_spray_link_basis. Used when present; otherwise the greenhouse/item/qty/date match below.
	has_link = frappe.db.has_column("Stock Entry", "custom_spray_plan")
	has_basis = frappe.db.has_column("Stock Entry", "custom_spray_link_basis")
	extra = ""
	if has_link:
		extra += ", se.custom_spray_plan AS link_wo"
	if has_basis:
		extra += ", se.custom_spray_link_basis AS link_basis"
	issues = frappe.db.sql(_ISSUES.replace("sed.cost_center", "sed.cost_center" + extra, 1),
	                       {"items": items, "a": a, "b": issue_end}, as_dict=True)
	for m in manufactures:
		m["dt"] = _dt(m["posting_date"], m["posting_time"])
	for i in issues:
		i["dt"] = _dt(i["posting_date"], i["posting_time"])
	linked = {}
	if has_link:
		by_wo_early = {m["wo"] for m in manufactures}
		for i in issues:
			if i.get("link_wo") in by_wo_early and i["link_wo"] not in linked:
				i["basis"] = i.get("link_basis") or "Direct"
				linked[i["link_wo"]] = i
	rest_m = [m for m in manufactures if m["wo"] not in linked]
	rest_i = [i for i in issues if i["name"] not in {x["name"] for x in linked.values()} and not i.get("link_wo")]
	done = match_completed(rest_m, rest_i)
	for i in done.values():
		i["basis"] = "Greenhouse+date (matched)"
	done.update(linked)
	by_wo = {m["wo"]: m for m in manufactures}

	wo_rows = {
		r.name: r
		for r in frappe.db.sql(
			"""SELECT name, custom_targets AS targets, custom_cost_center, company FROM `tabWork Order`
			   WHERE name IN %(n)s""",
			{"n": tuple(by_wo)},
			as_dict=True,
		)
	}
	rec: dict = {}
	for r in frappe.db.sql(
		"""SELECT parent, item_code, custom_targets FROM `tabWork Order Item` WHERE parent IN %(n)s""",
		{"n": tuple(by_wo)},
		as_dict=True,
	):
		if r.custom_targets and (r.parent, r.item_code) not in rec:
			rec[(r.parent, r.item_code)] = FAT_split(r.custom_targets, kinds)

	in_window = {wo: i for wo, i in done.items() if str(from_date) <= str(i["posting_date"])[:10] <= str(to_date)}
	raw_by_se: dict = defaultdict(list)
	if in_window and groups:
		se_names = tuple({by_wo[wo]["name"] for wo in in_window})
		lo = str(min(by_wo[wo]["posting_date"] for wo in in_window))
		hi = str(max(by_wo[wo]["posting_date"] for wo in in_window))
		for r in frappe.db.sql(_RAW, {"a": lo, "b": hi, "se": se_names, "groups": groups}, as_dict=True):
			raw_by_se[r["se_name"]].append(r)
	lines = []
	farms: dict = {}
	for wo, issue in in_window.items():
		m = by_wo[wo]
		w = wo_rows.get(wo)
		fm = _farm_of(issue["warehouse"], farms)
		for r in raw_by_se.get(m["name"], []):
			ledger = r["ledger_value"] is not None
			lines.append({
				"path": "spray", "date": str(issue["posting_date"])[:10], "document": m["name"],
				"issue": issue["name"], "work_order": wo, "mr": None, "link_basis": issue.get("basis"), "greenhouse": issue["warehouse"],
				"farm": fm, "cost_center": issue["cost_center"] or (w.custom_cost_center if w else None),
				"item_code": r["item_code"], "item_name": r["item_name"], "qty": flt(r["qty"]), "uom": r["stock_uom"],
				"value": flt(r["ledger_value"]) if ledger else flt(r["line_amount"]),
				"ledger": ledger, "detail": r["detail"],
				"plan_targets": FAT_split(w.targets if w else "", kinds),
				"recorded": rec.get((wo, r["item_code"])) or [],
			})
	not_issued = [
		{"work_order": m["wo"], "manufacture": m["name"], "date": str(m["posting_date"])[:10], "greenhouse": m["warehouse"]}
		for m in manufactures
		if m["wo"] not in done and str(from_date) <= str(m["posting_date"])[:10] <= str(to_date)
	]
	by_link: dict = defaultdict(int)
	for wo, i in in_window.items():
		by_link["from_link" if wo in linked else "fallback_match"] += 1
	return {
		"by_link": dict(by_link),
		"manufactured": sum(1 for m in manufactures if str(from_date) <= str(m["posting_date"])[:10] <= str(to_date)),
		"not_issued": not_issued,
		"lines": lines,
		"plans": len({ln["work_order"] for ln in lines}),
		"in_progress": _in_progress(from_date, to_date, groups, set(done), by_wo),
	}


def FAT_split(value, kinds):
	out = []
	for t in (value or "").split("\n"):
		t = t.strip()
		if t and t in kinds and t not in out:
			out.append(t)
	return out


def _in_progress(from_date, to_date, groups, completed: set, manufactured: dict) -> dict:
	"""Chemicals sent to a CSU in the period for plans that are not completed."""
	if not groups:
		return {"plans": 0, "value": 0.0}
	rows = frappe.db.sql(
		"""
		SELECT se.work_order AS wo, SUM(sle.val) AS value
		FROM `tabStock Entry` se
		JOIN `tabWork Order` wo ON wo.name = se.work_order AND wo.custom_type = %(afp)s
		JOIN `tabStock Entry Detail` sed ON sed.parent = se.name
		JOIN `tabItem` i ON i.name = sed.item_code AND i.item_group IN %(groups)s
		JOIN (
			SELECT voucher_detail_no, SUM(-stock_value_difference) AS val FROM `tabStock Ledger Entry`
			WHERE voucher_type = 'Stock Entry' AND is_cancelled = 0 AND actual_qty < 0
			  AND posting_date BETWEEN %(f)s AND %(t)s GROUP BY voucher_detail_no
		) sle ON sle.voucher_detail_no = sed.name
		WHERE se.docstatus = 1 AND se.purpose = 'Material Transfer for Manufacture'
		  AND se.posting_date BETWEEN %(f)s AND %(t)s
		GROUP BY se.work_order
		""",
		{"afp": AFP_TYPE, "f": str(from_date), "t": str(to_date), "groups": groups},
		as_dict=True,
	)
	rows = [r for r in rows if r.wo not in completed]
	return {"plans": len(rows), "value": round(sum(flt(r.value) for r in rows), 2)}


_DIRECT = """
	SELECT se.name AS document, se.posting_date, se.company, sed.name AS detail, sed.s_warehouse,
	       sed.item_code, sed.transfer_qty AS qty, sed.stock_uom, sed.amount AS line_amount, sed.cost_center,
	       sed.material_request, sle.val AS ledger_value, i.item_group, i.item_name
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
	WHERE se.docstatus = 1 AND se.purpose = 'Material Issue' AND IFNULL(se.work_order, '') = ''
	  AND IFNULL(se.stock_entry_type, '') NOT IN %(excluded)s
	  AND se.posting_date BETWEEN %(f)s AND %(t)s
	  AND i.item_group IN %(groups)s
	ORDER BY se.posting_date, se.name, sed.idx
"""


def collect_direct(from_date, to_date, groups, wip_match) -> list:
	"""Material Issues with no work order for crop-protection items (the tank-mix
	item group is not a chemical group, so completed-plan issues never appear here)."""
	if not groups:
		return []
	rows = frappe.db.sql(
		_DIRECT,
		{"f": str(from_date), "t": str(to_date), "groups": groups, "excluded": EXCLUDED_TYPES + ("",)},
		as_dict=True,
	)
	farms: dict = {}
	out = []
	for r in rows:
		if wip_match(r["s_warehouse"]):
			continue  # out of a CSU: already counted when it went in
		ledger = r["ledger_value"] is not None
		out.append({
			"path": "direct", "date": str(r["posting_date"])[:10], "document": r["document"], "issue": r["document"],
			"work_order": None, "mr": r["material_request"] or None, "link_basis": None, "greenhouse": None,
			"farm": _farm_of(r["s_warehouse"], farms) or r["company"], "cost_center": r["cost_center"],
			"item_code": r["item_code"], "item_name": r["item_name"], "qty": flt(r["qty"]), "uom": r["stock_uom"],
			"value": flt(r["ledger_value"]) if ledger else flt(r["line_amount"]), "ledger": ledger,
			"detail": r["detail"], "plan_targets": None, "recorded": [],
		})
	return out


def wip_matcher():
	from upande_scp.serverscripts.spray_plan_creator.crop_settings import wip_keywords

	patterns = [re.compile(rf"(?<![A-Za-z]){re.escape(w)}(?![A-Za-z])", re.IGNORECASE) for w in wip_keywords()]
	return lambda name: any(p.search(name or "") for p in patterns)


# --- Attribution of lines ---------------------------------------------------------------


def attribute(lines, refs, kb, kinds, products) -> list:
	"""One row per (line, target). Foliar-farm / unattributed lines get a single pseudo-target row.
	Row values sum to the line value exactly (the last share absorbs rounding)."""
	rows = []
	for ln in lines:
		if not ln["value"]:
			continue
		prod = products.get(ln["item_code"]) or {"code": ln["item_code"], "name": ln["item_name"]}
		uses = (refs.get("uses") or {}).get(ln["item_code"], 0)
		alloc = FAT.allocate(
			prod,
			ln["plan_targets"] if ln["path"] == "spray" else None,
			refs, kb, kinds,
			on_date=ln["date"], exclude_wo=ln.get("work_order"), recorded=ln.get("recorded"),
		)
		basis = alloc["basis"]
		cred = FAT.credibility(basis, ln["path"])
		shares = alloc["shares"]
		if not shares:
			shares = {alloc.get("group") or UNATTRIBUTED if basis in FAT.FOLIAR_BASES else UNATTRIBUTED: 1.0}
		items = list(shares.items())
		value = round(ln["value"], 2)
		left = value
		for n, (t, share) in enumerate(items):
			v = left if n == len(items) - 1 else round(value * share, 2)
			left = round(left - v, 2)
			rows.append({**{k: ln[k] for k in (
				"path", "date", "document", "issue", "work_order", "mr", "link_basis", "greenhouse", "farm", "cost_center",
				"item_code", "item_name", "qty", "uom", "ledger", "detail")}, "value": value,
				"target": t, "kind": kinds.get(t), "share": share, "basis": basis, "attributed": v,
				"group": alloc.get("group") or FAT.PEST_CONTROL, "plan_uses": uses, "credibility": cred["kind"], "credibility_label": cred["label"], "accuracy": cred["accuracy"],
				"is_nonpest": basis in FAT.FOLIAR_BASES})
	return rows


# --- Report ---------------------------------------------------------------------------------


def _r2(x):
	return round(flt(x), 2)


def _block(rows) -> dict:
	"""Totals, by-pest, by-basis and by-product for one path's rows."""
	chem = [r for r in rows if not r["is_nonpest"]]
	fol = [r for r in rows if r["is_nonpest"]]
	pests: dict = {}
	basis_tot: dict = defaultdict(float)
	rec = der = unat = 0.0
	acc_w = acc_v = 0.0
	for r in chem:
		v = r["attributed"]
		basis_tot[r["basis"]] += v
		if r["target"] == UNATTRIBUTED:
			unat += v
			continue
		p = pests.setdefault(r["target"], {"target": r["target"], "kind": r["kind"], "recorded": 0.0, "derived": 0.0,
		                                   "basis": defaultdict(float), "products": defaultdict(float), "acc_w": 0.0})
		if r["credibility"] == "recorded":
			p["recorded"] += v
			rec += v
		else:
			p["derived"] += v
			der += v
			if r["accuracy"] is not None:
				p["acc_w"] += v * r["accuracy"]
				acc_w += v * r["accuracy"]
				acc_v += v
		p["basis"][r["basis"]] += v
		p["products"][(r["item_code"], r["item_name"], r["plan_uses"])] += v
	chem_total = rec + der + unat
	by_pest = sorted(
		(
			{
				"target": p["target"], "kind": p["kind"], "recorded": _r2(p["recorded"]), "derived": _r2(p["derived"]),
				"value": _r2(p["recorded"] + p["derived"]),
				"share": round((p["recorded"] + p["derived"]) / chem_total, 4) if chem_total else 0.0,
				"est_accuracy": round(p["acc_w"] / p["derived"], 4) if p["derived"] and p["acc_w"] else None,
				"basis": {b: _r2(v) for b, v in p["basis"].items()},
				"products": sorted(
					({"item_code": c, "item_name": n, "plan_uses": u, "value": _r2(v)} for (c, n, u), v in p["products"].items()),
					key=lambda x: -x["value"]),
			}
			for p in pests.values()
		),
		key=lambda x: (-x["value"], x["target"]),
	)
	groups: dict = {g: {"group": g, "treatment": FAT.GROUP_TREATMENT[g], "value": 0.0,
	                    "by_target": defaultdict(float), "farm_level": 0.0} for g in FAT.NON_PEST_GROUPS}
	for r in fol:
		g = groups[r["group"]]
		g["value"] += r["attributed"]
		if r["basis"] == "foliar_equal":
			g["by_target"][r["target"]] += r["attributed"]
		else:
			g["farm_level"] += r["attributed"]
	foliar_total = sum(g["value"] for g in groups.values())
	by_basis = [
		{"basis": b, "value": _r2(v), "share": round(v / (chem_total + foliar_total), 4) if (chem_total + foliar_total) else 0.0,
		 **{k: FAT.credibility(b, rows[0]["path"] if rows else "spray")[k] for k in ("kind", "label", "accuracy")}}
		for b in FAT.BASES
		for v in [basis_tot.get(b, 0.0) + (sum(r["attributed"] for r in fol if r["basis"] == b) if b in FAT.FOLIAR_BASES else 0.0)]
		if v
	]
	prods: dict = {}
	for r in rows:
		p = prods.setdefault(r["item_code"], {"item_code": r["item_code"], "item_name": r["item_name"], "value": 0.0,
		                                      "nonpest": r["is_nonpest"], "group": r["group"], "plan_uses": r["plan_uses"], "targets": defaultdict(float), "mr": 0.0})
		p["targets"][r["target"]] += r["attributed"]
		p["value"] += r["attributed"]
		if r.get("mr"):
			p["mr"] += r["attributed"]
	by_product = sorted(
		({"item_code": p["item_code"], "item_name": p["item_name"], "nonpest": p["nonpest"], "group": p["group"], "plan_uses": p["plan_uses"], "value": _r2(p["value"]),
		  "from_mr": _r2(p["mr"]),
		  "targets": sorted(({"target": t, "value": _r2(v)} for t, v in p["targets"].items()), key=lambda x: -x["value"])}
		 for p in prods.values()),
		key=lambda x: -x["value"],
	)
	return {
		"total": _r2(chem_total + foliar_total),
		"chemical": {
			"total": _r2(chem_total), "recorded": _r2(rec), "derived": _r2(der), "unattributed": _r2(unat),
			"derived_accuracy": round(acc_w / acc_v, 4) if acc_v else None,
			"by_pest": by_pest,
		},
		"nonpest": {
			"total": _r2(foliar_total),
			"groups": [
				{"group": g["group"], "treatment": g["treatment"], "value": _r2(g["value"]), "farm_level": _r2(g["farm_level"]),
				 "by_target": sorted(({"target": t, "value": _r2(v)} for t, v in g["by_target"].items()), key=lambda x: -x["value"])}
				for g in groups.values()
			],
		},
		"by_basis": by_basis,
		"by_product": by_product,
	}


def _places(rows, direct: bool) -> list:
	places: dict = {}
	for r in rows:
		key = (r["farm"] or "", r["cost_center"] or "") if direct else (r["farm"] or "", r["greenhouse"] or "", r["cost_center"] or "")
		p = places.setdefault(key, {
			"farm": r["farm"] or "", "greenhouse": FARM_LEVEL if direct else r["greenhouse"],
			"cost_center": r["cost_center"], "chemical": 0.0, "nonpest": 0.0, "targets": defaultdict(float)})
		if r["is_nonpest"]:
			p["nonpest"] += r["attributed"]
		else:
			p["chemical"] += r["attributed"]
			p["targets"][r["target"]] += r["attributed"]
	return sorted(
		({**p, "chemical": _r2(p["chemical"]), "nonpest": _r2(p["nonpest"]), "value": _r2(p["chemical"] + p["nonpest"]),
		  "targets": {t: _r2(v) for t, v in p["targets"].items()}} for p in places.values()),
		key=lambda x: -x["value"],
	)


def collect_rows(from_date, to_date) -> dict:
	"""Everything needed for a report or export, unfiltered by pest / path / greenhouse."""
	groups = crop_protection.product_groups()
	kinds = FAT.valid_targets_and_kinds()
	kb = FAT.load_seed()
	spray = collect_spray(from_date, to_date, groups, kinds) if groups else {"lines": [], "plans": 0, "manufactured": 0, "not_issued": [], "in_progress": {"plans": 0, "value": 0.0}}
	direct = collect_direct(from_date, to_date, groups, wip_matcher())
	lines = spray["lines"] + direct
	products = FAT.raw_products({ln["item_code"] for ln in lines}, kb)
	refs = FAT.reference_data_for(from_date, to_date, kinds, kb)
	rows = attribute(lines, refs, kb, kinds, products)
	return {"rows": rows, "lines": lines, "spray": spray, "kinds": kinds}


def ledger_total(lines) -> float:
	"""Re-derive the ledger value of the source lines straight from the Stock Ledger."""
	names = [ln["detail"] for ln in lines if ln["detail"]]
	total = 0.0
	for i in range(0, len(names), 1000):
		chunk = names[i:i + 1000]
		total += flt(frappe.db.sql(
			"""SELECT SUM(-stock_value_difference) FROM `tabStock Ledger Entry`
			   WHERE voucher_type='Stock Entry' AND is_cancelled=0 AND actual_qty<0
			     AND voucher_detail_no IN %(n)s""", {"n": tuple(chunk)})[0][0])
	return total


def apply_filters(rows, *, paths=PATHS, pests=None, greenhouse=None):
	notes = []
	out = [r for r in rows if r["path"] in paths]
	if greenhouse:
		out = [r for r in out if r["path"] == "spray" and r["greenhouse"] == greenhouse]
		if "direct" in paths:
			notes.append("Direct issues carry no greenhouse, so they are left out while a greenhouse is chosen.")
	if pests:
		want = set(pests)
		out = [r for r in out if (
			r["target"] in want
			or (r["is_nonpest"] and NONPEST in want)
		)]
	return out, notes


def build_report(from_date, to_date, paths=PATHS, pests=None, greenhouse=None, data=None) -> dict:
	data = data or collect_rows(from_date, to_date)
	all_rows = data["rows"]
	rows, notes = apply_filters(all_rows, paths=paths, pests=pests, greenhouse=greenhouse)
	cur = frappe.db.get_default("currency") or "KES"
	out = {
		"filters": {"from": str(from_date), "to": str(to_date), "paths": list(paths), "pests": list(pests or []),
		            "greenhouse": greenhouse or ""},
		"currency": cur, "notes": notes,
		"accuracy": FAT.ACCURACY,
		"pest_options": sorted({r["target"] for r in all_rows if r["target"] != UNATTRIBUTED and not r["is_nonpest"]}),
		"greenhouse_options": sorted({r["greenhouse"] for r in all_rows if r["greenhouse"]}),
	}
	srows = [r for r in rows if r["path"] == "spray"]
	drows = [r for r in rows if r["path"] == "direct"]
	if "spray" in paths:
		b = _block(srows)
		b.update({"path": "spray", "plans_completed": len({r["work_order"] for r in srows}),
		          "in_progress": data["spray"]["in_progress"], "manufactured": data["spray"].get("manufactured", 0), "by_link": data["spray"].get("by_link", {}),
		          "not_issued": data["spray"].get("not_issued", []),
		          "match_method": "The tank-mix Material Issue carries no work order or other link to its plan, so it is matched "
		                          "by greenhouse warehouse, tank-mix item, quantity and date (earliest first): issued, matched by greenhouse/date.", "by_greenhouse": _places(srows, False)})
		out["spray"] = b
	if "direct" in paths:
		b = _block(drows)
		mr = sum(r["attributed"] for r in drows if r["mr"])
		b.update({"path": "direct", "by_source": {"from_material_request": _r2(mr), "no_material_request": _r2(sum(r["attributed"] for r in drows) - mr)},
		          "by_greenhouse": _places(drows, True),
		          "explain": "Direct issues name no greenhouse, so their spend is shown at farm level with its cost centre."})
		out["direct"] = b
	src_lines = [ln for ln in data["lines"] if ln["path"] in paths and (not greenhouse or (ln["path"] == "spray" and ln["greenhouse"] == greenhouse))]
	total = _r2(sum(r["attributed"] for r in rows))
	line_total = _r2(sum(ln["value"] for ln in src_lines)) if not pests else None
	led = _r2(ledger_total(src_lines)) if not pests else None
	out["combined"] = {
		"total": total,
		"spray": out.get("spray", {}).get("total", 0.0), "direct": out.get("direct", {}).get("total", 0.0),
		"line_total": line_total, "ledger_total": led,
		"ledger_difference": _r2(line_total - led) if led is not None else None,
		"fallback_lines": sum(1 for ln in src_lines if not ln["ledger"]),
		"reconciles": (abs(total - line_total) < 0.05) if line_total is not None else None,
	}
	return out
