"""The field units under one station, for the handset.

Like `scheduled_applications.py`, this was an API-type Server Script at the bare path
`/api/method/fetchGreenhouseBeds`, dropped on 2026-07-17 in `57e09ce` on the grounds
that no in-repo caller remained. The caller was in the *other* repo: `configure.tsx`,
`(tabs)/index.tsx`, `profile/index.tsx` and `profile/cached-data.tsx` all reach it,
the last two to show and rebuild the offline cache.

`get_farm_data_bundle` genuinely does supersede it for the configure flow — one call
per farm instead of two per leaf — but superseding is not the same as removing, and
the per-station calls are still how the app refreshes a single station.

One field is added to the deleted script's payload: `unit_type`, so the phone can call
a unit a bed, a row or a band (`fieldUnits.ts`). It is additive — a client that does
not know the field ignores it, and one that does defaults to "Bed" when it is absent.
"""

from __future__ import annotations

import frappe

#: `unit_type` distinguishes a rose bed from an avocado row from a coffee band; they
#: all live in `tabBed`. Kept in step with `get_farm_data_bundle._BED_FIELDS`.
_FIELDS = ("name", "bed", "unit_type")


@frappe.whitelist()
def fetchGreenhouseBeds(greenhouse_name=None):
	"""Every field unit belonging to one station.

	Returns `[]` for an unknown station rather than throwing: the app calls this while
	walking a cached hierarchy, and a station renamed in the office should cost the
	scout one empty list, not a crash on the configure screen.
	"""
	greenhouse_name = greenhouse_name or frappe.form_dict.get("greenhouse_name")
	if not greenhouse_name:
		# The deleted script answered with a message and no data. Preserved, because
		# the app distinguishes "no beds" from "you asked wrong" only by this.
		frappe.response["message"] = (
			"Greenhouse name parameter 'greenhouse_name' is missing."
		)
		return []

	beds = frappe.get_all(
		"Bed",
		filters={"greenhouse": greenhouse_name},
		fields=list(_FIELDS),
		order_by="bed asc",
		limit_page_length=0,
	)
	for bed in beds:
		bed["unit_type"] = bed.get("unit_type") or "Bed"

	# `frappe.response.data`, matching the contract the app reads.
	frappe.response["data"] = beds
	return beds
