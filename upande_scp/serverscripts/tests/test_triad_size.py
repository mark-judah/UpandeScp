"""Standard triangle side: measuring a ring and refusing off-standard layouts.

Run: bench --site mutara.local run-tests --app upande_scp \
        --module upande_scp.serverscripts.tests.test_triad_size
"""

import math
import unittest

import frappe

from upande_scp.serverscripts.geo import triad_size

LAT = -0.4
LNG = 36.9
M_PER_DEG = 111320.0


def triangle_ring(side, lat=LAT, lng=LNG):
    """Closed ring [centre, V(30), V(90), centre] with the given side, in lng/lat."""
    def pt(deg):
        dx = side * math.cos(math.radians(deg))
        dy = side * math.sin(math.radians(deg))
        return [lng + dx / (M_PER_DEG * math.cos(math.radians(lat))), lat + dy / M_PER_DEG]

    c = [lng, lat]
    return [c, pt(30), pt(90), c]


class TestTriadSize(unittest.TestCase):
    def test_full_5m_triangle_measures_5(self):
        self.assertAlmostEqual(triad_size.triangle_side_m(triangle_ring(5)), 5.0, delta=0.01)

    def test_clipped_piece_returns_none(self):
        ring = triangle_ring(5)
        clipped = [ring[0], ring[1], [ring[2][0], ring[2][1] - 2 / M_PER_DEG], ring[0]]
        self.assertIsNone(triad_size.triangle_side_m(clipped))
        quad = ring[:3] + [[ring[1][0], ring[2][1]], ring[0]]
        self.assertIsNone(triad_size.triangle_side_m(quad))

    def test_3m_triangle_refused_on_5m_standard(self):
        msg = triad_size.check_side(triangle_ring(3), 5.0)
        self.assertIn("3.00 m", msg)
        self.assertIn("5 m", msg)

    def test_within_tolerance_and_clipped_pass(self):
        self.assertIsNone(triad_size.check_side(triangle_ring(5.05), 5.0))
        self.assertIsNone(triad_size.check_side(triangle_ring(5), 5.0))
        ring = triangle_ring(3)
        self.assertIsNone(triad_size.check_side(ring[:3], 5.0))

    def test_blank_setting_defaults_to_5(self):
        old = frappe.db.get_single_value("Scouting and Crop Protection Settings", "triad_side_m")
        self.addCleanup(
            frappe.db.set_single_value,
            "Scouting and Crop Protection Settings", "triad_side_m", old,
        )
        for blank in (0, None):
            frappe.db.set_single_value(
                "Scouting and Crop Protection Settings", "triad_side_m", blank
            )
            frappe.clear_document_cache("Scouting and Crop Protection Settings")
            self.assertEqual(triad_size.standard_side_m(), 5.0)
        frappe.db.set_single_value("Scouting and Crop Protection Settings", "triad_side_m", 4)
        self.assertEqual(triad_size.standard_side_m(), 4.0)
