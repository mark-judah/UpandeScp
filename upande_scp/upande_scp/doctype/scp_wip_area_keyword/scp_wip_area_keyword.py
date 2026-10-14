"""One word that marks a warehouse as a work-in-progress spray area.

Roses call theirs the CSU. The flow is the same on every crop — chemicals are
transferred into a holding area, mixed there, and sprayed out of it — but the
place has a different name on an orchard than it does on a rose farm, and the
code used to look for the literal string "CSU".
"""

from frappe.model.document import Document


class SCPWIPAreaKeyword(Document):
	pass
