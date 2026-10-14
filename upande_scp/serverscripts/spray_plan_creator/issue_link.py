"""Link a tank-mix Material Issue back to the spray plan (Work Order) it consumed.

ERPNext nulls ``Stock Entry.work_order`` on a Material Issue and treating it as
Work Order consumption would change quantities, so the durable link is
``Stock Entry.custom_spray_plan`` (Link -> Work Order, read-only) plus
``custom_spray_link_basis`` recording how the link was established.

New issues get both fields from ``auto_material_issue.build_material_issue``.
``backfill`` links the historical ones, in order of reliability:

  1. Direct            the issue's remarks name the plan
  2. Batch             the issue consumes a batch the plan's Manufacture produced
  3. Greenhouse + date same tank-mix item, same greenhouse warehouse, issued on or
                       after the Manufacture; nearest Manufacture first

A Manufacture is matched one-to-one: its quantity is drawn down by each issue
linked to it, so a split issue can match twice but a plan is never claimed beyond
what it produced. Ties and anything unmatched stay unlinked.
"""
from __future__ import annotations

import re
from collections import defaultdict

import frappe
from frappe.utils import get_datetime

AFP_TYPE = "Application Floor Plan"
LINK = "custom_spray_plan"
BASIS = "custom_spray_link_basis"
BASIS_DIRECT = "Direct"
BASIS_BATCH = "Batch"
BASIS_GREENHOUSE = "Greenhouse + date"
EPS = 1e-6
_TOKEN = re.compile(r"[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+")


def match(manufactures: list[dict], issues: list[dict]) -> tuple[dict, dict]:
	"""Pure matcher.

	manufactures: {wo, item, wh, qty, dt, batches:set}
	issues:       {name, remarks, item, wh, qty, dt, batches:set}
	Returns ({issue name: (wo, basis)}, {"ambiguous": n, "unmatched": n}).
	"""
	remaining = {id(m): float(m["qty"] or 0) for m in manufactures}
	by_wo = defaultdict(list)
	for m in manufactures:
		by_wo[m["wo"]].append(m)
	result: dict[str, tuple[str, str]] = {}
	ambiguous = set()

	def draw(m, qty):
		remaining[id(m)] = max(0.0, remaining[id(m)] - float(qty or 0))

	# 1. Direct
	for i in issues:
		for token in _TOKEN.findall(i.get("remarks") or ""):
			if token in by_wo:
				result[i["name"]] = (token, BASIS_DIRECT)
				for m in by_wo[token]:
					if m["item"] == i["item"]:
						draw(m, i["qty"])
						break
				break

	def fits(m, i):
		return m["item"] == i["item"] and remaining[id(m)] + EPS >= float(i["qty"] or 0)

	# 2. Batch
	for i in sorted(issues, key=lambda x: x["dt"]):
		if i["name"] in result or not i["batches"]:
			continue
		cands = [m for m in manufactures if fits(m, i) and m["batches"] & i["batches"]]
		if len(cands) == 1:
			result[i["name"]] = (cands[0]["wo"], BASIS_BATCH)
			draw(cands[0], i["qty"])
		elif len(cands) > 1:
			ambiguous.add(i["name"])

	# 3. Greenhouse + date, chronologically so earlier issues take earlier manufactures
	for i in sorted(issues, key=lambda x: x["dt"]):
		if i["name"] in result:
			continue
		cands = [m for m in manufactures
			if fits(m, i) and m["wh"] == i["wh"] and m["dt"] <= i["dt"]]
		if not cands:
			continue
		nearest = max(m["dt"] for m in cands)
		top = [m for m in cands if m["dt"] == nearest]
		if len({m["wo"] for m in top}) > 1:
			ambiguous.add(i["name"])
			continue
		result[i["name"]] = (top[0]["wo"], BASIS_GREENHOUSE)
		draw(top[0], i["qty"])

	ambiguous -= set(result)
	return result, {"ambiguous": len(ambiguous), "unmatched": len(issues) - len(result)}


def _batches(rows) -> dict[str, set]:
	"""detail row name -> batches, from batch_no and the serial/batch bundle."""
	out: dict[str, set] = defaultdict(set)
	bundles = {}
	for r in rows:
		if r.get("batch_no"):
			out[r["name"]].add(r["batch_no"])
		if r.get("serial_and_batch_bundle"):
			bundles.setdefault(r["serial_and_batch_bundle"], []).append(r["name"])
	names = list(bundles)
	for k in range(0, len(names), 500):
		chunk = names[k:k + 500]
		for e in frappe.get_all(
			"Serial and Batch Entry",
			filters={"parent": ["in", chunk], "batch_no": ["is", "set"]},
			fields=["parent", "batch_no"],
		):
			for rn in bundles[e["parent"]]:
				out[rn].add(e["batch_no"])
	return out


def load_manufactures() -> list[dict]:
	has_bundle = frappe.db.has_column("Stock Entry Detail", "serial_and_batch_bundle")
	rows = frappe.db.sql(
		f"""SELECT sed.name, se.work_order wo, sed.item_code item, sed.t_warehouse wh,
		       sed.qty, CONCAT(se.posting_date, ' ', se.posting_time) dt, sed.batch_no
		       {', sed.serial_and_batch_bundle' if has_bundle else ''}
		FROM `tabStock Entry` se
		JOIN `tabStock Entry Detail` sed ON sed.parent = se.name
		JOIN `tabWork Order` wo ON wo.name = se.work_order
		WHERE se.docstatus = 1 AND se.purpose = 'Manufacture'
		  AND sed.is_finished_item = 1 AND wo.custom_type = %s""",
		(AFP_TYPE,), as_dict=True)
	b = _batches(rows)
	return [dict(wo=r.wo, item=r.item, wh=r.wh, qty=r.qty, dt=get_datetime(r.dt),
		batches=b.get(r.name, set())) for r in rows]


def load_issues(items: set) -> list[dict]:
	if not items:
		return []
	has_bundle = frappe.db.has_column("Stock Entry Detail", "serial_and_batch_bundle")
	rows = frappe.db.sql(
		f"""SELECT sed.name, se.name entry, se.remarks, sed.item_code item,
		       sed.s_warehouse wh, sed.qty, CONCAT(se.posting_date, ' ', se.posting_time) dt,
		       sed.batch_no {', sed.serial_and_batch_bundle' if has_bundle else ''}
		FROM `tabStock Entry` se
		JOIN `tabStock Entry Detail` sed ON sed.parent = se.name
		WHERE se.docstatus = 1 AND se.purpose = 'Material Issue'
		  AND IFNULL(se.`{LINK}`, '') = '' AND sed.item_code IN %s""",
		(tuple(items),), as_dict=True)
	b = _batches(rows)
	seen, out = set(), []
	for r in rows:  # one row per entry: the first tank-mix row
		if r.entry in seen:
			continue
		seen.add(r.entry)
		out.append(dict(name=r.entry, remarks=r.remarks, item=r.item, wh=r.wh,
			qty=r.qty, dt=get_datetime(r.dt), batches=b.get(r.name, set())))
	return out


def backfill() -> dict:
	"""Idempotent: only touches submitted issues that have no plan link yet."""
	if not frappe.db.has_column("Stock Entry", LINK) or not frappe.db.has_column("Stock Entry", BASIS):
		return {}
	# Links set at issue time (before the basis field existed) are Direct by construction.
	frappe.db.sql(
		f"""UPDATE `tabStock Entry` SET `{BASIS}` = %s
		WHERE docstatus = 1 AND IFNULL(`{LINK}`, '') != '' AND IFNULL(`{BASIS}`, '') = ''
		  AND purpose = 'Material Issue'""", (BASIS_DIRECT,))
	manus = load_manufactures()
	issues = load_issues({m["item"] for m in manus})
	result, stats = match(manus, issues)
	counts = defaultdict(int)
	for name, (wo, basis) in result.items():
		# update_modified=False: these are submitted, historical documents
		frappe.db.set_value("Stock Entry", name, {LINK: wo, BASIS: basis}, update_modified=False)
		counts[basis] += 1
	summary = {"candidates": len(issues), "by_basis": dict(counts), **stats}
	frappe.logger("upande_scp").info(f"spray issue link backfill: {summary}")
	return summary
