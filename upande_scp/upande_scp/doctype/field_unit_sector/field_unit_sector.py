# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

from frappe.model.document import Document


class FieldUnitSector(Document):
	"""A contiguous run of unit numbers planted with one variety.

	Replaces `Greenhouse Sectors` (from_bed/to_bed) and `Block Sectors`
	(from_row/to_row), which differed only in what the range was called. The
	unit kind now lives on the parent's `unit_type`, so one child table serves
	beds, rows and bands alike.
	"""

	pass
