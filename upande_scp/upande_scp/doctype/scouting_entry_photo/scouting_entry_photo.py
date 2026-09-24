# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

from frappe.model.document import Document


class ScoutingEntryPhoto(Document):
	"""One picture a scout took on a round, with the words about it.

	The picture itself is a File attached to the parent Scouting Entry — this
	row is what makes it visible on the entry, and what pairs it with a caption
	that would otherwise have had nowhere to go.
	"""

	pass
