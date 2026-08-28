"""The day's spray plans, for the handset's chemical and spray tabs.

This was an API-type Server Script called at the bare path `/api/method/
fetchScheduledApplications`. It was dropped on 2026-07-17 in `57e09ce` — "only ever
called by the legacy desk www pages", which was true of the *ERP* repo and false of
the field: `Spray/index.tsx`, `Spray/spray-details.tsx`, `chemical/index.tsx` and
`chemical/plan-details.tsx` all call it, so the audit that authorised the deletion
looked at one of the two repositories involved. Every handset lost its spray list.

Restored here as code rather than as a Server Script so that a future audit can find
the callers by grepping, and so the behaviour is versioned and testable. `hooks.py`
aliases the bare name onto this function via `override_whitelisted_methods`, which
`frappe.handler.execute_cmd` consults before anything else — so binaries already in
the field keep working without a rebuild.

Behaviour is deliberately identical to the deleted script, including the shape the app
parses (`frappe.response.data`, not the usual `message` envelope) and the swallowed
error. Fixing either would be a separate change to a separate contract.
"""

from __future__ import annotations

import frappe

#: Fields the app reads off a plan. Same list the Server Script carried.
_WO_FIELDS = (
	"name",
	"status",
	"custom_type",
	"custom_greenhouse",
	"custom_scope",
	"custom_scope_details",
	"custom_area",
	"custom_water_volume",
	"custom_water_ph",
	"custom_water_hardness",
	"custom_variety",
	"custom_spray_type",
	"custom_kit",
	"custom_targets",
	"custom_spray_team",
	"custom_reentry_time",
	"custom_scheduled_application_time",
	"wip_warehouse",
)

_ITEM_FIELDS = ("parent", "item_code", "item_name", "required_qty", "stock_uom")


@frappe.whitelist()
def fetchScheduledApplications(start_date=None):
	"""Submitted Application Floor Plans from `start_date` on, with their chemicals.

	`start_date` is optional; without it the whole submitted history comes back, which
	is what the deleted script did and what the app's "all plans" view relies on.
	"""
	# `form_dict` as well as the argument: the app posts a form body, and the alias
	# path means this can be reached without the argument being bound by name.
	start_date = start_date or frappe.form_dict.get("start_date")

	filters = {"docstatus": 1, "custom_type": "Application Floor Plan"}
	if start_date:
		filters["custom_scheduled_application_time"] = [">=", start_date]

	work_orders = frappe.get_all(
		"Work Order", filters=filters, fields=list(_WO_FIELDS)
	)

	if work_orders:
		# One query for every plan's chemicals rather than one per plan: a farm's day
		# is routinely 40+ plans, and this endpoint is on the critical path of opening
		# the tab.
		rows = frappe.get_all(
			"Work Order Item",
			filters={"parent": ("in", [wo["name"] for wo in work_orders])},
			fields=list(_ITEM_FIELDS),
			order_by="idx asc",
		)
		by_wo: dict[str, list[dict]] = {}
		for row in rows:
			by_wo.setdefault(row.pop("parent"), []).append(row)
		for wo in work_orders:
			wo["required_items"] = by_wo.get(wo["name"], [])

	# `frappe.response.data`, not the `message` envelope: the app reads `response.data`
	# and this is the contract it was built against.
	frappe.response["data"] = work_orders
	return work_orders
