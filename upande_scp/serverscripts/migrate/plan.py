"""What to seed a training site with, and in what order.

Derived from the real dependency graph on `kaitet.local`: every `Link`, `Table`
and `Table MultiSelect` field pointing from one app-owned doctype at another. A
step may only reference doctypes from earlier steps, so loading them in order
means no link ever resolves to a document that is not there yet.

## What is here and what is not

**Masters and configuration only.** They are what makes the system behave
correctly, and they are small — about 1,300 rows for SCP and 415 for livestock.
Transactional history is deliberately excluded: it is not needed to learn the
system, and `Scouting Entry` alone is 297,131 rows with a metadata row each. If
trainees need something to look at, take a recent slice by `date_of_capture`
rather than the table.

**The geometry is not here either**, and cannot be: `Farm`, `Bed`, `Zone` and
`Orchard Tree` belong to `upande_core`, not this app. SCP is unusable without
them — scouting entries, spray plans and the maps all resolve through them — so
`preflight` checks for them and refuses to call a bare site ready.
"""

# Each step: (label, [doctypes]). Order between steps is load-bearing; order
# within a step is not.
SCP_STEPS = [
	(
		"observation and code masters",
		[
			"Pest",
			"Plant Disease",
			"Plant Section",
			"Stage",
			"FRAC Code",
			"IRAC Code",
			"GHS Code",
			"Incident",
			"Physiological Disorder",
			"Weed",
			"Trap",
			"Spray Team",
			"Tank And Valve",
		],
	),
	("predators (link to Pest)", ["Predator"]),
	("crops (gather the observation masters)", ["Crop Scouted"]),
	(
		"chemicals and per-crop filters",
		[
			"Chemical",
			"Foliar",
			"Pest Filter",
			"Disease Filter",
			"FRAC Guideline",
			"IRAC Guideline",
		],
	),
	("field layouts", ["Field Unit Automation"]),
]

LIVESTOCK_STEPS = [
	("herd and reference masters", ["Herds", "Livestock Disease", "Livestock Event Type", "Breeders"]),
	("animals (link to Herds)", ["Animal"]),
]

STEPS = {"upande_scp": SCP_STEPS, "upande_livestock": LIVESTOCK_STEPS}

# Submittable, so a plain insert leaves them as drafts. The push sets docstatus
# explicitly; without that, every Animal and Herd lands unsubmitted and behaves
# oddly in reports that filter on docstatus.
SUBMITTABLE = {
	"Animal",
	"Herds",
	"Livestock Event",
	"Livestock Health Case",
	"Livestock Disposal",
	"Livestock Diagnosis",
	"Milk Recording",
	"Milking Palour Checksheet",
	"Spray Application Logsheet",
}

# Singles — configuration, not records. Carried separately because they have no
# `name` to key on and are usually reviewed by hand on the target anyway.
SINGLES = {
	"upande_scp": ["Map Settings", "Scouting and Crop Protection Settings", "Spray Equipment"],
	"upande_livestock": ["Livestock Settings"],
}

# Owned by upande_core / ERPNext. Not ours to push, but nothing below works
# without them, so preflight reports on them.
PREREQUISITE_DOCTYPES = [
	("Farm", "upande_core", "every SCP master scopes to a farm"),
	("Warehouse", "ERPNext", "greenhouses and blocks; carries custom_farm"),
	("Bed", "upande_core", "beds, rows and coffee bands"),
	("Zone", "upande_core", "subdivisions of a bed"),
	("Orchard Tree", "upande_core", "avocado and coffee trees"),
	("Item", "ERPNext", "chemicals, foliars and varieties are Items"),
	("UOM", "ERPNext", "chemical rates and pack sizes"),
	("Item Group", "ERPNext", "decides what counts as a chemical"),
	("Employee", "ERPNext", "scouts, sprayers and supervisors"),
]

# Custom fields these doctypes carry that SCP reads. Most were made through
# Customize Form and have `module = NULL`, so they do NOT install with the app —
# a missing one surfaces as `1054 Unknown column` at query time rather than as a
# clean failure at import. preflight diffs the target against this site.
CUSTOM_FIELD_HOSTS = [
	"Warehouse",
	"Item",
	"Work Order",
	"BOM",
	"Stock Entry",
	"Cost Center",
	"Employee",
]


def doctypes_for(app):
	"""Flat list, in load order."""
	return [dt for _label, group in STEPS[app] for dt in group]


def all_doctypes():
	out = []
	for app in STEPS:
		out.extend(doctypes_for(app))
	return out
