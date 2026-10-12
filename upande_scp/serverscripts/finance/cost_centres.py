"""Farm <-> cost centre, and no silent fall back to the company default (B4, B9).

ERPNext attributes money by cost centre; SCP attributes it by farm and
greenhouse. These are the edges between the two:

* ``Farm.custom_cost_center`` — the farm's cost-centre GROUP (its tree). Budgets
  and the Finance Budget view work on this subtree.
* ``Farm.custom_purchase_cost_center`` — an optional LEAF where farm-level
  purchases and issues with no greenhouse book. When empty, a leaf named
  ``<Farm> Crop Protection - <abbr>`` is used if it exists. It is never created
  automatically; ``cost_centre_mapping.create_purchase_cost_center`` offers it.

Resolution for anything SCP stamps (issues, CSU transfers, loans, the
procurement MR): the warehouse's own cost centre (``match_cost_center``: the
explicit link, then the name match) -> the farm's purchase cost centre -> none.
"None" is reported on the document and in the log — never quietly replaced by
``Main - <abbr>``, which is how 51% of Karen Roses' chemical expense ended up on
a post-harvest cost centre.
"""
from __future__ import annotations

import frappe

LOGGER = "upande_scp.cost_centre"
PURCHASE_LEAF = "{farm} Crop Protection - {abbr}"


def _has_column(doctype: str, column: str) -> bool:
	try:
		return frappe.db.has_column(doctype, column)
	except Exception:
		return False


def farm_company(farm: str | None) -> str | None:
	if not farm:
		return None
	company = frappe.db.get_value("Farm", farm, "company") if _has_column("Farm", "company") else None
	if company:
		return company
	from upande_scp.serverscripts.spray_plan_creator.loaning_v2 import farm_company as by_store

	return by_store(farm)


def farm_cost_center(farm: str | None) -> str | None:
	"""The farm's cost-centre group, or None."""
	if not farm or not _has_column("Farm", "custom_cost_center"):
		return None
	return frappe.db.get_value("Farm", farm, "custom_cost_center") or None


def purchase_leaf_name(farm: str, company: str | None) -> str | None:
	abbr = frappe.db.get_value("Company", company, "abbr") if company else None
	return PURCHASE_LEAF.format(farm=farm, abbr=abbr) if abbr else None


def farm_purchase_cost_center(farm: str | None) -> str | None:
	"""Where a farm's unattributed spend books: the explicit leaf, else the named one."""
	if not farm:
		return None
	if _has_column("Farm", "custom_purchase_cost_center"):
		explicit = frappe.db.get_value("Farm", farm, "custom_purchase_cost_center")
		if explicit:
			return explicit
	name = purchase_leaf_name(farm, farm_company(farm))
	if name and frappe.db.exists("Cost Center", {"name": name, "is_group": 0, "disabled": 0}):
		return name
	return None


def resolve(warehouse: str | None = None, farm: str | None = None) -> tuple[str | None, str | None]:
	"""``(cost_center, source)`` for a line, or ``(None, None)``."""
	from upande_scp.serverscripts.spray_plan_creator.validation import match_cost_center

	if warehouse:
		cc = match_cost_center(warehouse)
		if cc:
			return cc, "warehouse"
		farm = farm or frappe.db.get_value("Warehouse", warehouse, "custom_farm")
	cc = farm_purchase_cost_center(farm)
	if cc:
		return cc, "farm purchase"
	return None, None


def company_default(company: str | None) -> str | None:
	if not company:
		return None
	return frappe.db.get_value("Company", company, "cost_center") or None


def report_missing(doc, context: str, fallback: str | None = None) -> str:
	"""B9: say so on the document and in the log. Does not block.

	``fallback`` names what the line will book to instead (ERPNext's own chain or
	the company default), so the comment says where the money actually went.
	"""
	where = f" It books to {fallback} instead." if fallback else " ERPNext's own default applies."
	msg = (
		f"No farm or greenhouse cost centre resolved for {context}.{where} "
		"Set Warehouse.custom_cost_center or the farm's purchase cost centre "
		"(Farm.custom_purchase_cost_center) so this spend lands on the farm."
	)
	frappe.logger(LOGGER).warning(f"{doc.doctype} {doc.name or '(new)'}: {msg}")
	try:
		if doc.name and frappe.db.exists(
			"Comment",
			{"reference_doctype": doc.doctype, "reference_name": doc.name, "content": msg},
		):
			# A hook runs on every save and submit; one note per document is enough.
			pass
		elif doc.name:
			c = frappe.get_doc({
				"doctype": "Comment",
				"comment_type": "Comment",
				"comment_email": frappe.session.user,
				"reference_doctype": doc.doctype,
				"reference_name": doc.name,
				"content": msg,
			})
			# The document may be mid-insert (a before_validate hook): its row is
			# written in this same transaction, so the link is checked by nobody.
			c.flags.ignore_links = True
			c.insert(ignore_permissions=True)
		else:
			doc.flags.setdefault("scp_cost_centre_notes", []).append(msg)
	except Exception:
		frappe.log_error(title="SCP cost centre note", message=frappe.get_traceback())
	return msg


def flush_notes(doc) -> None:
	"""Write notes collected before the document had a name."""
	notes = (doc.flags or {}).get("scp_cost_centre_notes") or []
	doc.flags.scp_cost_centre_notes = []
	for msg in notes:
		try:
			doc.add_comment("Comment", msg)
		except Exception:
			frappe.log_error(title="SCP cost centre note", message=frappe.get_traceback())


#: Where a farm's Business Unit (an ERPNext accounting dimension, fieldname
#: ``business_unit``) can be read from, in order: the farm itself, then its
#: cost centres. Each is checked for the column, because they are site fields.
_BU_FARM_FIELDS = ("custom_business_unit", "business_unit")


def dimension_default(company: str | None, dimension: str = "Business Unit") -> str | None:
	"""The accounting dimension's own default for the company, if one is configured."""
	if not company or not frappe.db.exists("Accounting Dimension", dimension):
		return None
	return frappe.db.get_value(
		"Accounting Dimension Detail",
		{"parent": dimension, "company": company, "default_dimension": ("is", "set")},
		"default_dimension",
	) or None


def business_unit_for(farm: str | None, company: str | None = None) -> str | None:
	"""The Business Unit a farm's spend belongs to, or None.

	Resolution: a Business Unit on the Farm -> on the farm's purchase or group cost
	centre -> the dimension's default for the company. Nothing is invented: a farm
	with none of these resolves to None and the document is left blank.
	"""
	if not _has_column("Material Request Item", "business_unit"):
		return None
	if farm:
		for col in _BU_FARM_FIELDS:
			if _has_column("Farm", col):
				v = frappe.db.get_value("Farm", farm, col)
				if v:
					return v
		if _has_column("Cost Center", "business_unit"):
			for cc in (farm_purchase_cost_center(farm), farm_cost_center(farm)):
				v = cc and frappe.db.get_value("Cost Center", cc, "business_unit")
				if v:
					return v
	return dimension_default(company or farm_company(farm))
