# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

from frappe.model.document import Document


class CommentsScoutingEntry(Document):
	"""A free-text note a scout wrote on an entry (piece 5, ported from Mona 8be897b).

	The handset has posted `comments_scouting_entry` for months; until this
	doctype existed on kaitet the rows were silently dropped on the way in.
	"""

	pass
