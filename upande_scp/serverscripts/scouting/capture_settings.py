# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

"""What a scout is allowed to record on the ground, and who decides.

Three places need the same answer and must not each decide for themselves: the
payload that tells the handset which icons to draw, the photo upload, and the
entry write that carries the comment rows. They ask here.

WHY IT LIVES ON SPRAY PLAN SETTINGS. Not because a photo is a spray plan, but
because that Single is already where this app keeps every farm-wide switch —
weather bands, loaning, the progress email — and it is the one the SCP settings
page loads and saves. A settings doctype per feature is how a settings page
becomes six settings pages.

WHY IT DEFAULTS TO ON. A site that has migrated but never opened the page has
no row at all, and `get_single_value` answers None for every field on it.
Reading that as "off" would switch the feature off for every farm the moment it
shipped, which is the opposite of what a default is for. Absent means allowed;
only an explicit 0 turns something off.
"""

import frappe

SETTINGS = "Spray Plan Settings"

#: The switches this module answers for, and the field behind each.
_FIELDS = {
	"photos": "allow_scout_photos",
	"comments": "allow_scout_comments",
}


def allows(what: str) -> bool:
	"""Is this kind of capture allowed on this site?

	`what` is "photos" or "comments". Anything else is a programming error and
	says so rather than quietly answering True, because a typo that reads as
	"allowed" would hand scouts a capability the GM had switched off.
	"""
	try:
		fieldname = _FIELDS[what]
	except KeyError:
		raise ValueError(
			f"{what!r} is not a scouting capture switch — expected one of "
			f"{', '.join(sorted(_FIELDS))}"
		) from None

	if not frappe.db.exists("DocType", SETTINGS):
		# The app shipped before the doctype reached this site.
		return True

	# READ THE ROW, NOT `get_single_value`. That helper casts by fieldtype
	# before it returns, and a Check casts a missing row to 0 — so "nobody has
	# ever opened this page" and "the GM switched it off" arrive identical, and
	# the default-on rule above quietly inverts. Restoring mona production,
	# which has no rows for these fields, is what showed it: the handset was
	# told photos and comments were both off on a site where nothing had ever
	# been switched off.
	# Plain SQL: `get_value` orders by `creation`, and tabSingles has no such
	# column — it is a key/value table, not a doctype table.
	row = frappe.db.sql(
		"SELECT value FROM tabSingles WHERE doctype = %s AND field = %s",
		(SETTINGS, fieldname),
	)
	value = row[0][0] if row else None
	return True if value in (None, "") else bool(int(value))


def as_payload() -> dict:
	"""Both switches, shaped for the handset.

	It rides with the observations rather than sitting behind a call of its
	own: the app decides whether to draw the camera and the Comments tab while
	it is building the round, and a second request is one more thing to fail
	on a handset halfway down a greenhouse.
	"""
	return {key: allows(key) for key in _FIELDS}
