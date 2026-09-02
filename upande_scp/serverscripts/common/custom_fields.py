"""Declarative owner for upande_scp's custom fields on shared ERPNext doctypes.

Every field here used to ship in ``upande_scp/fixtures/custom_field.json``. A
fixture only restores what some site last exported, so a field that was never
exported — or was deleted anywhere — is simply absent on a fresh install. That
is not a hypothetical: ``Work Order.workflow_state`` and
``Farm.spray_plan_approvers`` were both read by live code and both missing on
``kaitetv16-staging``, which is what produced::

    MySQLdb.OperationalError: (1054, "Unknown column 'workflow_state' in 'WHERE'")

on the spray-plan draft and the approvals page.

This module is the same pattern ``store.stock_entry_fields`` already applies to
Stock Entry, generalised to the rest. Declaring fields in code means a
reset-to-defaults, a fresh install and a new site all converge on the same
shape, and a field can never go missing because nobody re-exported it.

Three sibling modules own the fields this one deliberately leaves alone:

* ``store.stock_entry_fields`` — Stock Entry / Stock Entry Detail.
* ``common.farm_fields`` — the ``custom_farm`` links on BOM and Spray Team,
  created only where absent because a site may already carry its own.
* ``common.scouting_tab_layout`` — the ``Scouting and Crop Protection`` tab
  break itself, plus the final placement of everything declared here.

``update=True`` matches what the fixture did (``sync_fixtures`` is documented as
"Import, **overwrite** fixtures"), so switching to this module changes nothing
about how an existing site converges — it only adds the fresh-install case.
``farm_fields`` is the deliberate exception and explains its own reasoning.
"""

import frappe

MODULE = "Upande Scp"

#: The layout tab break. Declared locally, as every other module in this package
#: does — layout is ``scouting_tab_layout``'s to own, and importing it here
#: would invert the after_migrate order these two run in.
TAB = "custom_scouting_and_crop_protection_tab"


def _field_spec() -> dict:
	"""SCP's custom fields on shared doctypes, keyed by doctype.

	``insert_after`` values are a starting anchor only. ``scouting_tab_layout``
	runs after this on after_migrate and owns the final chain; the values below
	match what that enforcer converges on so the two never fight.
	"""
	return {
		"Work Order": [
			# The spray-plan lifecycle state. There is no Frappe Workflow behind
			# it any more — `delete_application_floor_plan_workflow` removed the
			# Workflow and the app sets and reads this value itself (see
			# spray_plan_creator.lifecycle). The field survived on kaitet only
			# because the deleted Workflow had created it years earlier, which
			# is precisely why it has to be declared here: a fresh site never
			# had a Workflow, so it never had the column, and every read blew up
			# with `1054 Unknown column 'workflow_state'`.
			#
			# The shape below is Frappe's own, byte for byte
			# (Workflow.create_custom_field_for_workflow_state). Two of those
			# properties are load-bearing rather than cosmetic:
			#   * `allow_on_submit` — AFP Work Orders are submitted, and the
			#     whole lifecycle happens afterwards. Without it every state
			#     transition is refused on save.
			#   * `Link` to `Workflow State` — the seven fixture records are the
			#     value vocabulary, and the link keeps a typo out of the column.
			# Matching Frappe also means a site that later re-adds a Workflow
			# finds the field already correct instead of conflicting.
			{
				"fieldname": "workflow_state",
				"label": "Workflow State",
				"fieldtype": "Link",
				"options": "Workflow State",
				"insert_after": "status",
				"hidden": 1,
				"allow_on_submit": 1,
				"no_copy": 1,
			},
			{
				"fieldname": "custom_type",
				"label": "Type",
				"fieldtype": "Data",
				"insert_after": TAB,
				"read_only": 1,
			},
			{
				"fieldname": "custom_classification",
				"label": "Spray Classification",
				"fieldtype": "Select",
				"insert_after": "custom_type",
				"options": "\nCurative\nPreventive",
				"in_list_view": 1,
				"in_standard_filter": 1,
				"description": (
					"Curative = targets from scouting observations. Preventive = "
					"routine/preventive spray that requires a reason. Optional — "
					"leave blank to skip server-side classification checks."
				),
			},
			{
				"fieldname": "custom_preventive_reason",
				"label": "Preventive Reason",
				"fieldtype": "Long Text",
				"insert_after": "custom_classification",
				"depends_on": "eval:doc.custom_classification=='Preventive'",
				"mandatory_depends_on": "eval:doc.custom_classification=='Preventive'",
				"description": "Required when Classification is Preventive. Minimum 20 characters.",
			},
			{
				"fieldname": "custom_application_floor_plan",
				"label": "Application Floor Plan",
				"fieldtype": "Section Break",
				"insert_after": "custom_preventive_reason",
			},
			{
				"fieldname": "custom_greenhouse",
				"label": "Greenhouse",
				"fieldtype": "Link",
				"options": "Warehouse",
				"insert_after": "custom_application_floor_plan",
				"hidden": 1,
			},
			{
				"fieldname": "custom_reentry_period_hrs",
				"label": "Re-entry Period (hrs)",
				"fieldtype": "Float",
				"insert_after": "custom_greenhouse",
				"hidden": 1,
				"read_only": 1,
			},
			{
				"fieldname": "custom_cost_center",
				"label": "Cost Center",
				"fieldtype": "Link",
				"options": "Cost Center",
				"insert_after": "custom_reentry_period_hrs",
				"fetch_from": "custom_greenhouse.custom_cost_center",
				"fetch_if_empty": 1,
				"in_list_view": 1,
				"search_index": 1,
				"description": (
					"Auto-fetched from the linked greenhouse warehouse's Cost Center. "
					"Falls back to a name-based match if the warehouse field is unset. "
					"auto_material_issue will raise a clear error if empty at issue time."
				),
			},
			{
				"fieldname": "custom_rate_overridden",
				"label": "Rates Overridden",
				"fieldtype": "Check",
				"insert_after": "custom_cost_center",
				"default": "0",
				"read_only": 1,
				"description": (
					"Set automatically when any required-item rate differs from the "
					"underlying BOM. Audit flag only."
				),
			},
			{
				"fieldname": "custom_weather_snapshot",
				"label": "Weather Snapshot (JSON)",
				"fieldtype": "Long Text",
				"insert_after": "custom_rate_overridden",
				"read_only": 1,
				"print_hide": 1,
				"print_hide_if_no_value": 1,
				"description": "JSON snapshot of the weather forecast at submit time. Read-only.",
			},
			{
				"fieldname": "custom_scheduled_application_time",
				"label": "Scheduled Application Time",
				"fieldtype": "Datetime",
				"insert_after": "custom_weather_snapshot",
				"hidden": 1,
			},
			{
				"fieldname": "custom_reentry_time",
				"label": "Re-entry Time",
				"fieldtype": "Datetime",
				"insert_after": "custom_scheduled_application_time",
				"hidden": 1,
				"read_only": 1,
			},
			{
				"fieldname": "custom_scope",
				"label": "Scope",
				"fieldtype": "Data",
				"insert_after": "custom_reentry_time",
			},
			{
				"fieldname": "custom_scope_details",
				"label": "Scope Details",
				"fieldtype": "Small Text",
				"insert_after": "custom_scope",
			},
			{
				"fieldname": "custom_area",
				"label": "Area (Ha)",
				"fieldtype": "Float",
				"insert_after": "custom_scope_details",
			},
			{
				"fieldname": "custom_water_volume",
				"label": "Water Volume",
				"fieldtype": "Float",
				"insert_after": "custom_area",
			},
			{
				"fieldname": "custom_water_ph",
				"label": "Water PH",
				"fieldtype": "Data",
				"insert_after": "custom_water_volume",
			},
			{
				"fieldname": "custom_water_hardness",
				"label": "Water Hardness",
				"fieldtype": "Data",
				"insert_after": "custom_water_ph",
			},
			{
				"fieldname": "custom_variety",
				"label": "Variety",
				"fieldtype": "Link",
				"options": "Item",
				"insert_after": "custom_water_hardness",
				"hidden": 1,
			},
			{
				"fieldname": "custom_spray_type",
				"label": "Spray Type",
				"fieldtype": "Data",
				"insert_after": "custom_variety",
				"hidden": 1,
			},
			{
				"fieldname": "custom_kit",
				"label": "Kit",
				"fieldtype": "Data",
				"insert_after": "custom_spray_type",
				"hidden": 1,
			},
			{
				"fieldname": "custom_targets",
				"label": "Target(s)",
				"fieldtype": "Code",
				"insert_after": "custom_kit",
				"hidden": 1,
			},
			{
				"fieldname": "custom_spray_team",
				"label": "Spray Team",
				"fieldtype": "Code",
				"insert_after": "custom_targets",
				"hidden": 1,
			},
			{
				"fieldname": "custom_spray_plan_team_members",
				"label": "Spray Plan Team Members",
				"fieldtype": "Table",
				"options": "Custom Spray Plan Team Member",
				"insert_after": "custom_spray_team",
				"collapsible": 1,
				"description": (
					"Per-plan snapshot of the spray team's roster. Edits here do NOT "
					"change the underlying Spray Team doctype."
				),
			},
			{
				"fieldname": "custom_chemical_scans",
				"label": "Chemical Scans",
				"fieldtype": "Table",
				"options": "Work Order Chemical Scan",
				"insert_after": "custom_spray_plan_team_members",
				"collapsible": 1,
				"read_only": 1,
				"description": (
					"Per-chemical CSU scan log written by the mobile app "
					"(register_csu_scan). System-populated."
				),
			},
			{
				"fieldname": "custom_spray_application_logsheet",
				"label": "Spray Application Logsheet",
				"fieldtype": "Link",
				"options": "Spray Application Logsheet",
				"insert_after": "custom_chemical_scans",
				"read_only": 1,
				"description": (
					"The Spray Application Logsheet created at tank-mix manufacture and "
					"submitted at end-spray. System-populated."
				),
			},
		],
		"Work Order Item": [
			{
				"fieldname": "custom_updated_required_qty",
				"label": "Updated Required Qty",
				"fieldtype": "Float",
				"insert_after": "amount",
				"hidden": 1,
			},
		],
		"BOM": [
			{
				"fieldname": "custom_item_group",
				"label": "Item Group",
				"fieldtype": "Link",
				"options": "Item Group",
				"insert_after": TAB,
				"read_only": 1,
			},
			{
				"fieldname": "custom_water_ph",
				"label": "Water PH",
				"fieldtype": "Data",
				"insert_after": "custom_item_group",
				"hidden": 1,
			},
			{
				"fieldname": "custom_water_hardness",
				"label": "Water Hardness",
				"fieldtype": "Data",
				"insert_after": "custom_water_ph",
				"hidden": 1,
			},
			{
				"fieldname": "custom_work_order",
				"label": "Application Floor Plan",
				"fieldtype": "Link",
				"options": "Work Order",
				"insert_after": "custom_water_hardness",
				"read_only": 1,
				"no_copy": 1,
				"in_standard_filter": 1,
				"search_index": 1,
				"description": (
					"The Application Floor Plan (Work Order) this per-plan tank-mix BOM "
					"was minted for. One BOM per plan; set automatically."
				),
			},
		],
		"BOM Item": [
			{
				"fieldname": "custom_application_rate",
				"label": "Application Rate(Per 1000L)",
				"fieldtype": "Data",
				"insert_after": "operation",
			},
			{
				"fieldname": "custom_application_rateper_ha_",
				"label": "Application Rate(stock uom/ha) ",
				"fieldtype": "Float",
				"insert_after": "operation",
				"hidden": 1,
			},
		],
		"Farm": [
			{
				"fieldname": "custom_chemical_store",
				"label": "Chemical Store",
				"fieldtype": "Link",
				"options": "Warehouse",
				"insert_after": TAB,
				"description": (
					"The warehouse chemicals are issued from for this farm. Authoritative — "
					"store resolution reads this link, never a warehouse-name prefix."
				),
			},
			{
				"fieldname": "custom_fertilizer_store",
				"label": "Fertilizer Store",
				"fieldtype": "Link",
				"options": "Warehouse",
				"insert_after": "custom_chemical_store",
				"description": (
					"The warehouse foliars are issued from for this farm. Authoritative — "
					"store resolution reads this link, never a warehouse-name prefix."
				),
			},
			{
				"fieldname": "spray_plan_creators",
				"label": "Spray Plan Creators",
				"fieldtype": "Table",
				"options": "Farm Spray Plan Creator",
				"insert_after": "custom_fertilizer_store",
				"description": (
					"Users allowed to create spray plans for this farm. Only users with "
					"the Spray Plan Creator role may be added."
				),
			},
			# Read by spray_plan_approval._approver_allowed_greenhouses and written
			# by the Settings -> Access page (spray_plan_creator.admin). It was
			# never in the fixture, so a fresh site had the child doctype but no
			# field to put rows in — the GM could not roster an approver at all.
			{
				"fieldname": "spray_plan_approvers",
				"label": "Spray Plan Approvers",
				"fieldtype": "Table",
				"options": "Farm Spray Plan Approver",
				"insert_after": "spray_plan_creators",
				"description": (
					"Users allowed to approve spray plans for this farm. Only users with "
					"the Spray Plan Approver role may be added."
				),
			},
			{
				"fieldname": "store_keepers",
				"label": "Store Keepers",
				"fieldtype": "Table",
				"options": "Farm Store Keeper",
				"insert_after": "spray_plan_approvers",
			},
		],
		"Warehouse": [
			{
				"fieldname": "custom_location",
				"label": "Location",
				"fieldtype": "Geolocation",
				"insert_after": TAB,
			},
			{
				"fieldname": "custom_raw_geojson",
				"label": "Raw Geojson",
				"fieldtype": "Small Text",
				"insert_after": "custom_location",
			},
			{
				"fieldname": "custom_cost_center",
				"label": "Cost Center",
				"fieldtype": "Link",
				"options": "Cost Center",
				"insert_after": "custom_raw_geojson",
				"search_index": 1,
				"description": (
					"Cost Center to use for stock postings (Material Issue / Stock Entry) "
					"that draw from this warehouse. Filtered by the warehouse's Company."
				),
			},
			{
				"fieldname": "custom_bed_numbering",
				"label": "Bed Numbering",
				"fieldtype": "Select",
				"options": "Top to Bottom\nBottom to Top",
				"insert_after": "custom_cost_center",
			},
			{
				"fieldname": "custom_zone_numbering",
				"label": "Zone Numbering",
				"fieldtype": "Select",
				"options": "Right to Left\nLeft to Right",
				"insert_after": "custom_bed_numbering",
			},
			{
				"fieldname": "custom_area_ha",
				"label": "Area (HA)",
				"fieldtype": "Float",
				"insert_after": "custom_zone_numbering",
				"default": "0",
				"non_negative": 1,
				"precision": "4",
				"description": (
					"Area of this greenhouse / block in hectares — used as the denominator "
					"for per-hectare pest & disease severity thresholds."
				),
			},
		],
		"Item": [
			# Per-variety intervention thresholds. The only chemical field left on
			# Item after the metadata moved to the product sidecar.
			{
				"fieldname": "custom_chemical_intervention_threshhold",
				"label": "Chemical Requirements",
				"fieldtype": "Table",
				"options": "Chemical Requirements",
				"insert_after": TAB,
				"hidden": 1,
			},
		],
		"Notification Log": [
			{
				"fieldname": "scp_category",
				"label": "SCP Category",
				"fieldtype": "Select",
				"options": "\nloan\ntransfer\nprocurement\nstock",
				"insert_after": "type",
				"in_standard_filter": 1,
				"description": (
					"SCP taxonomy for the notifications page. Notification Log.type is a "
					"fixed Frappe enum, so our categories live here."
				),
			},
		],
	}


def _dimension_fieldnames() -> set:
	"""Fieldnames owned by ERPNext accounting dimensions (e.g. 'farm').

	Never ours to create, update or delete — ERPNext maintains these across all
	57 doctypes in the ``accounting_dimension_doctypes`` hook, and dropping one
	would silently strip attribution from the stock ledger and GL.
	"""
	try:
		return set(frappe.get_all("Accounting Dimension", pluck="fieldname") or [])
	except Exception:
		return set()


def _sibling_owned() -> set:
	"""Fieldnames declared by the sibling declarative modules.

	``farm_fields`` owns ``custom_farm`` on BOM and Spray Team with different
	semantics (create-only, never overwrite). Pruning must not treat those as
	stale just because this module's spec doesn't list them.
	"""
	from upande_scp.serverscripts.common import farm_fields

	return {
		row["fieldname"]
		for rows in farm_fields._field_spec().values()
		for row in rows
	}


def _repair_invalid_list_view_flags(doctype: str) -> int:
	"""Clear ``in_list_view`` on any Table MultiSelect field of ``doctype``.

	Frappe forbids that combination outright — ``DocType.validate`` raises
	"'In List View' not allowed for type Table MultiSelect" — and it validates
	the *whole* doctype whenever a Custom Field is added to it. One invalid
	standard field therefore blocks every app from extending that doctype.

	``upande_core``'s ``Farm.farm_type`` (row 4) ships in exactly that state, so
	SCP could not create ``Farm.spray_plan_approvers`` at all: the approver
	roster had a child doctype and nowhere to put rows. The real fix belongs in
	core and is tracked in ``docs/upande_core_patches/``; this keeps a site that
	has not applied the patch converging anyway.

	Deliberately a direct DocField write rather than a DocType save — saving is
	the thing that is broken. This is repairing a state Frappe itself rejects,
	not imposing a preference, so it is safe to do to another app's doctype.
	"""
	rows = frappe.get_all(
		"DocField",
		filters={"parent": doctype, "fieldtype": "Table MultiSelect", "in_list_view": 1},
		fields=["name", "fieldname"],
		parent_doctype="DocType",
	)
	for row in rows:
		frappe.db.set_value("DocField", row.name, "in_list_view", 0, update_modified=False)
		frappe.logger().info(
			f"custom_fields: cleared invalid in_list_view on {doctype}.{row.fieldname} "
			"(Table MultiSelect) so custom fields can be added"
		)
	if rows:
		frappe.clear_cache(doctype=doctype)
	return len(rows)


def ensure_scp_custom_fields():
	"""after_migrate: create/update every field above, then prune stale ones.

	Idempotent, and a no-op for any doctype whose table does not exist yet (an
	app installed before ERPNext, or a partial bench).

	Each doctype is handled independently: one failing doctype logs and is
	skipped rather than aborting the rest, so a single bad shared doctype cannot
	take the whole app's field set down with it.
	"""
	from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

	spec = {
		dt: [dict(row, module=MODULE) for row in rows]
		for dt, rows in _field_spec().items()
		if frappe.db.table_exists(dt)
	}
	if not spec:
		return

	created = {}
	for doctype, rows in spec.items():
		try:
			_repair_invalid_list_view_flags(doctype)
			create_custom_fields({doctype: rows}, update=True)
			created[doctype] = rows
		except Exception:
			frappe.log_error(
				title=f"custom_fields: {doctype}",
				message=frappe.get_traceback(),
			)
	spec = created

	# Declarative reconciliation: an SCP-owned Custom Field on a managed doctype
	# that is not in the spec is stale and goes. Three exemptions, each of which
	# would be a real loss if pruned:
	#   * the layout tab break, owned by scouting_tab_layout;
	#   * accounting-dimension fields, owned by ERPNext;
	#   * fields owned by the sibling declarative modules.
	protected = {TAB} | _dimension_fieldnames() | _sibling_owned()
	for doctype, rows in spec.items():
		defined = {row["fieldname"] for row in rows} | protected
		for existing in frappe.get_all(
			"Custom Field",
			filters={"dt": doctype, "module": MODULE},
			fields=["name", "fieldname"],
		):
			if existing.fieldname not in defined:
				frappe.delete_doc(
					"Custom Field", existing.name, ignore_permissions=True, force=True
				)


def remove_scp_custom_fields():
	"""Delete every SCP-owned custom field on the managed doctypes (uninstall).

	The exemptions from ``ensure_scp_custom_fields`` apply here too — an
	accounting-dimension field or a sibling module's field is not ours to remove
	just because it sits on a doctype we also write to.
	"""
	protected = _dimension_fieldnames() | _sibling_owned()
	for doctype in _field_spec():
		for row in frappe.get_all(
			"Custom Field",
			filters={"dt": doctype, "module": MODULE},
			fields=["name", "fieldname"],
		):
			if row.fieldname in protected:
				continue
			frappe.delete_doc(
				"Custom Field", row.name, ignore_permissions=True, force=True
			)
