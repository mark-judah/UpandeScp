# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

from frappe.model.document import Document


class ScoutingEntryPhoto(Document):
	"""One picture a scout took on a round, with the words about it (piece 5,
	ported from Mona f5f6392).

	The picture itself is a private File attached to the parent Scouting Entry;
	this row is what makes it visible on the entry and pairs it with a caption.
	"""

	pass
