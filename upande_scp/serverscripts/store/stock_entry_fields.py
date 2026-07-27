"""Declarative owner for upande_scp's Stock Entry custom fields.

Stock Entry is an ERPNext doctype shared by four installed apps, so nothing here
may be assumed to exist. This module states the fields SCP needs and rebuilds
them on every ``after_migrate``, the same pattern upande_ta uses for its
biometric block (``upande_ta.upande_ta.overrides.stock_entry``).

Why declarative rather than a fixture: a fixture only restores what was last
exported from some site's database, so a field deleted anywhere is gone until
somebody re-exports. Declaring fields here means a reset-to-defaults, a fresh
install and a new site all converge.

Farm is deliberately NOT here. It is an ERPNext **Accounting Dimension**
(``Accounting Dimension`` record "Farm", fieldname ``farm``), which ERPNext
maintains across all 57 doctypes in the ``accounting_dimension_doctypes`` hook —
including Stock Entry and Stock Entry Detail — and carries into ``tabGL Entry``
for per-farm financial reporting. A bespoke ``custom_farm`` on a transaction
doctype is a redundant second source of truth for the same fact, so SCP writes
the dimension field instead (see ``auto_material_issue``, ``loaning``).

``Warehouse.custom_farm`` and ``Spray Team.custom_farm`` are a different thing
and stay: those are master-data links (which farm a greenhouse or team belongs
to), not per-transaction dimension values.

Placement is NOT this module's job beyond a starting anchor —
``common.scouting_tab_layout`` owns the final layout and groups the label fields
under the Scouting and Crop Protection tab. The ``insert_after`` values below
match what that enforcer converges on, so the two never fight.
"""

import frappe

MODULE = "Upande Scp"
MANAGED_DOCTYPES = ("Stock Entry", "Stock Entry Detail")

TAB = "custom_scouting_and_crop_protection_tab"


def _field_spec():
	return {
		"Stock Entry": [
			# Store-label print audit trail. Written by
			# spray_plan_ops.spray_plan_labels._stamp_labels_printed; read by
			# spray_plan_creator.lifecycle and store.store_keeper_api. Read-only
			# on the form — the values are stamped by the label run, never typed.
			{
				"fieldname": "custom_labels_printed",
				"label": "Labels Printed",
				"fieldtype": "Check",
				"insert_after": TAB,
				"read_only": 1,
				"module": MODULE,
			},
			{
				"fieldname": "custom_labels_printed_by",
				"label": "Labels Printed By",
				"fieldtype": "Data",
				"insert_after": "custom_labels_printed",
				"read_only": 1,
				"module": MODULE,
			},
			{
				"fieldname": "custom_labels_printed_on",
				"label": "Labels Printed On",
				"fieldtype": "Datetime",
				"insert_after": "custom_labels_printed_by",
				"read_only": 1,
				"module": MODULE,
			},
			{
				"fieldname": "custom_labels_print_count",
				"label": "Labels Print Count",
				"fieldtype": "Int",
				"insert_after": "custom_labels_printed_on",
				"read_only": 1,
				"module": MODULE,
			},
		],
		# Stock Entry Detail: nothing. Its `farm` field is the Farm accounting
		# dimension, owned and maintained by ERPNext.
	}


def _dimension_fieldnames():
	"""Fieldnames owned by ERPNext accounting dimensions (e.g. 'farm',
	'business_unit'). Never ours to create, update or delete."""
	return frappe.get_all("Accounting Dimension", pluck="fieldname") or []


def ensure_scp_stock_entry_fields():
	"""Create/update the fields above and prune SCP-owned Stock Entry fields no
	longer in the spec. Idempotent; a no-op before ERPNext's tables exist.

	The tab break itself is intentionally absent from the spec — it is created
	and anchored by ``common.scouting_tab_layout``, which runs after this on
	after_migrate. Fields anchored on it resolve fine either way: Frappe appends
	a custom field whose insert_after target is missing, and the enforcer then
	re-chains it.
	"""
	if not frappe.db.table_exists("Stock Entry"):
		return

	from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

	spec = _field_spec()
	create_custom_fields(spec, update=True)

	# Declarative reconciliation: an SCP-owned custom field on a managed doctype
	# that is not in the spec is stale. Two exemptions:
	#   * the tab break, owned by the layout enforcer rather than by this spec;
	#   * anything that is an accounting dimension. `Stock Entry Detail.farm`
	#     briefly carried this module's stamp before Farm was recognised as a
	#     dimension, and deleting a dimension field would silently strip farm
	#     attribution from stock ledger + GL entries. Belt-and-braces: the spec
	#     no longer claims it, and this refuses to drop it even if mis-stamped.
	protected = {TAB} | set(_dimension_fieldnames())
	for doctype in MANAGED_DOCTYPES:
		defined = {d["fieldname"] for d in spec.get(doctype, [])} | protected
		for row in frappe.get_all(
			"Custom Field",
			filters={"dt": doctype, "module": MODULE},
			fields=["name", "fieldname"],
		):
			if row.fieldname not in defined:
				frappe.delete_doc(
					"Custom Field", row.name, ignore_permissions=True, force=True
				)


def remove_scp_stock_entry_fields():
	"""Delete every SCP-owned custom field on the managed doctypes (uninstall)."""
	for doctype in MANAGED_DOCTYPES:
		for name in frappe.get_all(
			"Custom Field", filters={"dt": doctype, "module": MODULE}, pluck="name"
		):
			frappe.delete_doc("Custom Field", name, ignore_permissions=True, force=True)
