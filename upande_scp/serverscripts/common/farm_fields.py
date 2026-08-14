"""Declarative, non-destructive owner for SCP's `custom_farm` links.

Both doctypes here are shared: BOM with ERPNext manufacturing, Spray Team with
whatever else a site has bolted onto it. A site may therefore already carry its
own `custom_farm` — with its own label, its own `insert_after`, possibly even a
different fieldtype (the Item/Warehouse era left several such variants around).

**Existing fields are never touched.** `create_custom_fields(..., update=False)`
creates a field only when it is absent; where one exists the site's definition
wins, untouched. This is the whole reason these two moved out of the `fixtures`
list in hooks.py: `frappe.utils.fixtures.sync_fixtures` is documented as
"Import, **overwrite** fixtures", so every migrate re-imposed our exported
definition on top of whatever the site had. Fixtures cannot express
skip-if-present; this can.

The trade-off accepted deliberately: a site whose existing `custom_farm` is
wrong for SCP (say a Data field rather than a Link to Farm) will not be
corrected automatically. That is preferable to silently rewriting a field
another app or an operator put there — a mismatch is visible and fixable by
hand, a clobbered field is neither. `readers` in ``spray_plan_creator`` treat
the value as an opaque farm name, so a Data variant still reads correctly.

`Warehouse.custom_farm` is NOT here: it belongs to upande_core
(`upande_core/hooks.py` fixtures) and is that app's to declare. It carries the
same overwrite caveat.
"""

import frappe

MODULE = "Upande Scp"
FARM_LINK = {
	"label": "Farm",
	"fieldtype": "Link",
	"options": "Farm",
	"module": MODULE,
}


def _field_spec() -> dict:
	return {
		# Stamped by bom_resolver.create_bom_for_plan so a tank-mix BOM records
		# which farm's plan produced it. Read for display in the BomPicker.
		#
		# Deliberately NOT `reqd`, even though kaitet's own copy is: BOM is
		# ERPNext's, and a mandatory Farm would block every non-SCP BOM a site
		# creates through plain manufacturing. kaitet gets away with it because
		# every BOM there is an SCP tank mix (2562/2562 carry a farm); that is
		# not a safe assumption to ship. Existing fields are skipped, so
		# kaitet's `reqd` stays exactly as it is — this shape applies only where
		# the field is absent.
		"BOM": [{"fieldname": "custom_farm", "insert_after": "quantity", **FARM_LINK}],
		# Which farm a spray team belongs to. Soft cross-farm guard in
		# drafts._assert_in_scope; the primary team->farm match is by name
		# substring, so an absent or empty value degrades gracefully — hence not
		# `reqd` here either, matching kaitet.
		"Spray Team": [
			{
				"fieldname": "custom_farm",
				"insert_after": "team_name",
				"description": (
					"Restricts this spray team to a single farm."
				),
				"in_list_view": 1,
				"in_standard_filter": 1,
				**FARM_LINK,
			}
		],
	}


def ensure_farm_fields():
	"""after_migrate: create the `custom_farm` links only where absent."""
	from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

	spec = {dt: rows for dt, rows in _field_spec().items() if frappe.db.table_exists(dt)}
	if not spec:
		return

	# update=False is the point of this module: create when missing, and leave a
	# pre-existing field exactly as the site has it.
	create_custom_fields(spec, update=False)
