# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

from frappe.model.document import Document


class Sprayer(Document):
	"""One person who handles spray chemicals, keyed by their Employee.

	The name (SPR-#####) is the sprayer's own ID; `employee` is unique so a
	person is registered once. Populated by
	`serverscripts.sprayers.register.sync_sprayers`; the exposure totals are
	written by `recompute_totals` and are read-only here.
	"""
