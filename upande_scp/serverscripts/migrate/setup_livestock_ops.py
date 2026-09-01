"""Make a target site able to run feeding and health operations.

The data migration put the masters on the staging site — 366 animals, 9 herds,
8 BOMs, every feed item, every feed warehouse — but none of the configuration or
stock that the operations block actually reads. `Livestock Settings` is blank, so
there is no company and no store to draw from; there are three `Bin` rows on the
whole site, so there is nothing to manufacture out of; and the DRUGS group is
empty, so there is nothing to issue. This closes those gaps over the REST API.

Every step is idempotent — it checks before it writes, and re-running it is a
no-op — so this can be fired repeatedly while a deploy settles.

    python3 setup_livestock_ops.py                 # dry run: says what it would do
    python3 setup_livestock_ops.py --apply
    python3 setup_livestock_ops.py --apply --only settings,drug_items
    python3 setup_livestock_ops.py --apply --days 60

WHAT IT WILL NOT DO
  The two herds pointing at concentrate BOMs (`2-4` and `4-12 MONTHS (WEANERS)`
  use 1000 kg batch recipes as if they were per-head rations) are reported, not
  fixed. Writing a dairy ration is a nutrition decision, and no correct version
  of either exists on any site to copy — kaitet carries the same fault. Someone
  who feeds those animals has to say what goes in.

Credentials come from ~/.scp_migrate_staging_env, same as the rest of the migrate
tooling. See target.py.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict

import target as T

# The drug store's opening stock, mirroring demo/seed_test_stock.py so a training
# site holds the same shelf as the development one.
#   (item_code, item_name, stock_uom, opening_qty, rate)
DRUG_ITEMS = [
	("LSK-VAC-FMD", "FMD Vaccine (50 dose vial)", "Nos", 20, 3500),
	("LSK-VAC-LSD", "Lumpy Skin Disease Vaccine (25 dose)", "Nos", 15, 2800),
	("LSK-VAC-ANTH", "Anthrax / Blackquarter Vaccine (100 dose)", "Nos", 10, 1900),
	("LSK-VAC-RVF", "Rift Valley Fever Vaccine (50 dose)", "Nos", 8, 4200),
	("LSK-DEW-ALB", "Albendazole 10% Oral Drench (1 L)", "Litre", 25, 1200),
	("LSK-DEW-IVE", "Ivermectin 1% Injectable (500 ml)", "Nos", 18, 2400),
	("LSK-DEW-LEV", "Levamisole 7.5% Injectable (100 ml)", "Nos", 12, 850),
	("LSK-AB-PENSTREP", "Penicillin-Streptomycin Injectable (100 ml)", "Nos", 30, 950),
	("LSK-AB-OTC", "Oxytetracycline LA 20% (100 ml)", "Nos", 24, 1100),
	("LSK-AB-INTRAMAM", "Intramammary Antibiotic Tube", "Nos", 60, 320),
	("LSK-SUP-CALCIUM", "Calcium Borogluconate 40% (400 ml)", "Nos", 20, 700),
	("LSK-SEMEN-TEST", "Semen Straw - Test Sire", "Nos", 40, 2500),
]
DRUG_ITEM_GROUP = "DRUGS"
SEMEN_ITEM = "LSK-SEMEN-TEST"
DRUG_STORE = "Livestock Drug Store"

COMPANY = "Karen Roses"

# Where the feeding programme looks, in order. First store that can cover a line
# in full is the one the Work Order transfers from, so this order is the farm's
# preference, not a formality. The WIP store is appended by the app itself.
FEED_SOURCES = [
	("Feed Store - Raw materials - KR", "Purchased raw materials"),
	("Feed Store - Concentrate store - KR", "Bought-in and mixed concentrate"),
	("Concentrate Mixing Store - KR", "Mixed concentrate and finished TMR on hand"),
	("Hay Store - Greenhouse - KR", "Hay bales"),
	("Silage Pit 1 Next to Hay Store - KR", "Silage"),
	("Silage Pit 2 below Spray Race - KR", "Silage"),
	("Silage pit 3 next to Vegetable Garden - KR", "Silage"),
	("Kabarak Silage Pits (now 4 pits) - KR", "Silage"),
]
FEED_WIP_STORE = "Concentrate Mixing Store - KR"

# Concentrate the farm buys ready-packed. Nothing in the item data separates it
# from silage — every feed item is in the DAIRY group with is_purchase_item set,
# the mixed ones included — so it has to be named.
BOUGHT_IN = [("4040010086", "Westwood Dairy Meal - New formulation, delivered ready-packed")]

# Valuation for the opening receipt, from kaitet's own balances. A material with
# no entry here is received at 1 rather than 0, because ERPNext refuses to post a
# Manufacture entry for a zero-valued item.
FEED_RATES = {
	"4040010002": 150.78, "4040010020": 30.00, "4040010027": 60.00, "4040010029": 7.00,
	"4040010034": 190.00, "4040010052": 137.50, "4040010078": 230.83, "4040010082": 7.61,
	"4040010086": 50.00, "4040010088": 232.40, "4040020044": 39.00,
}
# One store per material, so the search order above resolves predictably.
FEED_HOME = {
	"4040010034": "Hay Store - Greenhouse - KR",
	"4040010086": "Feed Store - Concentrate store - KR",
	"4040010052": "Feed Store - Concentrate store - KR",
}
FEED_HOME_DEFAULT = "Feed Store - Raw materials - KR"

# Manufacturing a TMR or a concentrate creates a Work Order, so the roles that
# run a feed batch need permission on it. ERPNext grants Manufacturing User that
# by default — but a site with any Custom DocPerm row on Work Order REPLACES the
# standard set wholesale, and kaitet is such a site: its two rows named only SCP
# roles, leaving nobody but Administrator able to manufacture at all. Grants are
# additive here, and frappe.permissions.add_permission copies the standard set in
# first when none exists, so nothing is ever revoked.
WO_GRANTS = {
	"Work Order": {
		"Manufacturing Manager": "rwcsx", "Manufacturing User": "rwcsx", "System Manager": "rwcsx",
		"Livestock Manager": "rwcsx", "Livestock Attendant": "rwcs", "Livestock Stores": "rwcs",
	},
	"BOM": {
		"Manufacturing Manager": "rwcsx", "Manufacturing User": "rwcsx", "System Manager": "rwcsx",
		"Livestock Manager": "rwcsx", "Livestock Attendant": "r", "Livestock Stores": "r",
	},
	"Stock Entry": {
		"Livestock Manager": "rwcsx", "Livestock Attendant": "rwcs", "Livestock Stores": "rwcs",
		"Livestock Vet": "rwcs", "Livestock Milker": "rwcs",
	},
}
PERM_FLAG = {"r": "read", "w": "write", "c": "create", "s": "submit", "x": "cancel"}

# Event types that take something out of a store. The deploy's patch sets these
# too; doing it here as well means a site that was deployed before the patch
# landed is still correct.
CONSUMING_TYPES = ("Vaccination", "Deworming", "Check Up", "Drying Off")

# Opening stock has to predate the events that draw on it: an issue is judged
# against the ledger as of its posting date, so stock received today makes every
# back-dated vaccination or treatment fail for having none on the day.
OPENING_DATE = "2025-01-02"


class Run:
	"""Collects what happened so a dry run and a real run report identically."""

	def __init__(self, t, apply_):
		self.t = t
		self.apply = apply_
		self.did = []
		self.skipped = []
		self.failed = []

	def note(self, what):
		self.did.append(what)
		print("    + {}".format(what))

	def already(self, what):
		self.skipped.append(what)
		print("    · {} (already there)".format(what))

	def fail(self, what, why):
		self.failed.append((what, why))
		print("    ! {} — {}".format(what, str(why)[:180]))

	def would(self, what):
		self.did.append(what)
		print("    ~ would {}".format(what))


def _abbr(t):
	rows = t.get_list("Company", fields=["name", "abbr"], filters={"name": COMPANY}, limit=1)
	if not rows:
		raise SystemExit("company {!r} does not exist on the target".format(COMPANY))
	return rows[0]["abbr"]


def _doc(t, doctype, name):
	r = t._request("GET", "/api/resource/{}/{}".format(doctype, name.replace("/", "%2F")))
	if not r.ok:
		raise T.TargetError("reading {} {}: HTTP {}".format(doctype, name, r.status_code))
	return r.json()["data"]


def _put(t, doctype, name, payload):
	r = t._request(
		"PUT",
		"/api/resource/{}/{}".format(doctype, name.replace("/", "%2F")),
		data=json.dumps(payload),
	)
	if r.ok:
		return True, (r.json().get("data") or {}).get("name")
	return False, r.text[:200]


def _exists(t, doctype, name):
	return bool(t.get_list(doctype, fields=["name"], filters={"name": name}, limit=1))


# ---------------------------------------------------------------------------
# steps
# ---------------------------------------------------------------------------


def preflight(run):
	"""Is the code deployed? Nothing below works without it."""
	t = run.t
	missing = [dt for dt in ("Livestock Feed Warehouse", "Livestock Bought In Concentrate")
	           if not t.doctype_exists(dt)]
	settings = _doc(t, "Livestock Settings", "Livestock Settings")
	if "feed_source_warehouses" not in settings:
		missing.append("Livestock Settings.feed_source_warehouses")
	if missing:
		print("    ! the branch is not deployed yet — missing: {}".format(", ".join(missing)))
		print("      steps that need it (settings) will be skipped; the rest can still run.")
		return False
	print("    · code is deployed")
	return True


def hay_uom(run):
	"""Give every BOM material a conversion row for the UOM its BOM uses.

	Hay is stocked in BALE but written in Kilogram on every herd BOM. The BOM rows
	already carry conversion_factor 0.07, so the feeding maths is right today —
	but the Item master has no Kilogram row, so re-saving one of those BOMs would
	fail to find the conversion or silently reset it to 1. That is a ~14x error
	waiting on the next person to open a BOM.
	"""
	t = run.t
	needed = defaultdict(dict)          # item -> {uom: conversion_factor}
	for bom in t.get_list("BOM", fields=["name"], limit=200):
		doc = _doc(t, "BOM", bom["name"])
		for row in doc.get("items", []):
			uom, stock_uom = row.get("uom"), row.get("stock_uom")
			if uom and stock_uom and uom != stock_uom:
				needed[row["item_code"]][uom] = row.get("conversion_factor") or 1.0

	for item_code, conversions in sorted(needed.items()):
		doc = _doc(t, "Item", item_code)
		have = {u.get("uom") for u in doc.get("uoms", [])}
		add = {u: cf for u, cf in conversions.items() if u not in have}
		if not add:
			run.already("{} UOM conversions".format(item_code))
			continue
		what = "{}: add {}".format(item_code, ", ".join("{} @ {}".format(u, cf) for u, cf in add.items()))
		if not run.apply:
			run.would(what)
			continue
		uoms = [{"uom": u.get("uom"), "conversion_factor": u.get("conversion_factor")}
		        for u in doc.get("uoms", [])]
		uoms += [{"uom": u, "conversion_factor": cf} for u, cf in add.items()]
		ok, err = _put(t, "Item", item_code, {"uoms": uoms})
		run.note(what) if ok else run.fail(what, err)


def drug_store(run):
	"""The warehouse the drug and semen issues draw from.

	`custom_farm` is mandatory on Warehouse on this site, so the farm is copied
	from the store the feed already comes out of rather than guessed — the dairy
	sits at Kapkolia, not at the company's namesake farm.
	"""
	t = run.t
	abbr = _abbr(t)
	full = "{} - {}".format(DRUG_STORE, abbr)
	if _exists(t, "Warehouse", full):
		run.already(full)
		return full

	farm = None
	for sibling in (FEED_WIP_STORE, FEED_HOME_DEFAULT):
		rows = t.get_list("Warehouse", fields=["custom_farm"], filters={"name": sibling}, limit=1)
		if rows and rows[0].get("custom_farm"):
			farm = rows[0]["custom_farm"]
			break
	if not farm:
		run.fail(full, "no sibling feed warehouse has a custom_farm to copy")
		return full

	if not run.apply:
		run.would("create warehouse {} (farm {})".format(full, farm))
		return full
	ok, res = t.insert("Warehouse", {
		"doctype": "Warehouse",
		"warehouse_name": DRUG_STORE,
		"company": COMPANY,
		"parent_warehouse": "All Warehouses - {}".format(abbr),
		"custom_farm": farm,
		"is_group": 0,
	})
	run.note("warehouse {}".format(full)) if ok else run.fail(full, res)
	return full


def drug_items(run):
	"""The drugs themselves. The DRUGS group exists on the target but is empty."""
	t = run.t
	for code, name, uom, _qty, _rate in DRUG_ITEMS:
		if _exists(t, "Item", code):
			run.already(code)
			continue
		if not run.apply:
			run.would("create item {} ({})".format(code, name))
			continue
		ok, res = t.insert("Item", {
			"doctype": "Item",
			"item_code": code,
			"item_name": name,
			"item_group": DRUG_ITEM_GROUP,
			"stock_uom": uom,
			"is_stock_item": 1,
			"is_purchase_item": 1,
			"include_item_in_manufacturing": 0,
		})
		run.note("item {}".format(code)) if ok else run.fail(code, res)


def _bom_items(t):
	"""Every item reachable from a herd's BOM — produced items and inputs both."""
	seen, items, queue = set(), set(), []
	for h in t.get_list("Herds", fields=["bom"], limit=100):
		if h.get("bom"):
			queue.append(h["bom"])
	while queue:
		bom = queue.pop()
		if not bom or bom in seen:
			continue
		seen.add(bom)
		doc = _doc(t, "BOM", bom)
		items.add(doc["item"])
		for row in doc.get("items", []):
			items.add(row["item_code"])
			sub = row.get("bom_no")
			if sub:
				queue.append(sub)
	return {i for i in items if i}


def item_flags(run):
	"""Clear batch/serial tracking on the feed materials.

	The target's item master arrived with has_batch_no and has_serial_no set on
	every feed material — bulk silage, wheat bran, hay. kaitet, which is the
	authoritative copy, has both clear on all eleven. Serialising a hundred
	tonnes of silage is an import artefact, not a requirement, and it makes the
	opening receipt impossible ("Serial and Batch Bundle not set").

	Only touched while the item has no stock: ERPNext refuses the change once a
	ledger exists, and rightly.
	"""
	t = run.t
	# Everything a feed run touches, not just the raw materials: the concentrate
	# sub-assemblies and the finished TMRs are produced INTO a warehouse, so a
	# tracking flag on them blocks the Manufacture entry just as surely.
	codes = sorted(_bom_items(t))
	for code in codes:
		rows = t.get_list("Item", fields=["name", "item_name", "has_batch_no", "has_serial_no"],
		                  filters={"name": code}, limit=1)
		if not rows:
			continue
		it = rows[0]
		if not (it.get("has_batch_no") or it.get("has_serial_no")):
			run.already("{} not tracked".format(code))
			continue
		bins = t.get_list("Bin", fields=["actual_qty"], filters={"item_code": code}, limit=1)
		if bins and flt_(bins[0].get("actual_qty")):
			run.fail(code, "has stock — tracking cannot be cleared without a reversal")
			continue
		what = "{} ({}): clear batch/serial".format(code, (it.get("item_name") or "")[:28])
		if not run.apply:
			run.would(what)
			continue
		ok, err = _put(t, "Item", code, {"has_batch_no": 0, "has_serial_no": 0, "create_new_batch": 0})
		run.note(what) if ok else run.fail(what, err)


def flt_(v):
	try:
		return float(v or 0)
	except (TypeError, ValueError):
		return 0.0


def _receipt(run, rows, remarks):
	"""One back-dated Material Receipt. `rows` is [(item, warehouse, qty, rate)]."""
	t = run.t
	if not rows:
		print("    · nothing to receive")
		return
	total = sum(qty * rate for _i, _w, qty, rate in rows)
	what = "receive {} line(s) dated {} (value {:,.0f})".format(len(rows), OPENING_DATE, total)

	if not run.apply:
		run.would(what)
		for item, wh, qty, rate in rows[:40]:
			print("        {:<26} {:<38} {:>12,.2f} @ {:,.2f}".format(item[:26], wh[:38], qty, rate))
		if len(rows) > 40:
			print("        … and {} more".format(len(rows) - 40))
		return
	ok, res = t.insert("Stock Entry", {
		"doctype": "Stock Entry",
		"stock_entry_type": "Material Receipt",
		"purpose": "Material Receipt",
		"company": COMPANY,
		"set_posting_time": 1,
		"posting_date": OPENING_DATE,
		"posting_time": "00:00:00",
		"remarks": remarks,
		"items": [
			{"item_code": item, "qty": qty, "t_warehouse": wh, "basic_rate": rate,
			 "allow_zero_valuation_rate": 0}
			for item, wh, qty, rate in rows
		],
	})
	if not ok:
		run.fail(what, res)
		return
	sok, serr = t.submit("Stock Entry", res)
	run.note("{} — {}".format(what, res)) if sok else run.fail("submit " + res, serr)


def drug_stock(run):
	"""Opening stock for the drug store, back-dated so back-dated events work."""
	t = run.t
	store = "{} - {}".format(DRUG_STORE, _abbr(t))
	rows = []
	for code, _name, _uom, qty, rate in DRUG_ITEMS:
		bins = t.get_list("Bin", fields=["actual_qty"],
		                  filters={"item_code": code, "warehouse": store}, limit=1)
		if bins and float(bins[0]["actual_qty"] or 0) > 0:
			run.already("{} already stocked".format(code))
			continue
		rows.append((code, store, qty, rate))
	_receipt(run, rows, "Livestock drug store opening stock (setup_livestock_ops.py)")


def _daily_demand(t):
	"""Raw material a day of feeding needs, in STOCK UOM, exploding concentrate.

	Read off the target's own herds and BOMs rather than hardcoded, so the figure
	follows whatever the BOMs actually say. Head count comes from the herd record
	— it overstates, since it counts retired animals too, which for sizing an
	opening receipt is the safe direction.
	"""
	demand = defaultdict(float)
	boms = {}

	def explode(bom_name, qty):
		if bom_name not in boms:
			boms[bom_name] = _doc(t, "BOM", bom_name)
		doc = boms[bom_name]
		base = float(doc.get("quantity") or 1) or 1.0
		factor = qty / base
		for row in doc.get("items", []):
			stock_qty = float(row.get("stock_qty") or 0) * factor
			sub = row.get("bom_no")
			if sub:
				explode(sub, stock_qty)
			else:
				demand[row["item_code"]] += stock_qty

	for herd in t.get_list("Herds", fields=["name", "number_of_animals", "bom"], limit=100):
		bom, heads = herd.get("bom"), int(herd.get("number_of_animals") or 0)
		if not bom or heads <= 0:
			continue
		doc = _doc(t, "BOM", bom)
		per_head = float(doc.get("quantity") or 0)
		if per_head > 100:
			# A concentrate batch recipe standing in for a ration — see the module
			# docstring. Sizing stock off it would ask for tonnes a day.
			continue
		explode(bom, per_head * heads)
	return demand


def feed_stock(run, days):
	"""Enough raw material to actually run the feeding programme for `days`."""
	t = run.t
	demand = _daily_demand(t)
	if not demand:
		print("    ! no herd has a usable per-head BOM — nothing to size against")
		return
	rows = []
	for item, per_day in sorted(demand.items()):
		wh = FEED_HOME.get(item, FEED_HOME_DEFAULT)
		have = t.get_list("Bin", fields=["actual_qty"],
		                  filters={"item_code": item, "warehouse": wh}, limit=1)
		on_hand = float(have[0]["actual_qty"] or 0) if have else 0.0
		want = per_day * days
		short = want - on_hand
		if short <= 0:
			run.already("{} has {:,.2f} ({} days' cover)".format(item, on_hand, days))
			continue
		rows.append((item, wh, round(short, 2), FEED_RATES.get(item, 1.0)))
	print("    daily demand across every herd with a per-head BOM:")
	for item, per_day in sorted(demand.items()):
		print("        {:<26} {:>12,.2f} /day".format(item[:26], per_day))
	_receipt(run, rows, "Livestock feed opening stock, {} days (setup_livestock_ops.py)".format(days))


def settings(run):
	"""Point Livestock Settings at the company, the stores and the concentrates."""
	t = run.t
	store = "{} - {}".format(DRUG_STORE, _abbr(t))
	current = _doc(t, "Livestock Settings", "Livestock Settings")

	payload = {
		"custom_default_company": COMPANY,
		"custom_feed_wip_warehouse": FEED_WIP_STORE,
		"drug_warehouse": store,
		"semen_warehouse": store,
		"semen_item": SEMEN_ITEM,
	}
	if "feed_source_warehouses" in current:
		# A name that does not resolve is dropped rather than failing the write —
		# but say so. Warehouse names differ in capitalisation between sites
		# ("Silage pit 1 Next to hay store" here, "Silage Pit 1 Next to Hay Store"
		# there), and a store silently missing from the search order is a feeding
		# run that cannot find its silage.
		rows, dropped = [], []
		for wh, note in FEED_SOURCES:
			(rows if _exists(t, "Warehouse", wh) else dropped).append((wh, note))
		for wh, _n in dropped:
			print("    ! no warehouse named {!r} — dropped from the search order".format(wh))
		payload["feed_source_warehouses"] = [{"warehouse": wh, "note": note} for wh, note in rows]

		conc, missing = [], []
		for item, note in BOUGHT_IN:
			(conc if _exists(t, "Item", item) else missing).append((item, note))
		for item, _n in missing:
			print("    ! no item {!r} — not listed as a bought-in concentrate".format(item))
		payload["bought_in_concentrates"] = [{"item": item, "note": note} for item, note in conc]
	else:
		print("    ! feed_source_warehouses not deployed — writing the scalar fields only")

	unchanged = all(current.get(k) == v for k, v in payload.items() if not isinstance(v, list))
	if unchanged and current.get("feed_source_warehouses"):
		run.already("Livestock Settings")
		return
	if not run.apply:
		for k, v in payload.items():
			run.would("set {} = {}".format(k, v if not isinstance(v, list) else "{} row(s)".format(len(v))))
		return
	ok, err = _put(t, "Livestock Settings", "Livestock Settings", payload)
	run.note("Livestock Settings") if ok else run.fail("Livestock Settings", err)


def event_types(run):
	"""Flag which event types consume drugs."""
	t = run.t
	for name in CONSUMING_TYPES:
		if not _exists(t, "Livestock Event Type", name):
			run.fail(name, "event type does not exist on the target")
			continue
		doc = _doc(t, "Livestock Event Type", name)
		if "consumes_drugs" not in doc:
			print("    ! consumes_drugs not deployed — skipping {}".format(name))
			continue
		if doc.get("consumes_drugs"):
			run.already("{} consumes_drugs".format(name))
			continue
		if not run.apply:
			run.would("flag {} as drug-consuming".format(name))
			continue
		ok, err = _put(t, "Livestock Event Type", name, {"consumes_drugs": 1})
		run.note("{} consumes_drugs".format(name)) if ok else run.fail(name, err)


def wo_perms(run):
	"""Give the roles that run a feed batch permission to create the documents.

	`frappe.permissions.add_permission` is not whitelisted, so the Custom DocPerm
	rows are written directly. That carries a trap Frappe's own helper handles:
	the first custom row on a doctype REPLACES its standard permissions entirely.
	So when a doctype has none, the standard set is copied in first — otherwise
	granting a livestock role would silently revoke Manufacturing User.
	"""
	t = run.t
	# `set_user_permissions` and `select` are refused by Frappe's query guard, so
	# they are not copied; both default to 0 on a new row, which is the safe side.
	COPY = ["role", "permlevel", "read", "write", "create", "delete", "submit", "cancel",
	        "amend", "report", "export", "share", "print", "email", "if_owner"]

	for doctype, roles in WO_GRANTS.items():
		custom = t.get_list("Custom DocPerm", fields=["name", "role", "permlevel"] + COPY[2:],
		                    filters={"parent": doctype}, limit=200)
		if custom:
			holders = sorted(r["role"] for r in custom if r.get("create") and not r.get("permlevel"))
			print("    {} has custom permissions — can create: {}".format(doctype, ", ".join(holders) or "NOBODY"))
		else:
			std = t._request("GET", "/api/resource/DocPerm",
			                 params={"filters": json.dumps([["parent", "=", doctype]]),
			                         "fields": json.dumps(COPY), "parent": "DocType", "limit_page_length": 0})
			rows = (std.json().get("data") or []) if std.ok else None
			if rows is None:
				run.fail(doctype, "no custom permissions and the standard set is not readable — refusing to replace it")
				continue
			print("    {} uses standard permissions — copying {} row(s) in first".format(doctype, len(rows)))
			if run.apply:
				for r_ in rows:
					payload = {"doctype": "Custom DocPerm", "parent": doctype,
					           "parenttype": "DocType", "parentfield": "permissions"}
					payload.update({k: r_.get(k) for k in COPY if r_.get(k) is not None})
					ok, res = t.insert("Custom DocPerm", payload)
					if not ok:
						run.fail("{} copy {}".format(doctype, r_.get("role")), res)
				custom = t.get_list("Custom DocPerm", fields=["name", "role", "permlevel"] + COPY[2:],
				                    filters={"parent": doctype}, limit=200)
			else:
				run.would("{}: copy {} standard row(s) into Custom DocPerm".format(doctype, len(rows)))

		by_role = {r["role"]: r for r in custom if not r.get("permlevel")}
		for role, flags in roles.items():
			if not t.get_list("Role", fields=["name"], filters={"name": role}, limit=1):
				run.fail("{} / {}".format(doctype, role), "role does not exist on the target")
				continue
			want = {PERM_FLAG[f]: 1 for f in flags}
			have = by_role.get(role)
			if have and all(have.get(k) for k in want):
				run.already("{} / {}".format(doctype, role))
				continue
			what = "{} / {}: {}".format(doctype, role, ", ".join(sorted(want)))
			if not run.apply:
				run.would(what)
				continue
			if have:
				ok, err = _put(t, "Custom DocPerm", have["name"], want)
			else:
				payload = {"doctype": "Custom DocPerm", "parent": doctype,
				           "parenttype": "DocType", "parentfield": "permissions",
				           "role": role, "permlevel": 0}
				payload.update(want)
				ok, err = t.insert("Custom DocPerm", payload)
			run.note(what) if ok else run.fail(what, err)


def report_bad_boms(run):
	"""Name the herds whose BOM is a concentrate recipe, and stop there."""
	t = run.t
	bad, none = [], []
	for herd in t.get_list("Herds", fields=["name", "number_of_animals", "bom"], limit=100):
		if not herd.get("bom"):
			none.append(herd)
			continue
		doc = _doc(t, "BOM", herd["bom"])
		if float(doc.get("quantity") or 0) > 100:
			bad.append((herd, doc))
	for herd, doc in bad:
		heads = int(herd.get("number_of_animals") or 0)
		print("    ! {:<26} -> {} is a {:,.0f} {} batch recipe, not a ration".format(
			herd["name"][:26], doc["name"], float(doc["quantity"]), doc.get("uom")))
		print("      manufacturing for {} head would ask for {:,.0f} {}".format(
			heads, float(doc["quantity"]) * heads, doc.get("uom")))
	for herd in none:
		print("    ! {:<26} has no BOM — it cannot be fed through the programme".format(herd["name"][:26]))
	if bad or none:
		print("      Not fixed here: a ration is a nutrition decision, and no correct")
		print("      version exists on any site to copy. Someone who feeds these animals")
		print("      has to say what goes in.")
	else:
		print("    · every herd BOM looks like a per-head ration")


STEPS = [
	("preflight", preflight, "is the branch deployed?"),
	("hay_uom", hay_uom, "conversion rows the BOMs rely on"),
	("item_flags", item_flags, "batch/serial tracking wrongly set on feed items"),
	("drug_store", drug_store, "the livestock drug store"),
	("drug_items", drug_items, "the drugs themselves"),
	("settings", settings, "company, stores, concentrates"),
	("event_types", event_types, "which types consume drugs"),
	("drug_stock", drug_stock, "opening stock for the drug store"),
	("feed_stock", feed_stock, "raw material to feed from"),
	("wo_perms", wo_perms, "who may create a Work Order / BOM / Stock Entry"),
	("bad_boms", report_bad_boms, "herds whose BOM is wrong (report only)"),
]


def main():
	p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	p.add_argument("--apply", action="store_true", help="write; without it this only reports")
	p.add_argument("--days", type=int, default=30, help="days of feed cover to seed (default 30)")
	p.add_argument("--only", help="comma-separated step names")
	args = p.parse_args()

	t = T.Target()
	print(t.describe())
	print("user:", t.whoami())
	print("mode:", "APPLY — this writes" if args.apply else "dry run — nothing is written")
	print()

	wanted = set(args.only.split(",")) if args.only else None
	run = Run(t, args.apply)
	for name, fn, why in STEPS:
		if wanted and name not in wanted:
			continue
		print("[{}] {}".format(name, why))
		try:
			fn(run, args.days) if name == "feed_stock" else fn(run)
		except Exception as e:
			run.fail(name, e)
		print()

	print("=" * 70)
	print("{} change(s), {} already in place, {} failure(s)".format(
		len(run.did), len(run.skipped), len(run.failed)))
	for what, why in run.failed:
		print("  FAILED  {} — {}".format(what, str(why)[:160]))
	return 1 if run.failed else 0


if __name__ == "__main__":
	sys.exit(main())
