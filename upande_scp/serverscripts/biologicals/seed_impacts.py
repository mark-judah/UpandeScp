"""Seed `Active Ingredient Predator Impact` for the ingredients used on roses against the two
predators Kaitet releases (Phytoseiulus persimilis, Neoseiulus californicus).

Source of each class: the IOBC/WPRS side-effects scheme as summarised on the public
Koppert Side Effects database and the Biobest Side Effect Manual (toxicity to the adult
predator; classes 1 harmless <30%, 2 slightly harmful 30-79%, 3 moderately harmful 80-99%,
4 harmful >99% mortality in the lab test). These are class ASSIGNMENTS written down from those
public summaries, not copied tables, and NOT re-checked against the current lists on the day:
every row is `verified = 0` for the IPM lead, who should confirm it (and the persistence)
against the live databases before relying on a Block mode. `mortality_pct` is the class
midpoint (15 / 55 / 90 / 100), an estimate and not a measured figure.

Ingredients with no entry here (Flometoquin, Fluxametamide, Thiocyclam, Thiosultap-monosodium,
Oxymatrine, Dodemorph, Tolclofos-methyl, Chrysophanol, Fluoxastrobin, Ametoctradin, Daminozide,
Organosilicone) had no class the author could cite with confidence: left blank rather than
guessed. A blank is "no data", and the rule treats it as no claim.

FILLS BLANKS ONLY: an ingredient/predator pair that already has a row (an agronomist's, or a
later edit) is left alone.

    bench --site kaitet.local execute upande_scp.serverscripts.biologicals.seed_impacts.run
"""

import frappe

PP, NC = "Phytoseiulus", "Neoseiulus californicus"
CLASS_NAME = {1: "1 - Harmless", 2: "2 - Slightly harmful", 3: "3 - Moderately harmful", 4: "4 - Harmful"}
MORTALITY = {1: 15, 2: 55, 3: 90, 4: 100}
SRC = "IOBC/WPRS side-effects scheme; Koppert Side Effects database, Biobest Side Effect Manual (public summary, class recorded by hand, unverified)"

# ingredient: (class on PP, class on NC, persistence days of a harmful/slightly harmful residue, exposure)
DATA = {
	# insecticides / acaricides
	"Acetamiprid": (3, 3, 14), "Azadirachtin": (2, 2, 7), "Buprofezin": (1, 1, 0),
	"Chlorfenapyr": (4, 4, 28), "Emamectin benzoate": (4, 3, 21), "Flonicamid": (1, 1, 0),
	"Flubendiamide": (1, 1, 0), "Flupyradifurone": (2, 2, 7), "Lufenuron": (2, 2, 14),
	"Methoxyfenozide": (1, 1, 0), "Pyrethrins": (4, 4, 7), "Spinetoram": (3, 2, 14),
	"Spirotetramat": (2, 1, 7),
	# biologicals
	"Beauveria bassiana": (2, 2, 7), "Lecanicillium muscarium": (1, 1, 0),
	"Bacillus thuringiensis kurstaki": (1, 1, 0), "Helicoverpa armigera nucleopolyhedrovirus": (1, 1, 0),
	# fungicides
	"Sulphur": (4, 3, 14), "Copper": (2, 2, 7), "Mancozeb": (2, 2, 7), "Azoxystrobin": (2, 1, 7),
	"Kresoxim-methyl": (1, 1, 0), "Boscalid": (1, 1, 0), "Fluxapyroxad": (1, 1, 0),
	"Difenoconazole": (1, 1, 0), "Fenhexamid": (1, 1, 0), "Fludioxonil": (1, 1, 0),
	"Cyprodinil": (1, 1, 0), "Pyrimethanil": (1, 1, 0), "Dimethomorph": (1, 1, 0),
	"Mandipropamid": (1, 1, 0), "Metalaxyl": (1, 1, 0), "Metalaxyl-M": (1, 1, 0),
	"Fosetyl-aluminium": (1, 1, 0), "Propamocarb hydrochloride": (1, 1, 0), "Cymoxanil": (1, 1, 0),
	"Fluopicolide": (1, 1, 0), "Iprovalicarb": (1, 1, 0), "Spiroxamine": (2, 2, 7),
	"Polyoxin B": (1, 1, 0), "Bupirimate": (1, 1, 0),
}


def run():
	report = {"added": 0, "skipped_existing": 0, "missing_ingredient": []}
	for ingredient, (pp, nc, days) in DATA.items():
		if not frappe.db.exists("Active Ingredient MoA", ingredient):
			report["missing_ingredient"].append(ingredient)
			continue
		doc = frappe.get_doc("Active Ingredient MoA", ingredient)
		have = {r.predator for r in doc.predator_impacts}
		changed = False
		for predator, cls in ((PP, pp), (NC, nc)):
			if predator in have:
				report["skipped_existing"] += 1
				continue
			if not frappe.db.exists("Predator", predator):
				continue
			doc.append("predator_impacts", {
				"predator": predator, "impact_class": CLASS_NAME[cls], "mortality_pct": MORTALITY[cls],
				"persistence_days": days if cls > 1 else 0, "exposure": "Direct spray and residue", "verified": 0,
				"source": SRC})
			report["added"] += 1
			changed = True
		if changed:
			doc.save(ignore_permissions=True)
	frappe.db.commit()
	return report
