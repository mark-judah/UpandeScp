"""Teach the shared `Bed` doctype that coffee units are called Bands.

`Bed` belongs to **upande_core**, not this app, and its `unit_type` Select ships
with `Bed` and `Row`. Coffee needs a third value, `Band`.

Editing another app's doctype JSON from here would be wrong — a core migration
would revert it, and a site running core without SCP would carry an option
nothing uses. A Property Setter is the supported way to extend a field you do not
own, and it is exactly what the desk's own Customize Form writes.

Why not a fixture: fixture sync **overwrites**, so shipping this as one would
clobber any option a site had added for itself. This appends instead, and only
when the value is genuinely absent, so it is safe to run on every migrate.

See `field_unit_automation.py` for what a Band actually is: a Row under its coffee
name, so nothing downstream needs to change.
"""

import frappe

UNIT_TYPES = ("Bed", "Row", "Band")


def ensure_unit_types():
	"""Append any missing `UNIT_TYPES` to `Bed.unit_type`, preserving order and
	anything the site added itself."""
	if not frappe.db.exists("DocType", "Bed"):
		# A site without upande_core installed. Nothing to extend.
		return

	meta = frappe.get_meta("Bed")
	field = meta.get_field("unit_type")
	if not field:
		frappe.log_error(
			"Bed has no `unit_type` field — coffee Bands cannot be declared.",
			"SCP Field Units",
		)
		return

	current = [o.strip() for o in (field.options or "").split("\n") if o.strip()]
	missing = [u for u in UNIT_TYPES if u not in current]
	if not missing:
		return

	options = "\n".join(current + missing)
	frappe.make_property_setter(
		{
			"doctype": "Bed",
			"fieldname": "unit_type",
			"property": "options",
			"value": options,
			"property_type": "Text",
		},
		is_system_generated=False,
	)
	frappe.clear_cache(doctype="Bed")


def after_migrate():
	ensure_unit_types()
