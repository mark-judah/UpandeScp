"""Predator side-effect classes for the ingredients used on roses (see seed_impacts). Fills blanks only."""

import frappe


def execute():
	from upande_scp.serverscripts.biologicals import seed_impacts

	frappe.reload_doc("upande_scp", "doctype", "active_ingredient_predator_impact")
	frappe.reload_doc("upande_scp", "doctype", "active_ingredient_moa")
	seed_impacts.run()
