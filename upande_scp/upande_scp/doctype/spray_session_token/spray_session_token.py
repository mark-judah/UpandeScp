# Copyright (c) 2026, Upande Limited and contributors
# For license information, please see license.txt

from frappe.model.document import Document


class SpraySessionToken(Document):
	"""One offline spray session, and what it produced.

	The record survives a refusal: a token that could not be applied is as much part
	of what happened in the field as one that was.
	"""

	pass
