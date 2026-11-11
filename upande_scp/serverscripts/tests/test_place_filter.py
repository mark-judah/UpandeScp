"""parse_names and the multi-place filters (pure; no site data needed)."""
import unittest

from upande_scp.serverscripts.common.place_filter import matches, parse_names
from upande_scp.serverscripts.dashboard_aggregates._common import resolve_greenhouse_scope

FARMS = {"A": ["A GH 1", "A GH 2"], "B": ["B GH 1"]}


class TestPlaceFilter(unittest.TestCase):
    def test_parse_names_forms(self):
        self.assertEqual(parse_names(None), [])
        self.assertEqual(parse_names(""), [])
        self.assertEqual(parse_names("__all__"), [])
        self.assertEqual(parse_names("A"), ["A"])
        self.assertEqual(parse_names("A, B"), ["A", "B"])
        self.assertEqual(parse_names('["A","B","A"]'), ["A", "B"])
        self.assertEqual(parse_names(["A", "", None]), ["A"])
        self.assertEqual(parse_names("[broken"), ["[broken"])

    def test_matches(self):
        self.assertTrue(matches("A", []))
        self.assertTrue(matches("A", ["A", "B"]))
        self.assertFalse(matches("C", ["A"]))

    def test_resolve_scope_single_keeps_working(self):
        self.assertEqual(resolve_greenhouse_scope("A GH 1", "", FARMS), ["A GH 1"])
        self.assertEqual(resolve_greenhouse_scope("", "A", FARMS), ["A GH 1", "A GH 2"])
        self.assertIsNone(resolve_greenhouse_scope("", "", FARMS))
        self.assertEqual(resolve_greenhouse_scope("", "Nope", FARMS), [])

    def test_resolve_scope_multi(self):
        self.assertEqual(resolve_greenhouse_scope("", '["A","B"]', FARMS), ["A GH 1", "A GH 2", "B GH 1"])
        self.assertEqual(resolve_greenhouse_scope('["A GH 2","B GH 1"]', "", FARMS), ["A GH 2", "B GH 1"])
