import unittest
from unittest.mock import patch

import frappe

from upande_scp.serverscripts.spray_plan_creator import lifecycle as L

P = "upande_scp.serverscripts.spray_plan_creator.lifecycle"


class TestLifecycleScope(unittest.TestCase):
    def _run(self, roles, visible, whs=("W1",)):
        rows = [frappe._dict(name=n) for n in whs]
        with patch(f"{P}.frappe.get_roles", return_value=roles), \
             patch(f"{P}.frappe.session", frappe._dict(user="u@x.com")), \
             patch(f"{P}.frappe.get_all", return_value=rows), \
             patch("upande_scp.serverscripts.common.crop_scope.visible_farms", side_effect=visible):
            return L._scoped_greenhouses()

    def test_keeper_unscoped(self):
        self.assertIsNone(self._run(["SCP Chemical Store Keeper"], lambda *a, **k: {"F"}))

    def test_creator_scoped_to_roster(self):
        seen = []
        def vf(roster, crop, user):
            seen.append(roster)
            return {"F"}
        self.assertEqual(self._run(["SCP Spray Plan Creator"], vf), {"W1"})
        self.assertEqual(seen, ["spray_plan_creators"])

    def test_creator_with_no_roster_sees_nothing(self):
        self.assertEqual(self._run(["SCP Spray Plan Creator"], lambda *a, **k: set()), set())

    def test_gm_company_scope(self):
        self.assertEqual(self._run(["SCP General Manager"], lambda r, c, u: {"F"}), {"W1"})
