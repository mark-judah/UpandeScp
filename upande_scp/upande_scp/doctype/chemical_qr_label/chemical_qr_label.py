# Copyright (c) 2026, Upande Limited and contributors
# For license information, please see license.txt

from frappe.model.document import Document


class ChemicalQRLabel(Document):
	"""A code that was actually issued.

	Existence is the security property: a fabricated code has no row, which is what
	makes the 8 random digits unforgeable without a key to distribute.
	"""

	pass
