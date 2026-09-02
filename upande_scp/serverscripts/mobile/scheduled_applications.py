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

from upande_scp.serverscripts.common import crop_scope, farm_map

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
def fetchScheduledApplications(start_date=None, end_date=None, on_date=None):
	"""Submitted Application Floor Plans with their chemicals.

	Three ways to bound it, in order of preference:

	* ``on_date`` — **one day only**. This is what the handset asks for: a
	  supervisor opens the app in the morning, pulls that day's plans, and walks
	  into the field with no signal. Pulling the whole history to find one day's
	  work is a slow start on a phone and a lot of rows to hold offline.
	* ``start_date`` + ``end_date`` — an inclusive range.
	* ``start_date`` alone — from that date onwards. The original behaviour, kept
	  because the app's "all plans" view still uses it.

	With none of them, the whole submitted history comes back.
	"""
	# `form_dict` as well as the argument: the app posts a form body, and the alias
	# path means this can be reached without the argument being bound by name.
	start_date = start_date or frappe.form_dict.get("start_date")
	end_date = end_date or frappe.form_dict.get("end_date")
	on_date = on_date or frappe.form_dict.get("on_date")

	filters = {"docstatus": 1, "custom_type": "Application Floor Plan"}
	if on_date:
		# `custom_scheduled_application_time` is a Datetime, so testing it against
		# a bare date would match only midnight. Bound the whole day.
		filters["custom_scheduled_application_time"] = [
			"between", [f"{on_date} 00:00:00", f"{on_date} 23:59:59"]
		]
	elif start_date and end_date:
		filters["custom_scheduled_application_time"] = [
			"between", [f"{start_date} 00:00:00", f"{end_date} 23:59:59"]
		]
	elif start_date:
		filters["custom_scheduled_application_time"] = [">=", start_date]

	# Farm scope. This endpoint had none: every user downloaded every submitted
	# plan on the site. A spray plan creator rostered on one farm pulled 3,337
	# plans across six farms, and so did an approver — the two results were
	# byte-identical, which is what gave it away.
	#
	# Scope by the supervisor's own farms where they have been rostered, falling
	# back to their company otherwise.
	#
	# `Farm.spray_supervisors` now exists, so a supervisor rostered on Chepsito
	# gets Chepsito's plans and nobody else's. The fallback is deliberate rather
	# than lazy: 50 users hold the supervisor role and rostering is brand new, so
	# treating "not rostered" as "sees nothing" would empty the tab on every
	# handset the day this ships. An unrostered supervisor keeps the company-wide
	# view — no worse than before, and it self-corrects as rosters fill in.
	visible = crop_scope.visible_farms(roster_field="spray_supervisors")
	if visible is not None and not visible:
		visible = crop_scope.visible_farms()
	if visible is not None:
		if not visible:
			frappe.response["data"] = []
			return []
		greenhouses = farm_map.greenhouses_for_farms(visible)
		if not greenhouses:
			frappe.response["data"] = []
			return []
		filters["custom_greenhouse"] = ["in", greenhouses]

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

		# Attach each chemical's QR surrogate so the handset can verify a scanned
		# label **offline**. The traceable code carries `item_id`, not the item
		# code, so without this map the app would have to call the server to find
		# out which chemical a code refers to — which is precisely what it cannot
		# do standing in a greenhouse with no signal.
		codes = {r["item_code"] for rs in by_wo.values() for r in rs if r.get("item_code")}
		surrogates = {}
		if codes and frappe.db.table_exists("Spray Product"):
			surrogates = {
				r["item"]: r["qr_item_id"]
				for r in frappe.get_all(
					"Spray Product",
					filters={"item": ["in", list(codes)]},
					fields=["item", "qr_item_id"],
					limit_page_length=0,
				)
			}
		for rs in by_wo.values():
			for r in rs:
				r["qr_item_id"] = surrogates.get(r.get("item_code")) or 0

		for wo in work_orders:
			wo["required_items"] = by_wo.get(wo["name"], [])

	# `frappe.response.data`, not the `message` envelope: the app reads `response.data`
	# and this is the contract it was built against.
	frappe.response["data"] = work_orders
	return work_orders
