"""Triad entries count as units in trends and in the per-warehouse unit counts.

Fixtures are raw-inserted and rolled back; no real Mutara data is touched.

Run: bench --site mutara.local run-tests --module upande_scp.serverscripts.tests.test_trends_triad_units
"""

import unittest
from types import SimpleNamespace

import frappe

from importlib import import_module
from upande_scp.serverscripts.scouting import scouting_metrics as SM

# `dashboard_aggregates/__init__` re-exports a function named `_trends`, shadowing the submodule.
T = import_module("upande_scp.serverscripts.dashboard_aggregates._trends")

FARM = "_TEST TriadUnits Farm"
HEXA_BLOCK = "_TEST TriadUnits Hexa Block"
TREE_BLOCK = "_TEST TriadUnits Tree Block"


def row(**kw):
	base = {"block": "", "greenhouse": "", "bed": "", "zone": "", "tree": "", "triad": ""}
	base.update(kw)
	return SimpleNamespace(**base)


class TestTriadUnitKey(unittest.TestCase):
	def test_triad_entry_counts_as_unit(self):
		self.assertEqual(T._unit_key(row(block="B1", triad="B1 - Hexa 1 - Triad 2")), "B1::triad::B1 - Hexa 1 - Triad 2")

	def test_tree_and_zone_keys_unchanged(self):
		self.assertEqual(T._unit_key(row(block="B1", tree="T7")), "B1::tree::T7")
		self.assertEqual(T._unit_key(row(zone="Z1")), "zone::Z1")
		self.assertEqual(T._unit_key(row(block="B1")), "")


class TestTriadBlockCounts(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		frappe.db.sql("INSERT INTO `tabFarm` (name) VALUES (%s)", (FARM,))
		for wh in (HEXA_BLOCK, TREE_BLOCK):
			frappe.db.sql(
				"INSERT INTO `tabWarehouse` (name, warehouse_name, warehouse_type, custom_farm, disabled, is_group)"
				" VALUES (%s, %s, 'Block', %s, 0, 0)", (wh, wh, FARM),
			)
		hexa = f"{HEXA_BLOCK} - Hexa 1"
		frappe.db.sql("INSERT INTO `tabBed` (name, greenhouse, bed, unit_type) VALUES (%s, %s, 1, 'Hexa')", (hexa, HEXA_BLOCK))
		for t in range(1, 7):
			frappe.db.sql(
				"INSERT INTO `tabTriad` (name, block, `row`, triad, farm) VALUES (%s, %s, %s, %s, %s)",
				(f"{hexa} - Triad {t}", HEXA_BLOCK, hexa, t, FARM),
			)
		for n in (1, 2, 3):
			frappe.db.sql(
				"INSERT INTO `tabOrchard Tree` (name, block, farm) VALUES (%s, %s, %s)", (f"{TREE_BLOCK} - Tree {n}", TREE_BLOCK, FARM)
			)

	def tearDown(self):
		frappe.db.rollback()

	def test_hexa_block_total_is_triad_count(self):
		u = SM.get_units_by_warehouse()[HEXA_BLOCK]
		self.assertEqual((u["type"], u["count"]), ("triad", 6))

	def test_tree_block_total_unchanged(self):
		u = SM.get_units_by_warehouse()[TREE_BLOCK]
		self.assertEqual((u["type"], u["count"]), ("block", 3))
