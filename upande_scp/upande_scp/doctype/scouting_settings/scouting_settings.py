# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

from frappe.model.document import Document


class ScoutingSettings(Document):
	"""What a scout is allowed to record beyond the counts.

	Read through `serverscripts.scouting.capture_settings.allows`, never
	directly: the app and the two write paths must agree on what "off" means,
	and a missing Single has to read as ON rather than as a silent refusal.
	"""

	pass
