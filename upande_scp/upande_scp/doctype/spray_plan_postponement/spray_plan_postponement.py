# Copyright (c) 2026, Upande Limited and contributors
# For license information, please see license.txt

from frappe.model.document import Document


class SprayPlanPostponement(Document):
	"""One declared slip of a spray plan.

	The row survives its own decision: a rejected postponement is as much part of
	why a plan happened when it did as an approved one.
	"""

	pass
