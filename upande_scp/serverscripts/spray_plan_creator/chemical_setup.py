"""Chemical setup worklist: chemicals actually SPRAYED lately whose master data is
incomplete, so the logsheet chemistry columns (and the resistance rules) can be filled.

Gaps checked per Spray Product: active ingredient, concentration on every ingredient,
WHO toxicity class, FLO HML category, PHI days, and a FRAC (fungicide) / IRAC
(insecticide) group on the ingredient's Active Ingredient MoA record.
"""

import frappe
from frappe.utils import add_days, cint, flt, today

GAP_LABELS = {
	"active_ingredients": "Active ingredient",
	"concentration": "Concentration",
	"toxicity": "Toxicity class",
	"fairtrade_hml": "HML category",
	"phi_days": "PHI days",
	"moa_code": "FRAC/IRAC group",
}


def product_gaps(product, moa_lookup):
	"""List of gap keys for one Spray Product (doc/dict). `moa_lookup(name)` returns
	the Active Ingredient MoA row ({frac_code, irac_code}) or None."""
	gaps = []
	ais = [a for a in (product.get("active_ingredients") or [])
	       if (a.get("active_ingredient") or a.get("ingredient"))]
	if not ais:
		gaps.append("active_ingredients")
	elif any(not flt(a.get("concentration")) or not a.get("concentration_unit") for a in ais):
		gaps.append("concentration")
	if not product.get("toxicity"):
		gaps.append("toxicity")
	if not product.get("fairtrade_hml"):
		gaps.append("fairtrade_hml")
	if not flt(product.get("phi_days")):
		gaps.append("phi_days")
	ptype = product.get("type")
	need = "frac_code" if ptype == "Fungicide" else "irac_code" if ptype == "Insecticide" else None
	if need and ais:
		have = False
		for a in ais:
			moa = moa_lookup(a.get("active_ingredient") or a.get("ingredient"))
			if moa and moa.get(need):
				have = True
				break
		if not have:
			gaps.append("moa_code")
	elif need and not ais:
		gaps.append("moa_code")
	return gaps


def sprayed_products(days=90):
	"""{item_code: times_sprayed} for the last `days` days of logsheet rows."""
	from upande_scp.serverscripts.spray_plan_creator.logsheet_chemistry import _resolve_item

	rows = frappe.db.sql(
		"""select p.pesticide_name, count(*) n, max(s.work_order) wo
		   from `tabSpray Application Pesticide` p
		   join `tabSpray Application Logsheet` s on s.name = p.parent
		   where s.docstatus < 2 and s.date >= %s and ifnull(p.pesticide_name,'') <> ''
		   group by p.pesticide_name""",
		(add_days(today(), -cint(days)),),
		as_dict=True,
	)
	out = {}
	for r in rows:
		item = _resolve_item(r.pesticide_name, {})
		if item:
			out[item] = out.get(item, 0) + cint(r.n)
	return out


@frappe.whitelist()
def get_chemical_setup(days=90):
	"""Worklist rows, worst first, plus per-field counts."""
	frappe.only_for(("System Manager", "SCP General Manager", "Administrator"))
	days = cint(days) or 90
	used = sprayed_products(days)
	moas = {}

	def moa_lookup(name):
		if not name:
			return None
		if name not in moas:
			moas[name] = frappe.db.get_value(
				"Active Ingredient MoA", name, ["frac_code", "irac_code"], as_dict=True
			) or frappe.db.get_value(
				"Active Ingredient MoA", {"ingredient": name}, ["frac_code", "irac_code"], as_dict=True
			)
		return moas[name]

	rows, counts = [], {k: 0 for k in GAP_LABELS}
	for item, n in used.items():
		pname = frappe.db.get_value("Spray Product", {"item": item}, "name")
		if not pname:
			rows.append({"item_code": item, "item_name": frappe.db.get_value("Item", item, "item_name"),
			             "product": None, "times_sprayed": n, "gaps": ["active_ingredients"],
			             "no_product": 1})
			counts["active_ingredients"] += 1
			continue
		doc = frappe.get_cached_doc("Spray Product", pname)
		gaps = product_gaps(doc, moa_lookup)
		if not gaps:
			continue
		for g in gaps:
			counts[g] += 1
		rows.append({"item_code": item, "item_name": doc.product_name or item, "product": pname,
		             "type": doc.type, "times_sprayed": n, "gaps": gaps, "no_product": 0})
	rows.sort(key=lambda r: (-len(r["gaps"]), -r["times_sprayed"]))
	return {"days": days, "chemicals_used": len(used), "with_gaps": len(rows),
	        "counts": counts, "labels": GAP_LABELS, "rows": rows}
