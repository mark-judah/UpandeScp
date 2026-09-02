"""Site conventions for the tank mix: its Item Group, its UOM, its Company.

These were literals scattered through the codebase — ``"Chemical Mix"``,
``"Tank Mix (1000L)"``, ``"Karen Roses"``, ``"Roses"`` — each of which is one
site's data written into another site's code. On `kaitetv16-staging` the company
literal alone makes `create_bom` fail outright, because no company by that name
exists there.

Three different kinds of value, so three different resolutions:

* **Item Group / UOM** are genuinely a per-site convention with no existing
  source of truth, so they become settings fields, seeded with the values the
  code used to hardcode. Nothing changes on kaitet; a new site can differ.
* **Company** is never a convention. It is derivable — the farm has one, and
  ERPNext has a global default — so it is derived, never configured.
* **Business unit** is an Accounting Dimension. Not ours to invent a default
  for; where the column is absent we simply do not set it.
"""

import frappe

SETTINGS = "Scouting and Crop Protection Settings"

#: What the code hardcoded before these became settings. Kept as the seeded
#: default so an existing site converges on exactly its current behaviour.
DEFAULT_ITEM_GROUP = "Chemical Mix"
DEFAULT_UOM = "Tank Mix (1000L)"


def _setting(fieldname, fallback):
	try:
		value = frappe.get_cached_value(SETTINGS, SETTINGS, fieldname)
	except Exception:
		return fallback
	return value or fallback


def tank_mix_item_group() -> str:
	"""Item Group that marks a BOM (and its produced Item) as a tank mix."""
	return _setting("tank_mix_item_group", DEFAULT_ITEM_GROUP)


def tank_mix_uom() -> str:
	"""UOM a tank-mix BOM is defined in. One unit is one batch."""
	return _setting("tank_mix_uom", DEFAULT_UOM)


def resolve_company(farm: str | None = None) -> str | None:
	"""The company a tank-mix BOM or work order belongs to.

	Order: the farm's own company, then ERPNext's global default. Returns None
	when neither resolves, so the caller raises a clear error instead of
	creating a document against the wrong company.

	Never a literal. ``company = "Karen Roses"`` is the single line that stopped
	`create_bom` working on any site that is not kaitet.
	"""
	if farm:
		company = frappe.db.get_value("Farm", farm, "company")
		if company:
			return company
	return frappe.defaults.get_global_default("company") or None


def ensure_tank_mix_conventions():
	"""after_migrate: make sure the configured Item Group and UOM exist.

	A settings Link field pointing at a record that was never created is the
	same failure as the hardcoded name it replaced, so the records are created
	rather than assumed. Idempotent; leaves an operator's own choice alone and
	only fills a blank setting.
	"""
	if not frappe.db.table_exists("Item Group") or not frappe.db.table_exists("UOM"):
		return

	group = _setting("tank_mix_item_group", DEFAULT_ITEM_GROUP)
	if not frappe.db.exists("Item Group", group):
		parent = frappe.db.get_value("Item Group", {"is_group": 1, "parent_item_group": ""})
		doc = frappe.new_doc("Item Group")
		doc.item_group_name = group
		if parent:
			doc.parent_item_group = parent
		doc.is_group = 0
		doc.insert(ignore_permissions=True)

	uom = _setting("tank_mix_uom", DEFAULT_UOM)
	if not frappe.db.exists("UOM", uom):
		frappe.get_doc({"doctype": "UOM", "uom_name": uom, "must_be_whole_number": 0}).insert(
			ignore_permissions=True
		)

	# Seed the settings themselves so the values are visible and editable rather
	# than implicit in this module's fallbacks.
	if frappe.db.exists("DocType", SETTINGS):
		updates = {}
		if frappe.get_meta(SETTINGS).get_field("tank_mix_item_group") and not frappe.db.get_single_value(
			SETTINGS, "tank_mix_item_group"
		):
			updates["tank_mix_item_group"] = group
		if frappe.get_meta(SETTINGS).get_field("tank_mix_uom") and not frappe.db.get_single_value(
			SETTINGS, "tank_mix_uom"
		):
			updates["tank_mix_uom"] = uom
		for field, value in updates.items():
			frappe.db.set_single_value(SETTINGS, field, value)
