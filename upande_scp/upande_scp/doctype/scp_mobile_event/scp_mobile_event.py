# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class SCPMobileEvent(Document):
	pass


def on_doctype_update():
	# One event id is accepted once per install (the phone retries a batch whose
	# reply it lost); the unique key also settles a race between two batches.
	frappe.db.add_unique("SCP Mobile Event", ["install_id", "event_id"], constraint_name="unique_install_event")
	# Dashboard reads: a kind within a window, and one problem over time.
	frappe.db.add_index("SCP Mobile Event", ["kind", "ts"], index_name="kind_ts_idx")
	frappe.db.add_index("SCP Mobile Event", ["fingerprint", "ts"], index_name="fingerprint_ts_idx")
