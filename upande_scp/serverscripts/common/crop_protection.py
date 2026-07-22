"""Crop-protection product resolution (Chemical / Foliar).

Single source of truth for "is this Item a chemical / foliar?" and for
resolving a product's effective rate/targets for a crop. Replaces the old
hardcoded, case-inconsistent `item_group in ("CHEMICALS"/...)` string tests.

Which Item Groups hold chemicals vs foliars is configured on the settings
Single (`chemical_item_groups` / `foliar_item_groups`), so the classification
is data-driven. A product's metadata lives on the `Chemical` / `Foliar`
sidecar doctype (1:1 with the Item); per-crop overrides live on
`Chemical Crop Profile` / `Foliar Crop Profile`, falling back to the master's
`default_*` values.
"""

from urllib.parse import quote

import frappe

# The settings Single. Kept as a constant so a future rename touches one place.
SETTINGS = "Scouting and Crop Protection Settings"

# (master doctype, crop-profile doctype, profile link field)
_PRODUCTS = (
	("Chemical", "Chemical Crop Profile", "chemical"),
	("Foliar", "Foliar Crop Profile", "foliar"),
)


def _settings():
	return frappe.get_cached_doc(SETTINGS)


def chemical_groups():
	"""Item Group names configured as chemical groups."""
	return [r.item_group for r in (_settings().get("chemical_item_groups") or []) if r.item_group]


def foliar_groups():
	"""Item Group names configured as foliar groups."""
	return [r.item_group for r in (_settings().get("foliar_item_groups") or []) if r.item_group]


def classify_item_group(item_group):
	"""Return 'chemical' | 'foliar' | None for an Item Group name."""
	if not item_group:
		return None
	if item_group in chemical_groups():
		return "chemical"
	if item_group in foliar_groups():
		return "foliar"
	return None


def is_chemical(item_code):
	return bool(item_code and frappe.db.exists("Chemical", {"item": item_code}))


def is_foliar(item_code):
	return bool(item_code and frappe.db.exists("Foliar", {"item": item_code}))


def get_chemical(item_code):
	name = frappe.db.get_value("Chemical", {"item": item_code}, "name")
	return frappe.get_cached_doc("Chemical", name) if name else None


def get_foliar(item_code):
	name = frappe.db.get_value("Foliar", {"item": item_code}, "name")
	return frappe.get_cached_doc("Foliar", name) if name else None


def _master_for(item_code):
	"""Return (master_doctype, master_name, profile_doctype, link_field) for the
	product record (Chemical or Foliar) tied to `item_code`, or None."""
	for master_dt, profile_dt, link in _PRODUCTS:
		name = frappe.db.get_value(master_dt, {"item": item_code}, "name")
		if name:
			return master_dt, name, profile_dt, link
	return None


def get_product_rate(item_code, crop=None):
	"""Effective (lower, upper) rate limits per 1000L.

	Prefers the Chemical/Foliar sidecar (crop profile override -> master
	default); falls back to the legacy Item custom fields when no sidecar
	exists (e.g. fertilizers, or pre-migration items). This keeps behaviour
	identical while making the sidecar authoritative for chemicals/foliars.
	"""
	resolved = _master_for(item_code)
	if not resolved:
		d = frappe.db.get_value(
			"Item", item_code,
			["custom_lower_rate_limit", "custom_upper_rate_limit"], as_dict=True,
		)
		return (d.custom_lower_rate_limit, d.custom_upper_rate_limit) if d else (None, None)
	master_dt, name, profile_dt, link = resolved
	if crop:
		prof = frappe.db.get_value(
			profile_dt, {link: name, "crop": crop},
			["lower_rate_limit", "upper_rate_limit"], as_dict=True,
		)
		if prof and (prof.lower_rate_limit or prof.upper_rate_limit):
			return (prof.lower_rate_limit, prof.upper_rate_limit)
	d = frappe.db.get_value(
		master_dt, name,
		["default_lower_rate_limit", "default_upper_rate_limit"], as_dict=True,
	)
	return (d.default_lower_rate_limit, d.default_upper_rate_limit) if d else (None, None)


def get_product_targets(item_code, crop=None):
	"""Effective target rows (list of {pest, disease}): crop profile if present
	and non-empty, else master default_targets."""
	resolved = _master_for(item_code)
	if not resolved:
		return frappe.get_all(
			"Chemical Targets",
			filters={"parent": item_code, "parenttype": "Item", "parentfield": "custom_targets"},
			fields=["pest", "disease"],
		)
	master_dt, name, profile_dt, link = resolved
	if crop:
		profile_name = frappe.db.get_value(profile_dt, {link: name, "crop": crop}, "name")
		if profile_name:
			rows = frappe.get_all(
				"Chemical Targets",
				filters={"parent": profile_name, "parentfield": "targets"},
				fields=["pest", "disease"],
			)
			if rows:
				return rows
	return frappe.get_all(
		"Chemical Targets",
		filters={"parent": name, "parentfield": "default_targets"},
		fields=["pest", "disease"],
	)


def get_product_type(item_code):
	"""Product type (Insecticide/Fungicide/...): sidecar first, else Item."""
	m = _master_for(item_code)
	if m:
		master_dt, name, _, _ = m
		return frappe.db.get_value(master_dt, name, "type")
	return frappe.db.get_value("Item", item_code, "custom_type")


def get_product_codes(item_code, kind):
	"""IRAC/FRAC/GHS code values for a product: sidecar first, else Item.

	kind: 'irac' | 'frac' | 'ghs'. Child doctype is e.g. 'IRAC Code Filter'.
	"""
	child_dt = f"{kind.upper()} Code Filter"
	m = _master_for(item_code)
	if m:
		master_dt, name, _, _ = m
		rows = frappe.get_all(
			child_dt,
			filters={"parent": name, "parenttype": master_dt, "parentfield": kind},
			fields=["code"],
		)
		return [r.code for r in rows if r.code]
	rows = frappe.get_all(
		child_dt,
		filters={"parent": item_code, "parenttype": "Item", "parentfield": f"custom_{kind}"},
		fields=["code"],
	)
	return [r.code for r in rows if r.code]


def crop_protection_item_codes(kind=None):
	"""Item codes under the configured chemical/foliar groups.

	kind: 'chemical' | 'foliar' | None (both). Replaces the old
	`{"item_group": "CHEMICALS"}` filters.
	"""
	groups = []
	if kind in (None, "chemical"):
		groups += chemical_groups()
	if kind in (None, "foliar"):
		groups += foliar_groups()
	if not groups:
		return []
	return frappe.get_all("Item", filters={"item_group": ["in", groups]}, pluck="name")


# Legacy Item custom_* fields copied into a new sidecar. Scalars first, then
# child tables (source custom field -> sidecar field).
_LEGACY_SCALARS = {
	"custom_type": "type",
	"custom_toxicity": "toxicity",
	"custom_reentry_interval_hrs": "reentry_interval_hrs",
	"custom_lower_rate_limit": "default_lower_rate_limit",
	"custom_upper_rate_limit": "default_upper_rate_limit",
	"custom_low_stock_threshold": "low_stock_threshold",
	"custom_irac_moa": "irac_moa",
	"custom_frac_moa": "frac_moa",
	"custom_ghs_description": "ghs_description",
}
_LEGACY_CHILDREN = {
	"custom_active_ingredients": "active_ingredients",
	"custom_targets": "default_targets",
	"custom_chemical_intervention_threshhold": "default_requirements",
	"custom_irac": "irac",
	"custom_frac": "frac",
	"custom_ghs": "ghs",
}
_CHILD_STD = {
	"name", "parent", "parenttype", "parentfield", "idx", "doctype",
	"owner", "creation", "modified", "modified_by", "docstatus",
}


def _copy_legacy_fields(item, doc):
	"""Copy an Item's chemical custom_* values into a new sidecar doc."""
	for src, dst in _LEGACY_SCALARS.items():
		val = item.get(src)
		if val not in (None, ""):
			doc.set(dst, val)
	for src, dst in _LEGACY_CHILDREN.items():
		for row in (item.get(src) or []):
			d = row.as_dict()
			doc.append(dst, {k: v for k, v in d.items()
			                 if k not in _CHILD_STD and not str(k).startswith("_")})


def ensure_product_record(item_code):
	"""Create a Chemical/Foliar for an Item if its group is configured and none
	exists, copying any legacy Item custom_* values. Returns (doctype, name)
	when created, else None."""
	item_group = frappe.db.get_value("Item", item_code, "item_group")
	kind = classify_item_group(item_group)
	target = None
	if kind == "chemical" and not is_chemical(item_code):
		target = "Chemical"
	elif kind == "foliar" and not is_foliar(item_code):
		target = "Foliar"
	if not target:
		return None
	item = frappe.get_doc("Item", item_code)
	doc = frappe.new_doc(target)
	doc.item = item_code
	_copy_legacy_fields(item, doc)
	doc.insert(ignore_permissions=True)
	return (target, doc.name)


def on_item_after_insert(doc, method=None):
	"""doc_events hook: auto-register a new chemical/foliar-group Item and tell
	the user (a desk modal) that the sidecar record was created."""
	try:
		result = ensure_product_record(doc.name)
	except Exception:
		frappe.logger().exception("crop_protection.on_item_after_insert failed")
		return
	if result:
		doctype, name = result
		route = frappe.scrub(doctype).replace("_", "-")
		link = f"/app/{route}/{quote(name)}"
		frappe.msgprint(
			f'Registered as {doctype}. <a href="{link}">Open the {doctype} record</a> '
			"to add its metadata.",
			title="Crop Protection",
			indicator="green",
		)


@frappe.whitelist()
def export_to_chemicals():
	"""Backfill: ensure a Chemical exists for every Item under the configured
	chemical groups. Idempotent."""
	return _export("chemical")


@frappe.whitelist()
def export_to_foliars():
	"""Backfill: ensure a Foliar exists for every Item under the configured
	foliar groups. Idempotent."""
	return _export("foliar")


def _export(kind):
	created = 0
	codes = crop_protection_item_codes(kind)
	for code in codes:
		if ensure_product_record(code):
			created += 1
	frappe.db.commit()
	return {"kind": kind, "scanned": len(codes), "created": created}
