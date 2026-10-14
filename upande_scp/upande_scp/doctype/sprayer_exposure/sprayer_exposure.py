# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

from frappe.model.document import Document


class SprayerExposure(Document):
	"""One person × one product × one spray application.

	Written (and rewritten) by `serverscripts.sprayers.exposure` from submitted
	Spray Application Logsheets; deleted when the logsheet is cancelled.
	"""
