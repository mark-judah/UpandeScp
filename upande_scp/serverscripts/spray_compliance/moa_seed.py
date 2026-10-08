"""Seed `Active Ingredient MoA` for the ingredients on the Karen Roses approved
list. Sources: FRAC Code List 2024, IRAC MoA Classification v11. Code names follow
this site's masters (`M1`, not `M01`). Fill-blanks-only; run:

    bench --site kaitet.local execute upande_scp.serverscripts.spray_compliance.moa_seed.seed --kwargs '{"dry_run": false}'
"""

import frappe

F, I = "Fungicide", "Insecticide"
SEED = [
	# --- fungicides / bactericides (FRAC) ---
	{"ingredient": "Azoxystrobin", "kind": F, "frac_code": "11"},
	{"ingredient": "Kresoxim-methyl", "kind": F, "frac_code": "11"},
	{"ingredient": "Fluoxastrobin", "kind": F, "frac_code": "11"},
	{"ingredient": "Boscalid", "kind": F, "frac_code": "7", "aliases": "Nicobifen"},
	{"ingredient": "Fluxapyroxad", "kind": F, "frac_code": "7"},
	{"ingredient": "Difenoconazole", "kind": F, "frac_code": "3"},
	{"ingredient": "Spiroxamine", "kind": F, "frac_code": "5"},
	{"ingredient": "Dodemorph acetate", "kind": F, "frac_code": "5", "aliases": "Dodemorph"},
	{"ingredient": "Propamocarb hydrochloride", "kind": F, "frac_code": "28", "aliases": "Propamocarb\nPropamocarb HCl"},
	{"ingredient": "Fluopicolide", "kind": F, "frac_code": "43"},
	{"ingredient": "Iprovalicarb", "kind": F, "frac_code": "40"},
	{"ingredient": "Dimethomorph", "kind": F, "frac_code": "40"},
	{"ingredient": "Mandipropamid", "kind": F, "frac_code": "40"},
	{"ingredient": "Copper", "kind": F, "frac_code": "M1", "aliases": "Copper hydroxide\nCopper oxychloride"},
	{"ingredient": "Sulphur", "kind": F, "frac_code": "M2", "aliases": "Sulfur"},
	{"ingredient": "Mancozeb", "kind": F, "frac_code": "M3"},
	{"ingredient": "Metalaxyl", "kind": F, "frac_code": "4"},
	{"ingredient": "Metalaxyl-M", "kind": F, "frac_code": "4", "aliases": "Mefenoxam"},
	{"ingredient": "Bupirimate", "kind": F, "frac_code": "8"},
	{"ingredient": "Ametoctradin", "kind": F, "frac_code": "45", "aliases": "Initium\nEnervin\nBAS 650 F"},
	{"ingredient": "Polyoxin B", "kind": F, "frac_code": "19", "aliases": "Polyoxin"},
	{"ingredient": "Fosetyl-aluminium", "kind": F, "frac_code": "P7", "aliases": "Fosetyl-Al\nFosetyl aluminium\nFosetyl"},
	{"ingredient": "Cymoxanil", "kind": F, "frac_code": "27"},
	{"ingredient": "Tolclofos-methyl", "kind": F, "frac_code": "14"},
	{"ingredient": "Pyrimethanil", "kind": F, "frac_code": "9", "aliases": "Pyremethanil"},
	{"ingredient": "Cyprodinil", "kind": F, "frac_code": "9"},
	{"ingredient": "Fludioxonil", "kind": F, "frac_code": "12", "aliases": "Fludioxinil"},
	{"ingredient": "Fenhexamid", "kind": F, "frac_code": "17"},
	{"ingredient": "Chrysophanol", "kind": F, "frac_code": "P5"},
	# --- insecticides / acaricides (IRAC) ---
	{"ingredient": "Flubendiamide", "kind": I, "irac_code": "28"},
	{"ingredient": "Spinetoram", "kind": I, "irac_code": "5"},
	{"ingredient": "Spinosad", "kind": I, "irac_code": "5"},
	{"ingredient": "Emamectin benzoate", "kind": I, "irac_code": "6", "aliases": "Emamectin\nEmmamectin benzoate"},
	{"ingredient": "Abamectin", "kind": I, "irac_code": "6"},
	{"ingredient": "Lufenuron", "kind": I, "irac_code": "15"},
	{"ingredient": "Thiocyclam", "kind": I, "irac_code": "14", "aliases": "Thiocyclam hydrogen oxalate"},
	{"ingredient": "Thiosultap-monosodium", "kind": I, "irac_code": "14", "aliases": "Monosultap\nMonsaultap"},
	{"ingredient": "Flometoquin", "kind": I, "irac_code": "34"},
	{"ingredient": "Acetamiprid", "kind": I, "irac_code": "4A"},
	{"ingredient": "Flupyradifurone", "kind": I, "irac_code": "4D"},
	{"ingredient": "Fluxametamide", "kind": I, "irac_code": "30"},
	{"ingredient": "Spirotetramat", "kind": I, "irac_code": "23", "aliases": "Sprirotetramat"},
	{"ingredient": "Buprofezin", "kind": I, "irac_code": "16"},
	{"ingredient": "Pyrethrins", "kind": I, "irac_code": "3A", "aliases": "Pyrethrum\nPyrethrin"},
	{"ingredient": "Methoxyfenozide", "kind": I, "irac_code": "18"},
	{"ingredient": "Chlorfenapyr", "kind": I, "irac_code": "13", "aliases": "Chlorfemepyr"},
	{"ingredient": "Flonicamid", "kind": I, "irac_code": "29", "aliases": "IKI-220"},
	{"ingredient": "Azadirachtin", "kind": I, "irac_code": "UN", "aliases": "Margosa extract\nNeem"},
	{"ingredient": "Oxymatrine", "kind": I, "irac_code": "UN", "aliases": "Matrine\nProsuler oxymatrine"},
	# --- biologicals ---
	{"ingredient": "Bacillus thuringiensis kurstaki", "kind": "Biological", "irac_code": "11A",
	 "aliases": "Bacillus thuringensis\nBacillus thuringiensis\nBt kurstaki"},
	{"ingredient": "Helicoverpa armigera nucleopolyhedrovirus", "kind": "Biological", "irac_code": "31", "aliases": "HearNPV"},
	{"ingredient": "Cryptophlebia leucotreta granulovirus", "kind": "Biological", "irac_code": "31", "aliases": "CrleGV\nCrleGV-SA"},
	{"ingredient": "Beauveria bassiana", "kind": "Biological", "irac_code": "UNF"},
	{"ingredient": "Lecanicillium muscarium", "kind": "Biological", "irac_code": "UNF", "aliases": "Verticillium lecanii\nLecanicillium"},
	# --- non-target ---
	{"ingredient": "Organosilicone", "kind": "Adjuvant"},
	{"ingredient": "Daminozide", "kind": "Plant Growth Regulator"},
]


def _ensure_code(doctype, code, created):
	if code and not frappe.db.exists(doctype, code):
		field = "frac_code" if doctype == "FRAC Code" else "moa_group"
		frappe.get_doc({"doctype": doctype, field: code}).insert(ignore_permissions=True)
		created.append(f"{doctype} {code}")


def seed(dry_run=True, commit=None):
	dry_run = frappe.parse_json(dry_run) if isinstance(dry_run, str) else dry_run
	commit = (not dry_run) if commit is None else commit
	report = {"created": [], "codes_created": [], "unchanged": []}
	for row in SEED:
		if frappe.db.exists("Active Ingredient MoA", row["ingredient"]):
			report["unchanged"].append(row["ingredient"])
			continue
		report["created"].append(row["ingredient"])
		if dry_run:
			continue
		_ensure_code("FRAC Code", row.get("frac_code"), report["codes_created"])
		_ensure_code("IRAC Code", row.get("irac_code"), report["codes_created"])
		frappe.get_doc({"doctype": "Active Ingredient MoA", **row}).insert(ignore_permissions=True)
	if commit and not dry_run:
		frappe.db.commit()
	return report
