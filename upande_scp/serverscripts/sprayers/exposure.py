"""Sprayer Exposure rows, written from Spray Application Logsheets.

Everyone named on a submitted logsheet — applicators, both mixers and the
supervisor — was exposed to every product in its `pesticides` table for the
application's duration (spec S4). One row per (logsheet, employee, product),
so rebuilding a logsheet replaces its rows rather than adding to them.

Duration and hazard come from `common.exposure_rules`; this module only reads
the data those rules need and writes the result.
"""

from __future__ import annotations

import time

import frappe
from frappe.utils import now_datetime

from upande_scp.serverscripts.common import exposure_rules as R
from upande_scp.serverscripts.sprayers import register

SAL = "Spray Application Logsheet"
EXPOSURE = "Sprayer Exposure"

_INSERT_FIELDS = (
	"name", "creation", "modified", "owner", "modified_by", "docstatus", "idx",
	"sprayer", "employee", "employee_name", "role", "ppe_condition",
	"spray_application_logsheet", "work_order", "farm", "greenhouse", "source",
	"row_key", "spray_product", "product_name", "toxicity", "hazard_weight",
	"date", "started_at", "ended_at", "hours", "weighted_hours",
	"duration_source", "flags",
)


def product_index() -> dict:
	"""{lower(name): (spray_product, toxicity)} by product name, item name and id.

	The logsheet's `pesticide_name` is free text — the product's display name
	("Amisil"), never its item code — so all three spellings are indexed.
	"""
	rows = frappe.db.sql(
		"""SELECT sp.name, sp.product_name, sp.toxicity, i.item_name
		     FROM `tabSpray Product` sp
		     LEFT JOIN `tabItem` i ON i.name = sp.item""",
		as_dict=True,
	)
	idx: dict = {}
	for r in rows:
		for key in (r.item_name, r.product_name, r.name):
			if key:
				idx.setdefault(key.strip().lower(), (r.name, r.toxicity))
	return idx


def _sessions(work_order):
	if not work_order:
		return []
	return frappe.db.sql(
		"""SELECT started_at, ended_at FROM `tabSprayer Movement Session`
		    WHERE work_order = %s AND started_at IS NOT NULL AND ended_at IS NOT NULL
		      AND IFNULL(status, '') != 'Aborted'""",
		(work_order,),
	)


def build_rows(sal, products=None) -> list[dict]:
	"""The exposure rows a submitted logsheet implies. ``sal`` is a doc or dict."""
	get = sal.get
	products = products if products is not None else product_index()

	people = R.participants(
		applicators=[(a.get("applicator_name"), a.get("condition_of_ppe")) for a in get("applicators") or []],
		mixers=[get("persons_mixing_1"), get("persons_mixing_2")],
		supervisor=get("supervisor_name"),
	)
	if not people:
		return []

	session_pairs = []
	if not (get("custom_application_start_at") and get("custom_application_stop_at")):
		session_pairs = _sessions(get("work_order"))
	dur = R.resolve_duration(
		custom_start=get("custom_application_start_at"),
		custom_stop=get("custom_application_stop_at"),
		on_date=get("date"),
		start_time=get("application_start_time"),
		stop_time=get("application_stop_time"),
		sessions=session_pairs,
	)
	source = "Session" if dur["source"] == R.SOURCE_SESSION else "SAL"

	# One entry per product: a pesticide listed twice is one exposure.
	seen, items = set(), []
	for p in get("pesticides") or []:
		label = (p.get("pesticide_name") or "").strip()
		if not label:
			continue
		hit = products.get(label.lower())
		product, toxicity = (hit if hit else (None, None))
		toxicity = R.normalise_toxicity(toxicity) or R.normalise_toxicity(p.get("toxicity_class"))
		key = product or label
		if key in seen:
			continue
		seen.add(key)
		items.append((product, label, toxicity))

	sprayers = register.sprayer_map(list(people))
	names = {
		r.name: r.employee_name
		for r in frappe.get_all("Employee", filters={"name": ["in", list(people)]}, fields=["name", "employee_name"])
	}

	rows = []
	for emp, who in sorted(people.items()):
		for product, label, toxicity in items:
			weight, known = R.hazard_weight(toxicity)
			flags = list(dur["flags"])
			if not known:
				flags.append(R.FLAG_HAZARD_UNKNOWN)
			rows.append({
				"sprayer": sprayers.get(emp),
				"employee": emp,
				"employee_name": names.get(emp),
				"role": who["role"],
				"ppe_condition": who.get("ppe_condition"),
				"spray_application_logsheet": get("name"),
				"work_order": get("work_order"),
				"farm": get("farm"),
				"greenhouse": get("target_gh"),
				"source": source,
				"row_key": f"{get('name')}|{emp}|{product or label}"[:140],
				"spray_product": product,
				"product_name": label,
				"toxicity": toxicity,
				"hazard_weight": weight,
				"date": get("date"),
				"started_at": dur["started_at"],
				"ended_at": dur["ended_at"],
				"hours": dur["hours"],
				"weighted_hours": round(dur["hours"] * weight, 4),
				"duration_source": dur["source"],
				"flags": ", ".join(flags) or None,
			})
	return rows


def _insert(rows):
	if not rows:
		return
	now, user = now_datetime(), frappe.session.user
	values = []
	for r in rows:
		r = {**r, "name": frappe.generate_hash(length=12), "creation": now, "modified": now,
		     "owner": user, "modified_by": user, "docstatus": 0, "idx": 0}
		values.append(tuple(r.get(f) for f in _INSERT_FIELDS))
	frappe.db.bulk_insert(EXPOSURE, _INSERT_FIELDS, values)


def delete_for(sal_names) -> list[str]:
	"""Remove the rows of these logsheets. Returns the sprayers they touched."""
	sal_names = [s for s in sal_names if s]
	if not sal_names:
		return []
	touched = frappe.get_all(
		EXPOSURE, filters={"spray_application_logsheet": ["in", sal_names]}, pluck="sprayer", distinct=True
	)
	frappe.db.delete(EXPOSURE, {"spray_application_logsheet": ["in", sal_names]})
	return [t for t in touched if t]


def rebuild(sal, products=None, totals=True) -> dict:
	"""Replace one submitted logsheet's rows. ``sal`` is a doc or a name."""
	if isinstance(sal, str):
		sal = frappe.get_doc(SAL, sal)
	if sal.docstatus != 1:
		touched = delete_for([sal.name])
		if totals:
			register.recompute_totals(touched)
		return {"rows": 0}

	people = [a.applicator_name for a in sal.get("applicators") or []]
	people += [sal.persons_mixing_1, sal.persons_mixing_2, sal.supervisor_name]
	register.sync_sprayers([p for p in people if p])

	touched = set(delete_for([sal.name]))
	rows = build_rows(sal, products)
	_insert(rows)
	touched |= {r["sprayer"] for r in rows if r["sprayer"]}
	if totals:
		register.recompute_totals(sorted(touched))
	return {"rows": len(rows)}


# ───────────────────────────── doc events ────────────────────────────────


def on_submit(doc, method=None):
	"""Logsheet submitted (desk or end_spray_session): write its exposure.

	Never blocks the submit — a field crew's logsheet matters more than the
	ledger, which the nightly job and `backfill` can always rebuild.
	"""
	try:
		rebuild(doc)
	except Exception:
		frappe.log_error(title=f"Sprayer exposure: {doc.name}")


def on_cancel(doc, method=None):
	try:
		register.recompute_totals(delete_for([doc.name]))
	except Exception:
		frappe.log_error(title=f"Sprayer exposure cancel: {doc.name}")


# ───────────────────────────── backfill ──────────────────────────────────


def backfill(commit_every=50) -> dict:
	"""One-off (and safe to repeat): rebuild every submitted logsheet."""
	t0 = time.monotonic()
	sync = register.sync_sprayers()
	products = product_index()
	names = frappe.get_all(SAL, filters={"docstatus": 1}, pluck="name", order_by="date, name")
	rows = 0
	for i, name in enumerate(names, 1):
		sal = frappe.get_doc(SAL, name)
		frappe.db.delete(EXPOSURE, {"spray_application_logsheet": name})
		built = build_rows(sal, products)
		_insert(built)
		rows += len(built)
		if commit_every and i % commit_every == 0:
			frappe.db.commit()
	totals = register.recompute_totals()
	return {
		"logsheets": len(names),
		"rows": rows,
		"sync": sync,
		"totals_written": totals,
		"seconds": round(time.monotonic() - t0, 1),
	}
