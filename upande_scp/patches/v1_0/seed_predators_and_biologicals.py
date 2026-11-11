"""Predator master clean-up, stages, prey and the Biologicals stock items (see seed_predators)."""

import frappe


def execute():
	from upande_scp.serverscripts.biologicals import seed_predators

	frappe.reload_doc("upande_scp", "doctype", "predator_stages")
	frappe.reload_doc("upande_scp", "doctype", "predator_targets")
	frappe.reload_doc("upande_scp", "doctype", "predator")
	seed_predators.run()
