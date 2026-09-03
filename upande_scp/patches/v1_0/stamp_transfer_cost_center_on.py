"""Turn the CSU-transfer cost-centre stamp on for sites that already exist.

A Check field's `default` only applies to documents created after it is added, and
the settings Single predates this field everywhere. Worse, `get_single_value` casts
a missing Check to 0 rather than None, so an absent row is indistinguishable from a
deliberate OFF at read time — the default has to be written down, once, here.

ON is the right starting point: before this field existed the transfer was already
*meant* to carry the plan's cost centre (Mixing and Spray both stamp it), and on a
site whose Company has no default cost centre the transfer cannot be saved at all
without it — "Cost Center is mandatory for Item ...".

Only writes when the row is genuinely absent, so an admin who turns it off keeps it
off across every later migrate.
"""

import frappe

SETTINGS = "Scouting and Crop Protection Settings"
FIELD = "stamp_transfer_cost_center"


def execute():
	if not frappe.db.exists("DocType", SETTINGS):
		return

	already_set = frappe.db.sql(
		"SELECT value FROM `tabSingles` WHERE doctype = %s AND field = %s",
		(SETTINGS, FIELD),
	)
	if already_set:
		print(f"[stamp_transfer_cost_center_on] already set to {already_set[0][0]!r}, left alone")
		return

	frappe.db.set_single_value(SETTINGS, FIELD, 1)
	print(
		"[stamp_transfer_cost_center_on] on — CSU Chemical Transfers now carry the "
		"plan's cost centre. Settings → Accounts to turn it off."
	)
