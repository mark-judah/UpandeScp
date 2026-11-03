# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class SprayProduct(Document):
	"""A product that goes into a tank mix — a chemical or a foliar.

	One record per Item (``autoname: field:item``), so the record's name IS the
	item code. Child-table queries must therefore filter by ``parenttype`` as
	well as ``parent``, or an Item row and a Spray Product row with the same name
	are counted twice.

	Was two doctypes, ``Chemical`` and ``Foliar``, with identical field sets and
	a per-crop override doctype each. The split bought nothing: every reader had
	to try both, and the two override doctypes held no rows on any site. The
	``category`` field carries the distinction that actually matters — which
	store the product is issued from — and ``crop_rates`` replaces both override
	doctypes with a child table.
	"""

	def validate(self):
		if self.item and not self.product_name:
			self.product_name = frappe.db.get_value("Item", self.item, "item_name")
		self._validate_crop_rates()

	def _validate_crop_rates(self):
		"""One row per crop and determinant, and a lower bound that is actually below the upper.

		A duplicate crop row makes the effective rate depend on row order, and an
		inverted pair rejects every dose — both fail silently at spray-planning
		time, which is the wrong place to find out.
		"""
		# `self.get(...)`, not `self.crop_rates`: during a pre_model_sync patch the
		# doctype in the database predates this field, so the attribute does not
		# exist yet and a direct access raises AttributeError mid-migration.
		seen = set()
		for row in self.get("crop_rates") or []:
			basis = row.get("basis") or "Water"
			label = row.crop or "All crops"
			key = (row.crop or "", basis)
			if key in seen:
				frappe.throw(
					f"{label} / {basis} appears more than once in Per-Crop Rates. "
					"One row per crop and determinant."
				)
			seen.add(key)
			if (
				row.lower_rate_limit
				and row.upper_rate_limit
				and row.lower_rate_limit > row.upper_rate_limit
			):
				frappe.throw(
					f"{label} ({basis}): lower rate limit ({row.lower_rate_limit}) is above "
					f"the upper limit ({row.upper_rate_limit})."
				)
