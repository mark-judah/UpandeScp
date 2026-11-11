"""Predator master clean-up + stages + prey + the Biologicals stock items. Idempotent.

Before (kaitet.local, 2026-11-11): four "predators" - Phytoseiulus, Carlifonicus (a
misspelling of Neoseiulus californicus), and Nymphs / Eggs, which are life STAGES - each with
one stage row named after itself, no scientific names, no prey.

What this does, each step safe to repeat:
  1. Stage master has Eggs / Nymph / Adult.
  2. "Carlifonicus" -> "Neoseiulus californicus" (Frappe rename: every link follows).
  3. Predators Scouting Entry rows re-pointed: the species-named stage becomes Adult; the
     "Nymphs" predator's rows go to a species + stage Nymph (the species counted in the same
     entry when there is exactly one, else Phytoseiulus, reported as assumed).
  4. "Nymphs" and "Eggs" removed from the Predator master and the crop Predator Filter.
  5. Each predator gets kind, scientific name, legend colour, Eggs/Nymph/Adult stages, prey
     (Predator Targets with efficacy, stage and cited source) and its Biologicals item.

    bench --site kaitet.local execute upande_scp.serverscripts.biologicals.seed_predators.run
"""

import frappe

ITEM_GROUP = "Biologicals"
STAGES = ("Eggs", "Nymph", "Adult")
STAGE_ROLE = {"Eggs": "diamond", "Nymph": "pentagon", "Adult": "circle"}

MCMURTRY = "McMurtry & Croft 1997, Annu. Rev. Entomol. 42:291-321"
GERSON = "Gerson & Weintraub 2007, Pest Manag. Sci. 63:658-676"

PREDATORS = {
	"Phytoseiulus": {
		"scientific_name": "Phytoseiulus persimilis", "kind": "Predatory Mite", "color": "#0d9488",
		"identification_guideline": (
			"Pear-shaped, shiny orange-red mite, faster than spider mites; adults ~0.5 mm, long legs. "
			"Eggs are oval, twice the size of spider-mite eggs and translucent. Nymphs are pale orange. "
			"Count motile stages on the underside of leaves among spider-mite colonies."),
		"item": "Phytoseiulus persimilis",
		"prey": [("Spidermites", "3 - Primary prey", None,
		          f"Type I specialist predator of Tetranychus spp. ({MCMURTRY}); {GERSON}.")],
	},
	"Neoseiulus californicus": {
		"scientific_name": "Neoseiulus californicus", "kind": "Predatory Mite", "color": "#7c3aed",
		"identification_guideline": (
			"Pale, translucent-to-pinkish pear-shaped mite, slightly smaller and less shiny than "
			"Phytoseiulus; tolerates heat and low prey density. Adults ~0.4 mm. Count motile stages on the leaf underside."),
		"item": "Neoseiulus californicus",
		"prey": [("Spidermites", "2 - Good", None,
		          f"Type II selective predator of tetranychids, persists at low prey density ({MCMURTRY}); Castagnoli & Simoni 2003, Exp. Appl. Acarol."),
		         ("Thrips", "1 - Supplementary", "Larvae",
		          f"Feeds on first-instar thrips larvae and pollen as alternative food ({GERSON}); Koppert Californicus-System product sheet.")],
	},
}


def _log(report, key, value):
	report.setdefault(key, []).append(value)


def ensure_stages(report):
	for name in STAGES:
		if not frappe.db.exists("Stage", name):
			frappe.get_doc({"doctype": "Stage", "stage_name": name, "icon_key": STAGE_ROLE[name],
			                "default_reading_type": "Count", "stage_role": "Life stage"}).insert(ignore_permissions=True)
			_log(report, "stages_created", name)


def ensure_group_and_items(report):
	if not frappe.db.exists("Item Group", ITEM_GROUP):
		frappe.get_doc({"doctype": "Item Group", "item_group_name": ITEM_GROUP, "parent_item_group": "All Item Groups",
		                "is_group": 0}).insert(ignore_permissions=True)
		_log(report, "item_group_created", ITEM_GROUP)
	_copy_chemical_accounts(report)
	for name, spec in PREDATORS.items():
		code = spec["item"]
		if not frappe.db.exists("Item", code):
			frappe.get_doc({"doctype": "Item", "item_code": code, "item_name": code, "item_group": ITEM_GROUP,
			                "stock_uom": "Bottle", "is_stock_item": 1, "include_item_in_manufacturing": 0,
			                "description": f"{spec['scientific_name']} biological control agent (released by spray supervisors)."}
			               ).insert(ignore_permissions=True)
			_log(report, "items_created", code)


def _copy_chemical_accounts(report):
	"""Biologicals sit in the chemicals inventory and expense accounts, company by company
	(Item Group defaults copied from CHEMICALS; without an inventory account ERPNext refuses
	to post the first issue)."""
	if not frappe.db.exists("Item Group", "CHEMICALS"):
		return
	group = frappe.get_doc("Item Group", ITEM_GROUP)
	have = {r.company for r in group.item_group_defaults}
	added = False
	for r in frappe.get_doc("Item Group", "CHEMICALS").item_group_defaults:
		if r.company not in have:
			group.append("item_group_defaults", {"company": r.company, "default_inventory_account": r.default_inventory_account,
			                                    "expense_account": r.expense_account})
			added = True
			_log(report, "group_accounts_copied", r.company)
	if added:
		group.save(ignore_permissions=True)


def rename_californicus(report):
	new = "Neoseiulus californicus"
	if frappe.db.exists("Predator", "Carlifonicus") and not frappe.db.exists("Predator", new):
		frappe.rename_doc("Predator", "Carlifonicus", new, force=True)
		_log(report, "renamed", f"Carlifonicus -> {new}")


def repoint_scouting(report):
	"""Predators Scouting Entry: species-named stage -> Adult; the 'Nymphs' / 'Eggs' predators -> species + stage."""
	T = "`tabPredators Scouting Entry`"
	for sp in ("Phytoseiulus", "Neoseiulus californicus"):
		frappe.db.sql(f"update {T} set stage='Adult' where predator=%s and (stage is null or stage in (%s,'Carlifonicus','Phytoseiulus',''))", (sp, sp))
	for stage_pred, stage in (("Nymphs", "Nymph"), ("Eggs", "Eggs")):
		rows = frappe.db.sql(f"select name, parent from {T} where predator=%s", stage_pred, as_dict=True)
		for r in rows:
			species = frappe.db.sql_list(f"select distinct predator from {T} where parent=%s and predator in %s",
			                             (r.parent, ("Phytoseiulus", "Neoseiulus californicus")))
			sp = species[0] if len(species) == 1 else "Phytoseiulus"
			frappe.db.sql(f"update {T} set predator=%s, stage=%s where name=%s", (sp, stage, r.name))
			_log(report, "scouting_repointed",
			     f"{r.parent}: {stage_pred} -> {sp} / {stage}" + ("" if len(species) == 1 else " (species not recorded, assumed Phytoseiulus)"))


def drop_stage_predators(report):
	for name in ("Nymphs", "Eggs"):
		if not frappe.db.exists("Predator", name):
			continue
		if frappe.db.count("Predators Scouting Entry", {"predator": name}):
			_log(report, "kept", f"{name} still referenced by scouting rows")
			continue
		frappe.db.delete("Predator Filter", {"predator": name})
		frappe.delete_doc("Predator", name, ignore_permissions=True, force=True)
		_log(report, "deleted", name)


def fill_predators(report):
	for name, spec in PREDATORS.items():
		if not frappe.db.exists("Predator", name):
			continue
		doc = frappe.get_doc("Predator", name)
		changed = False
		for field, value in (("scientific_name", spec["scientific_name"]), ("kind", spec["kind"]),
		                     ("predator_legend_color", spec["color"]), ("item", spec["item"]),
		                     ("identification_guideline", spec["identification_guideline"])):
			if not doc.get(field):
				doc.set(field, value)
				changed = True
		# stages: drop the legacy row named after the predator itself, add the three real ones
		sections = next((r.plant_sections for r in doc.predator_stages if r.plant_sections), "Top\nMiddle\nBottom\nBase")
		legacy = [r for r in doc.predator_stages if r.stage not in STAGES]
		have = {r.stage for r in doc.predator_stages}
		if legacy:
			doc.set("predator_stages", [r for r in doc.predator_stages if r.stage in STAGES])
			changed = True
		for st in STAGES:
			if st not in have:
				doc.append("predator_stages", {"stage": st, "reading_type": "Count", "plant_sections": sections})
				changed = True
		have_prey = {(r.pest, r.prey_stage or "") for r in doc.target_pest if r.pest}
		doc.set("target_pest", [r for r in doc.target_pest if r.pest])
		for pest, eff, stage, source in spec["prey"]:
			if (pest, stage or "") not in have_prey and frappe.db.exists("Pest", pest):
				doc.append("target_pest", {"pest": pest, "efficacy": eff, "prey_stage": stage, "source": source})
				changed = True
		if changed:
			doc.save(ignore_permissions=True)
			_log(report, "updated", name)


def ensure_filter(report):
	"""The crop's Predator Filter lists the two species (Rose)."""
	if not frappe.db.exists("Crop Scouted", "Rose"):
		return
	crop = frappe.get_doc("Crop Scouted", "Rose")
	have = {r.predator for r in crop.get("predators")}
	for name in PREDATORS:
		if name not in have and frappe.db.exists("Predator", name):
			crop.append("predators", {"predator": name})
			_log(report, "filter_added", name)
	if report.get("filter_added"):
		crop.save(ignore_permissions=True)


def run():
	report = {}
	ensure_stages(report)
	ensure_group_and_items(report)
	rename_californicus(report)
	repoint_scouting(report)
	drop_stage_predators(report)
	fill_predators(report)
	ensure_filter(report)
	frappe.db.commit()
	return report
