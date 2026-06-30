# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document


class Chemical(Document):
    def validate(self):
        # Only Items in the "Chemicals" group may be registered as a Chemical —
        # this master is the spray-flow's chemical list, not a general item list.
        if self.item:
            group = frappe.db.get_value("Item", self.item, "item_group")
            if group != "Chemicals":
                frappe.throw(
                    _("{0} is not in the 'Chemicals' item group.").format(self.item)
                )
