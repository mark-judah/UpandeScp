# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

from frappe.model.document import Document


class CommentsScoutingEntry(Document):
    """A free-text note a scout attached to an entry.

    One row per comment the app sends. The mobile client has been posting
    `comments_scouting_entry` for some time; until this doctype existed the
    rows were silently discarded on the way in.
    """
    pass
