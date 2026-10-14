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
	WHERE se.docstatus = 1 AND se.purpose = 'Manufacture' AND {where}
"""

_ISSUES = """
	SELECT se.name, se.posting_date, se.posting_time, sed.item_code AS item, sed.s_warehouse AS warehouse,
	       sed.transfer_qty AS qty, sed.cost_center{extra}
	FROM `tabStock Entry` se
	JOIN `tabStock Entry Detail` sed ON sed.parent = se.name
	WHERE se.docstatus = 1 AND se.purpose = 'Material Issue' AND IFNULL(se.work_order, '') = ''
	  AND sed.item_code IN %(items)s AND IFNULL(sed.cost_center, '') != '' AND {where}
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


def valuation(r) -> tuple:
	"""(value, from_ledger). The ledger value when it is there and non-zero; otherwise the entry's
	own line amount, counted as a fallback. (Negative stock at a zero rate gives a zero ledger value
	for a line that really moved stock.)"""
	v = r.get("ledger_value")
	if v is not None and flt(v) != 0:
		return flt(v), True
	if flt(r.get("qty")) == 0:
		return 0.0, True
	return flt(r.get("line_amount")), False


def FAT_split(value, kinds):
	out = []
	for t in (value or "").split("\n"):
		t = t.strip()
		if t and t in kinds and t not in out:
			out.append(t)
	return out


def split_issue_shares(issues) -> list:
	"""[(issue, share)] for the issues of ONE plan: each issue takes its share of the plan's
	consumed value by issued quantity (shares sum to 1). A single issue takes all of it."""
	total = sum(flt(i["qty"]) for i in issues)
	if not issues:
		return []
	if not total:
		return [(i, 1.0 / len(issues)) for i in issues]
	return [(i, flt(i["qty"]) / total) for i in issues]


def _in_period(d, f, t) -> bool:
	return str(f) <= str(d)[:10] <= str(t)


def collect_spray(from_date, to_date, groups, kinds) -> dict:
	"""Lines of completed plans, booked at their Material Issue date.

	A plan is completed when its Manufacture is matched to a tank-mix Material Issue: by the explicit
	link (Stock Entry.custom_spray_plan) where present, else by greenhouse / item / quantity / date.
	A plan can have several Manufactures (their raw lines are summed) and several issues (its value is
	split by issued quantity, each part booked on its own issue date, greenhouse and cost centre).
	The Manufacture may be any age: it is found through the plan, not by date."""
	f, t = str(from_date), str(to_date)
	empty = {"lines": [], "plans": 0, "manufactured": 0, "not_issued": [], "straddle": [], "by_link": {},
	         "in_progress": []}
	items = tuple(r[0] for r in frappe.db.sql(
		"""SELECT DISTINCT fg.item_code FROM `tabStock Entry` se
		   JOIN `tabWork Order` wo ON wo.name = se.work_order AND wo.custom_type = %(afp)s
		   JOIN `tabStock Entry Detail` fg ON fg.parent = se.name AND fg.is_finished_item = 1
		   WHERE se.docstatus = 1 AND se.purpose = 'Manufacture'""", {"afp": AFP_TYPE}))
	if not items:
		return empty
	has_link = frappe.db.has_column("Stock Entry", "custom_spray_plan")
	has_basis = frappe.db.has_column("Stock Entry", "custom_spray_link_basis")
	extra = (", se.custom_spray_plan AS link_wo" if has_link else "") + (
		", se.custom_spray_link_basis AS link_basis" if has_basis else "")
	issue_sql = _ISSUES.replace("{extra}", extra)
	late = min(str(add_days(to_date, MATCH_DAYS)), str(getdate(today())))
	early = str(add_days(from_date, -MATCH_DAYS))

	man_win = frappe.db.sql(
		_MANUFACTURES.replace("{where}", "se.posting_date BETWEEN %(a)s AND %(b)s"),
		{"afp": AFP_TYPE, "a": f, "b": t}, as_dict=True)
	win_issues = frappe.db.sql(
		issue_sql.replace("{where}", "se.posting_date BETWEEN %(a)s AND %(b)s"),
		{"items": items, "a": f, "b": t}, as_dict=True)

	# ---- explicit links: every issue of every plan seen in the period, whatever its date
	plans = {m["wo"] for m in man_win} | {i["link_wo"] for i in win_issues if has_link and i.get("link_wo")}
	linked_by_wo: dict = defaultdict(list)
	if has_link and plans:
		for i in frappe.db.sql(
			issue_sql.replace("{where}", "se.custom_spray_plan IN %(p)s"),
			{"items": items, "p": tuple(plans)}, as_dict=True,
		):
			i["basis"] = i.get("link_basis") or "Direct"
			linked_by_wo[i["link_wo"]].append(i)
	man_by_wo: dict = defaultdict(list)
	if plans:
		for m in frappe.db.sql(_MANUFACTURES.replace("{where}", "se.work_order IN %(p)s"),
		                       {"afp": AFP_TYPE, "p": tuple(plans)}, as_dict=True):
			man_by_wo[m["wo"]].append(m)

	# ---- fallback match for plans with no linked issue
	fb_m = [m for m in frappe.db.sql(
		_MANUFACTURES.replace("{where}", "se.posting_date BETWEEN %(a)s AND %(b)s"),
		{"afp": AFP_TYPE, "a": early, "b": t}, as_dict=True) if m["wo"] not in linked_by_wo]
	fb_i = [i for i in frappe.db.sql(
		issue_sql.replace("{where}", "se.posting_date BETWEEN %(a)s AND %(b)s"),
		{"items": items, "a": early, "b": late}, as_dict=True) if not (has_link and i.get("link_wo"))]
	for x in fb_m + fb_i:
		x["dt"] = _dt(x["posting_date"], x["posting_time"])
	matched = match_completed(fb_m, fb_i)
	issues_of: dict = {wo: list(v) for wo, v in linked_by_wo.items()}
	for wo, i in matched.items():
		i["basis"] = "Greenhouse+date (matched)"
		issues_of[wo] = [i]
		man_by_wo[wo] = [m for m in fb_m if m["wo"] == wo]

	# ---- bookings: (wo, issue, share) with the issue in the period; straddle: issue after it
	book, straddle_parts = [], []
	win_man_wos = {m["wo"] for m in man_win}
	for wo, iss in issues_of.items():
		for i, share in split_issue_shares(iss):
			d = str(i["posting_date"])[:10]
			if _in_period(d, f, t):
				book.append((wo, i, share))
			elif d > t and wo in win_man_wos:
				straddle_parts.append((wo, i, share))

	manufactured_wos = win_man_wos
	not_issued_wos = [wo for wo in manufactured_wos if wo not in issues_of]

	# ---- raw (consumed) lines of the Manufactures involved
	need = {wo for wo, _i, _s in book} | {wo for wo, _i, _s in straddle_parts}
	se_names = tuple({m["name"] for wo in need for m in man_by_wo.get(wo, [])})
	raw_by_se: dict = defaultdict(list)
	if se_names and groups:
		dates = [m["posting_date"] for wo in need for m in man_by_wo.get(wo, [])]
		for r in frappe.db.sql(_RAW, {"a": str(min(dates)), "b": str(max(dates)), "se": se_names, "groups": groups},
		                       as_dict=True):
			raw_by_se[r["se_name"]].append(r)

	wo_rows = {r.name: r for r in frappe.db.sql(
		"""SELECT name, custom_targets AS targets, custom_cost_center, custom_greenhouse FROM `tabWork Order`
		   WHERE name IN %(n)s""", {"n": tuple(plans | set(issues_of)) or ("",)}, as_dict=True)}
	rec: dict = {}
	if frappe.db.has_column("Work Order Item", "custom_targets"):
		for r in frappe.db.sql(
			"SELECT parent, item_code, custom_targets FROM `tabWork Order Item` WHERE parent IN %(n)s",
			{"n": tuple(need) or ("",)}, as_dict=True,
		):
			if r.custom_targets:
				cur = rec.setdefault((r.parent, r.item_code), [])
				cur.extend(x for x in FAT_split(r.custom_targets, kinds) if x not in cur)

	lines = []
	farms: dict = {}
	by_link: dict = defaultdict(int)
	booked_wos = set()
	for wo, issue, share in book:
		w = wo_rows.get(wo)
		fm = _farm_of(issue["warehouse"], farms)
		booked_wos.add(wo)
		for m in man_by_wo.get(wo, []):
			for r in raw_by_se.get(m["name"], []):
				val, ledger = valuation(r)
				lines.append({
					"path": "spray", "date": str(issue["posting_date"])[:10], "document": m["name"],
					"issue": issue["name"], "work_order": wo, "mr": None, "link_basis": issue.get("basis"),
					"greenhouse": issue["warehouse"], "farm": fm,
					"cost_center": issue["cost_center"] or (w.custom_cost_center if w else None),
					"item_code": r["item_code"], "item_name": r["item_name"], "qty": flt(r["qty"]) * share,
					"uom": r["stock_uom"], "value": val * share, "ledger": ledger, "detail": r["detail"],
					"share": share, "is_return": False, "netted_against": None,
					"plan_targets": FAT_split(w.targets if w else "", kinds),
					"recorded": rec.get((wo, r["item_code"])) or [],
				})
	for wo in booked_wos:
		by_link["from_link" if wo in linked_by_wo else "fallback_match"] += 1

	def targets_of(wo):
		return FAT_split(wo_rows[wo].targets, kinds) if wo in wo_rows else []

	straddle = []
	for wo, issue, share in straddle_parts:
		val = sum(valuation(r)[0] for m in man_by_wo.get(wo, []) for r in raw_by_se.get(m["name"], [])) * share
		straddle.append({"work_order": wo, "issue": issue["name"], "issued": str(issue["posting_date"])[:10],
		                 "greenhouse": issue["warehouse"], "targets": targets_of(wo), "value": round(val, 2)})
	not_issued = [
		{"work_order": m["wo"], "manufacture": m["name"], "date": str(m["posting_date"])[:10],
		 "greenhouse": m["warehouse"], "targets": targets_of(m["wo"])}
		for m in man_win if m["wo"] in not_issued_wos
	]
	return {
		"by_link": dict(by_link),
		"manufactured": len(manufactured_wos),
		"not_issued": not_issued,
		"straddle": straddle,
		"lines": lines,
		"plans": len(booked_wos),
		"in_progress": _in_progress(f, t, groups, set(issues_of), kinds),
	}


def _in_progress(from_date, to_date, groups, completed: set, kinds) -> list:
	"""Per plan: chemicals sent to a CSU in the period for plans that are not completed."""
	if not groups:
		return []
	rows = frappe.db.sql(
		"""
		SELECT se.work_order AS wo, wo.custom_greenhouse AS greenhouse, wo.custom_targets AS targets,
		       SUM(sle.val) AS value
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
		GROUP BY se.work_order, wo.custom_greenhouse, wo.custom_targets
		""",
		{"afp": AFP_TYPE, "f": str(from_date), "t": str(to_date), "groups": groups},
		as_dict=True,
	)
	return [{"work_order": r.wo, "greenhouse": r.greenhouse, "targets": FAT_split(r.targets, kinds),
	         "value": round(flt(r.value), 2)} for r in rows if r.wo not in completed]


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
		value, ledger = valuation(r)
		out.append({
			"path": "direct", "date": str(r["posting_date"])[:10], "document": r["document"], "issue": r["document"],
			"work_order": None, "mr": r["material_request"] or None, "link_basis": None, "greenhouse": None,
			"farm": _farm_of(r["s_warehouse"], farms) or r["company"], "cost_center": r["cost_center"],
			"item_code": r["item_code"], "item_name": r["item_name"], "qty": flt(r["qty"]), "uom": r["stock_uom"],
			"value": value, "ledger": ledger, "share": 1.0, "is_return": False, "netted_against": None,
			"detail": r["detail"], "plan_targets": None, "recorded": [],
		})
	return out


_RETURNS = """
	SELECT se.name AS document, se.posting_date, se.company, sed.name AS detail, sed.s_warehouse, sed.t_warehouse,
	       sed.item_code, sed.transfer_qty AS qty, sed.stock_uom, sed.amount AS line_amount, sed.cost_center,
	       sed.material_request, sle.val AS ledger_value, i.item_name
	FROM `tabStock Entry` se
	JOIN `tabStock Entry Detail` sed ON sed.parent = se.name
	JOIN `tabItem` i ON i.name = sed.item_code
	LEFT JOIN (
		SELECT voucher_detail_no, -SUM(stock_value_difference) AS val
		FROM `tabStock Ledger Entry`
		WHERE voucher_type = 'Stock Entry' AND is_cancelled = 0 AND actual_qty > 0
		  AND posting_date BETWEEN %(f)s AND %(t)s
		GROUP BY voucher_detail_no
	) sle ON sle.voucher_detail_no = sed.name
	WHERE se.docstatus = 1 AND se.purpose IN ('Material Receipt', 'Material Transfer')
	  AND IFNULL(sed.t_warehouse, '') != '' AND ({is_return})
	  AND se.posting_date BETWEEN %(f)s AND %(t)s AND i.item_group IN %(groups)s
"""


def collect_returns(from_date, to_date, groups, wip_match, direct_lines) -> list:
	"""Stock returned to a store after a direct issue: a Material Receipt / Transfer flagged as a return
	(custom_is_return, or a Stock Entry Type with "return" in its name). Each becomes a NEGATIVE direct
	line for its product and period, attributed exactly like that product's issues, so it nets against
	them. Where the same item and Material Request appear on an issue, the return says which document it
	nets against; otherwise it stands as its own negative line. A purchase receipt is never a return."""
	if not groups:
		return []
	cond = "se.stock_entry_type LIKE '%%return%%'"
	if frappe.db.has_column("Stock Entry", "custom_is_return"):
		cond = "IFNULL(se.custom_is_return, 0) = 1 OR " + cond
	rows = frappe.db.sql(_RETURNS.replace("{is_return}", cond),
	                     {"f": str(from_date), "t": str(to_date), "groups": groups}, as_dict=True)
	farms: dict = {}
	out = []
	for r in rows:
		if r["s_warehouse"] and wip_match(r["s_warehouse"]):
			continue  # back out of a CSU: that stock was never counted as consumed
		v, ledger = valuation({"ledger_value": r["ledger_value"], "qty": r["qty"], "line_amount": r["line_amount"]})
		original = next((d["document"] for d in direct_lines
		                 if d["item_code"] == r["item_code"] and r["material_request"] and d["mr"] == r["material_request"]),
		                None)
		out.append({
			"path": "direct", "date": str(r["posting_date"])[:10], "document": r["document"], "issue": r["document"],
			"work_order": None, "mr": r["material_request"] or None, "link_basis": None, "greenhouse": None,
			"farm": _farm_of(r["t_warehouse"], farms) or r["company"], "cost_center": r["cost_center"],
			"item_code": r["item_code"], "item_name": r["item_name"], "qty": -flt(r["qty"]), "uom": r["stock_uom"],
			"value": -abs(v), "ledger": ledger, "share": 1.0, "is_return": True, "netted_against": original,
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
		uses = FAT.uses_before(refs, ln["item_code"], ln["date"], ln.get("work_order"))
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
				"item_code", "item_name", "qty", "uom", "ledger", "detail", "share", "is_return", "netted_against")}, "value": value,
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
	spray = collect_spray(from_date, to_date, groups, kinds) if groups else {
		"lines": [], "plans": 0, "manufactured": 0, "not_issued": [], "straddle": [], "by_link": {}, "in_progress": []}
	wip = wip_matcher()
	direct = collect_direct(from_date, to_date, groups, wip)
	direct = direct + collect_returns(from_date, to_date, groups, wip, direct)
	lines = spray["lines"] + direct
	products = FAT.raw_products({ln["item_code"] for ln in lines}, kb)
	refs = FAT.reference_data_for(from_date, to_date, kinds, kb)
	rows = attribute(lines, refs, kb, kinds, products)
	return {"rows": rows, "lines": lines, "spray": spray, "kinds": kinds}


def ledger_total(lines) -> float:
	"""Re-derive the ledger value of the source lines straight from the Stock Ledger, weighted by the share
	of each source line that is booked (a split plan books part of a Manufacture line)."""
	out = 0.0
	for is_return in (False, True):
		part = [ln for ln in lines if ln.get("ledger") and ln.get("detail") and bool(ln.get("is_return")) == is_return]
		names = list({ln["detail"] for ln in part})
		sums: dict = {}
		for i in range(0, len(names), 1000):
			for d, v in frappe.db.sql(
				f"""SELECT voucher_detail_no, SUM(-stock_value_difference) FROM `tabStock Ledger Entry`
				    WHERE voucher_type='Stock Entry' AND is_cancelled=0 AND actual_qty {'>' if is_return else '<'} 0
				      AND voucher_detail_no IN %(n)s GROUP BY voucher_detail_no""", {"n": tuple(names[i:i + 1000])}):
				sums[d] = flt(v)
		out += sum(sums.get(ln["detail"], 0.0) * flt(ln.get("share", 1.0)) for ln in part)
	return out


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


def _keep(item, greenhouse, pests) -> bool:
	"""A not-counted plan (in progress, not issued, issued later) under the same filters as the figures."""
	if greenhouse and item.get("greenhouse") != greenhouse:
		return False
	if pests and not (set(item.get("targets") or []) & set(pests)):
		return False
	return True


RETURNS_NOTE = (
	"Returns: stock sent back to a store after a direct issue (a Material Receipt or Transfer flagged as a "
	"return) is taken off as a negative line for its product and period, attributed like that product's issues, "
	"so it nets against them. Where the same item and Material Request appear on an issue it says which document "
	"it nets against; otherwise it stands as its own negative line. Purchase receipts are never returns."
)


def build_report(from_date, to_date, paths=PATHS, pests=None, greenhouse=None, data=None) -> dict:
	data = data or collect_rows(from_date, to_date)
	all_rows = data["rows"]
	requested = tuple(paths)
	if greenhouse:
		paths = tuple(p for p in paths if p != "direct")
	rows, notes = apply_filters(all_rows, paths=requested, pests=pests, greenhouse=greenhouse)
	out = {
		"filters": {"from": str(from_date), "to": str(to_date), "paths": list(paths), "requested_paths": list(requested),
		            "pests": list(pests or []), "greenhouse": greenhouse or ""},
		"notes": notes,
		"accuracy": FAT.ACCURACY,
		"pest_options": sorted({r["target"] for r in all_rows if r["target"] != UNATTRIBUTED and not r["is_nonpest"]}),
		"greenhouse_options": sorted({r["greenhouse"] for r in all_rows if r["greenhouse"]}),
	}
	srows = [r for r in rows if r["path"] == "spray"]
	drows = [r for r in rows if r["path"] == "direct"]
	spray = data["spray"]
	if "spray" in paths:
		keep = lambda x: _keep(x, greenhouse, pests)  # noqa: E731
		prog = [x for x in spray.get("in_progress", []) if keep(x)]
		strad = [x for x in spray.get("straddle", []) if keep(x)]
		b = _block(srows)
		b.update({
			"path": "spray", "plans_completed": len({r["work_order"] for r in srows}),
			"in_progress": {"plans": len(prog), "value": _r2(sum(x["value"] for x in prog))},
			"manufactured": spray.get("manufactured", 0), "by_link": spray.get("by_link", {}),
			"not_issued": [x for x in spray.get("not_issued", []) if keep(x)],
			"straddle": {"plans": len({x["work_order"] for x in strad}), "value": _r2(sum(x["value"] for x in strad)),
			             "items": strad[:100],
			             "note": "Manufactured in this period but issued after it: booked in the period of the issue."},
			"match_method": "A plan counts once its Manufacture is matched to a tank-mix Material Issue: by the explicit "
			                "link where the issue carries one, otherwise by greenhouse, item, quantity and date.",
			"by_greenhouse": _places(srows, False)})
		out["spray"] = b
	if "direct" in paths:
		b = _block(drows)
		mr = sum(r["attributed"] for r in drows if r["mr"])
		ret = [r for r in drows if r["is_return"]]
		b.update({"path": "direct",
		          "by_source": {"from_material_request": _r2(mr),
		                        "no_material_request": _r2(sum(r["attributed"] for r in drows) - mr),
		                        "returns": _r2(sum(r["attributed"] for r in ret))},
		          "returns": {"total": _r2(sum(r["attributed"] for r in ret)),
		                      "traced": _r2(sum(r["attributed"] for r in ret if r["netted_against"])),
		                      "untraced": _r2(sum(r["attributed"] for r in ret if not r["netted_against"])),
		                      "lines": len({r["detail"] for r in ret}), "note": RETURNS_NOTE},
		          "by_greenhouse": _places(drows, True),
		          "explain": "Direct issues name no greenhouse, so their spend is shown at farm level with its cost centre."})
		out["direct"] = b
	src_lines = [ln for ln in data["lines"] if ln["path"] in paths
	             and (not greenhouse or (ln["path"] == "spray" and ln["greenhouse"] == greenhouse))]
	total = _r2(sum(r["attributed"] for r in rows))
	combined = {"total": total,
	            "spray": out.get("spray", {}).get("total", 0.0), "direct": out.get("direct", {}).get("total", 0.0),
	            "fallback_lines": sum(1 for ln in src_lines if not ln["ledger"] and ln["value"]),
	            "line_total": None, "ledger_total": None, "ledger_difference": None, "rounding_residual": None,
	            "reconciles": None}
	if not pests:
		# Like with like: the report's rows are cent-rounded per line, so they are compared with the cent-rounded
		# lines; the ledger is compared with the unrounded lines. What rounding removed is reported apart.
		valued = [ln for ln in src_lines if ln["value"]]
		line_total = _r2(sum(round(ln["value"], 2) for ln in valued))
		ledger_lines = [ln for ln in valued if ln["ledger"]]
		led = ledger_total(ledger_lines)
		diff = _r2(sum(ln["value"] for ln in ledger_lines) - led)
		combined.update({
			"line_total": line_total, "ledger_total": _r2(led), "ledger_difference": diff,
			"rounding_residual": _r2(sum(ln["value"] for ln in valued) - line_total),
			"reconciles": abs(total - line_total) < 0.005 and abs(diff) < 0.01,
		})
	out["combined"] = combined
	return out
