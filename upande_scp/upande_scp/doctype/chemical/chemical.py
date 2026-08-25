# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document

from upande_scp.serverscripts.common import crop_protection


class Chemical(Document):
    def validate(self):
        # Only Items in a configured chemical group may be registered as a
        # Chemical — this master is the spray-flow's chemical list, not a
        # general item list.
        #
        # The group set comes from Spray Plan Settings, not a literal. The
        # previous `group != "Chemicals"` test was the same class of bug that
        # hid every foliar from the picker: a site whose group is spelled
        # differently, or which configures a second chemical group, silently
        # could not register its chemicals.
        if not self.item:
            return
        group = frappe.db.get_value("Item", self.item, "item_group")
        if crop_protection.classify_item_group(group) != "chemical":
            frappe.throw(
                _("{0} is not in a configured chemical item group.").format(self.item)
            )
