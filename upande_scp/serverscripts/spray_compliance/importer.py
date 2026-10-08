"""Load the Karen Roses approved-pesticide sheet onto Spray Products.

    # dry run — writes a report, changes nothing
    bench --site kaitet.local execute upande_scp.serverscripts.spray_compliance.importer.import_roses_sheet
    # apply after review
    bench --site kaitet.local execute upande_scp.serverscripts.spray_compliance.importer.import_roses_sheet --kwargs '{"apply": true}'

Fill-blanks-only and idempotent. Never creates or deletes a Spray Product.
"""

import csv
import html
import os
import re

import frappe
from frappe.utils import now_datetime

from .ingredients import build_index, match_ingredient, normalise, parse_entries

DEFAULT_SHEET = os.path.join(frappe.get_app_path("upande_scp"), "..", "doc references", "CHemicals",
                             "Crop Protection Agents + Target Pest.xlsx")

TARGET_MAP = {
	"caterpillars helicoverpa": "Helicoverpa", "bollworms": "Helicoverpa", "helicoverpa": "Helicoverpa",
	"caterpillars spodoptera": "Spodoptera", "spodoptera": "Spodoptera", "caterpillars": "Caterpillars",
	"thrips": "Thrips", "aphids": "Aphids", "whiteflies": "Whiteflies", "spidermites": "Spidermites",
	"mealybugs": "Mealybugs", "fcm": "FCM",
	"botrytis": "Botrytis", "powdery mildew": "Powdery Mildew", "downy mildew": "Downy Mildew",
	"agrobacterium": "Agrobacterium",
	"adjuvant": None, "plant growth regulator": None,
}
FORMULATIONS = {"SC", "WG", "WP", "EC", "SL", "SP", "CS", "EW", "WSG", "TM"}


def split_targets(text) -> list[str]:
	parts = re.split(r",|&|\band\b", text or "")
	return [p.strip() for p in parts if p.strip()]


def map_target(phrase):
	key = normalise(phrase)
	if key not in TARGET_MAP:
		return None, "unmapped"
	name = TARGET_MAP[key]
	return (name, "mapped") if name else (None, "non_target")


def normalise_trade_name(s) -> str:
	s = re.sub(r"\([^)]*\)", " ", (s or "").replace("\xa0", " ").upper())
	s = re.sub(r"(\d)([A-Z])", r"\1 \2", s)
	s = re.sub(r"([A-Z])(\d)", r"\1 \2", s)
	words = [w for w in re.split(r"[^A-Z0-9]+", s) if w]
	words = [w for w in words if w not in FORMULATIONS and not re.fullmatch(r"\d+(\.\d+)?", w)]
	return " ".join(words)


def read_sheet(path) -> list[dict]:
	import openpyxl
	ws = openpyxl.load_workbook(path, data_only=True).worksheets[0]
	out = []
	for r in ws.iter_rows(min_row=5, values_only=True):
		if not r or not r[1]:
			continue
		out.append({"sno": str(r[0] or "").strip(), "trade_name": str(r[1]).strip(),
		            "reg_no": str(r[2] or "").strip(), "ingredients_raw": str(r[5] or "").strip(),
		            "targets_raw": str(r[6] or "").strip(), "crop": str(r[7] or "").strip()})
	return out


def _products_by_name():
	by_full, by_first = {}, {}
	for p in frappe.get_all("Spray Product", filters={"disabled": 0, "category": "Chemical"},
	                        fields=["name", "product_name", "type", "registration_no"]):
		n = normalise_trade_name(p.product_name or p.name)
		by_full.setdefault(n, []).append(p)
		if n:
			by_first.setdefault(n.split()[0], []).append(p)
	return by_full, by_first


def _moa_index():
	rows = frappe.get_all("Active Ingredient MoA", fields=["ingredient", "aliases", "kind", "frac_code", "irac_code"])
	return build_index(rows), {r.ingredient: r for r in rows}


def plan(rows) -> list[dict]:
	by_full, by_first = _products_by_name()
	index, moa = _moa_index()
	out = []
	for row in rows:
		n = normalise_trade_name(row["trade_name"])
		products = by_full.get(n) or []
		how = "full" if products else None
		if not products and n:
			products = by_first.get(n.split()[0]) or []
			how = "first-word" if products else None
		targets, unmapped, non_target = [], [], False
		for phrase in split_targets(row["targets_raw"]):
			name, status = map_target(phrase)
			if status == "mapped":
				if any(t["name"] == name for t in targets):
					continue
				kind = "pest" if frappe.db.exists("Pest", name) else "disease"
				targets.append({"name": name, "kind": kind})
			elif status == "non_target":
				non_target = True
			else:
				unmapped.append(phrase)
		ingredients, unknown, entries = [], [], []
		for e in parse_entries(row["ingredients_raw"]):
			canon = match_ingredient(e["name"], index)
			(ingredients if canon else unknown).append(canon or e["name"])
			entries.append({**e, "ingredient": canon})
		kinds = {moa[i].kind for i in ingredients}
		if kinds and kinds <= {"Adjuvant", "Plant Growth Regulator"}:
			non_target = True
		irac = sorted({moa[i].irac_code for i in ingredients if moa[i].irac_code})
		frac = sorted({moa[i].frac_code for i in ingredients if moa[i].frac_code})
		for p in products:
			fix = None
			if non_target and p.type and p.type not in ("Insecticide", "Fungicide", "Adjuvant", "Plant Growth Regulator"):
				fix = None  # pH Buffer and the like are never overwritten
			elif non_target:
				want = "Plant Growth Regulator" if "Plant Growth Regulator" in kinds or "growth" in row["targets_raw"].lower() else "Adjuvant"
				fix = want if p.type != want else None
			elif frac and not irac and p.type == "Insecticide":
				fix = "Fungicide"
			elif irac and not frac and p.type == "Fungicide":
				fix = "Insecticide"
			elif not p.type and (frac or irac):
				fix = "Fungicide" if frac and not irac else "Insecticide" if irac and not frac else None
			p["_type_fix"] = fix
		out.append({**row, "match": how, "matched": [p.name for p in products],
		            "matched_names": [p.product_name for p in products],
		            "type_fix": next((p["_type_fix"] for p in products if p["_type_fix"]), None),
		            "type_fixes": {p.name: p["_type_fix"] for p in products if p["_type_fix"]},
		            "targets": targets, "unmapped_targets": unmapped, "non_target": non_target,
		            "ingredients": ingredients, "unknown_ingredients": unknown, "entries": entries,
		            "no_concentration": [e["name"] for e in entries if e["concentration"] is None],
		            "irac": irac, "frac": frac})
	return out


def _apply(row):
	for item in row["matched"]:
		doc = frappe.get_doc("Spray Product", item)
		have_t = {(t.pest or t.disease) for t in doc.default_targets}
		for t in row["targets"]:
			if t["name"] not in have_t:
				doc.append("default_targets", {t["kind"]: t["name"]})
				have_t.add(t["name"])
		for e in row["entries"]:
			# The same ingredient already on the product, by link or by its label text.
			keys = {k for k in (normalise(e["name"]), normalise(e["raw"]), normalise(e["ingredient"] or "")) if k}
			existing = next((a for a in doc.active_ingredients
			                 if (e["ingredient"] and a.active_ingredient == e["ingredient"])
			                 or (normalise(a.ingredient) and normalise(a.ingredient) in keys)), None)
			if existing is None:
				doc.append("active_ingredients", {"active_ingredient": e["ingredient"], "concentration": e["concentration"],
				                                  "concentration_unit": e["unit"], "ingredient": e["raw"]})
				continue
			if not existing.active_ingredient and e["ingredient"]:
				existing.active_ingredient = e["ingredient"]
			if existing.concentration in (None, 0) and e["concentration"] is not None:
				existing.concentration = e["concentration"]
				existing.concentration_unit = e["unit"]
		# Codes are NOT written here: they come live from the linked ingredients (spec D9).
		if row["reg_no"] and not doc.registration_no:
			doc.registration_no = row["reg_no"]
		fix = row["type_fixes"].get(item)
		if fix:
			doc.type = fix
		doc.save(ignore_permissions=True)


@frappe.whitelist()
def migrate_existing_ingredients(apply=False, commit=True):
	"""Link the free-text Active Ingredient rows already on Spray Products and pull
	their concentration out of the text ("50g/l Difenoconazole"). Unlinked rows only;
	the text itself is never changed. Returns matched / unmatched for the report."""
	apply = frappe.parse_json(apply) if isinstance(apply, str) else apply
	index, _ = _moa_index()
	matched, unmatched, multi = [], [], []
	for r in frappe.db.sql("""select name, parent, ingredient, concentration from `tabActive Ingredient`
	                          where parenttype='Spray Product' and parentfield='active_ingredients'
	                            and ifnull(active_ingredient,'')=''""", as_dict=True):
		entries = parse_entries(r.ingredient or "")
		if len(entries) > 1:
			multi.append({"product": r.parent, "text": r.ingredient})
			continue
		e = entries[0] if entries else None
		canon = match_ingredient(e["name"], index) if e else None
		if not canon:
			unmatched.append({"product": r.parent, "text": r.ingredient})
			continue
		values = {"active_ingredient": canon}
		if not r.concentration and e["concentration"] is not None:
			values.update(concentration=e["concentration"], concentration_unit=e["unit"])
		matched.append({"product": r.parent, "text": r.ingredient, **values})
		if apply:
			frappe.db.set_value("Active Ingredient", r.name, values, update_modified=False)
	if apply and commit:
		frappe.db.commit()
	return {"matched": matched, "unmatched": unmatched, "multi": multi, "applied": bool(apply)}


def _write_report(rows, summary, applied=False) -> str:
	ts = now_datetime().strftime("%Y%m%d-%H%M%S")
	base = frappe.get_site_path("private", "files", f"spray_compliance_import_{'applied_' if applied else 'dryrun_'}{ts}")
	cols = ["sno", "trade_name", "match", "matched", "matched_names", "targets", "unmapped_targets",
	        "non_target", "ingredients", "unknown_ingredients", "no_concentration", "irac", "frac", "type_fixes", "reg_no"]
	with open(base + ".csv", "w", newline="") as f:
		w = csv.writer(f)
		w.writerow(cols)
		for r in rows:
			w.writerow([", ".join(t["name"] for t in r[c]) if c == "targets" else
			            ", ".join(f"{k}: {v}" for k, v in r[c].items()) if isinstance(r[c], dict) else
			            ", ".join(map(str, r[c])) if isinstance(r[c], list) else r[c] for c in cols])
	cells = "".join("<tr>" + "".join(f"<td>{html.escape(str(', '.join(f'{k}: {v}' for k, v in r[c].items()) if isinstance(r[c], dict) else r[c] if not isinstance(r[c], list) else ', '.join(t['name'] if isinstance(t, dict) else str(t) for t in r[c])))}</td>" for c in cols) + "</tr>" for r in rows)
	with open(base + ".html", "w") as f:
		f.write(f"<!doctype html><meta charset=utf-8><title>Spray product import</title>"
		        f"<pre>{html.escape(frappe.as_json(summary))}</pre><table border=1 cellpadding=4>"
		        f"<tr>{''.join(f'<th>{c}</th>' for c in cols)}</tr>{cells}</table>")
	return base + ".html"


@frappe.whitelist()
def import_roses_sheet(path=None, apply=False, commit=True, accept=None):
	"""accept: sheet trade names whose first-word or duplicate matches the reviewer
	has confirmed; those rows are skipped on apply otherwise."""
	apply = frappe.parse_json(apply) if isinstance(apply, str) else apply
	accept = set(frappe.parse_json(accept) if isinstance(accept, str) else accept or [])
	if apply and not frappe.db.count("Active Ingredient MoA"):
		frappe.throw("Active Ingredient MoA is empty — seed it before applying the import.")
	rows = plan(read_sheet(path or DEFAULT_SHEET))
	summary = {
		"rows": len(rows),
		"matched": sum(1 for r in rows if r["matched"]),
		"unmatched": [r["trade_name"] for r in rows if not r["matched"]],
		"duplicates": {r["trade_name"]: r["matched_names"] for r in rows if len(r["matched"]) > 1},
		"first_word_matches": {r["trade_name"]: r["matched_names"] for r in rows if r["match"] == "first-word"},
		"unmapped_targets": sorted({t for r in rows for t in r["unmapped_targets"]}),
		"unknown_ingredients": sorted({i for r in rows for i in r["unknown_ingredients"]}),
		"type_fixes": {k: v for r in rows for k, v in r["type_fixes"].items()},
		"no_concentration": {r["trade_name"]: r["no_concentration"] for r in rows if r["no_concentration"]},
		"applied": bool(apply),
		"skipped_unconfirmed": [],
	}
	if apply:
		for r in rows:
			if not r["matched"]:
				continue
			if (r["match"] == "first-word" or len(r["matched"]) > 1) and r["trade_name"] not in accept:
				summary["skipped_unconfirmed"].append(
					{"trade_name": r["trade_name"], "match": r["match"], "matched": r["matched_names"]})
				continue
			_apply(r)
		if commit:
			frappe.db.commit()
	return {"rows": rows, "summary": summary, "report_file": _write_report(rows, summary, bool(apply))}
