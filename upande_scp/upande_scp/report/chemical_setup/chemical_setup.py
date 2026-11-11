import frappe
from frappe import _

from upande_scp.serverscripts.spray_plan_creator.chemical_setup import GAP_LABELS, get_chemical_setup


def execute(filters=None):
	days = int((filters or {}).get("days") or 90)
	res = get_chemical_setup(days)
	columns = [
		{"label": _("Product"), "fieldname": "product", "fieldtype": "Link", "options": "Spray Product", "width": 140},
		{"label": _("Name"), "fieldname": "item_name", "fieldtype": "Data", "width": 220},
		{"label": _("Type"), "fieldname": "type", "fieldtype": "Data", "width": 100},
		{"label": _("Times sprayed"), "fieldname": "times_sprayed", "fieldtype": "Int", "width": 110},
	] + [
		{"label": _(lbl), "fieldname": k, "fieldtype": "Data", "width": 120}
		for k, lbl in GAP_LABELS.items()
	]
	data = []
	for r in res["rows"]:
		row = {k: r.get(k) for k in ("product", "item_name", "type", "times_sprayed")}
		for k in GAP_LABELS:
			row[k] = "MISSING" if k in r["gaps"] else ""
		data.append(row)
	summary = [{"label": _("Used chemicals with gaps"), "value": f"{res['with_gaps']} / {res['chemicals_used']}",
	            "indicator": "Red" if res["with_gaps"] else "Green"}] + [
		{"label": _(lbl), "value": res["counts"][k], "indicator": "Orange" if res["counts"][k] else "Green"}
		for k, lbl in GAP_LABELS.items()
	]
	return columns, data, None, None, summary
