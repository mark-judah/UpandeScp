import datetime
import unittest
from types import SimpleNamespace
from unittest.mock import patch


class TestResolveScoutingDate(unittest.TestCase):
    def test_parent_row_uses_date_of_capture(self):
        from upande_scp.serverscripts.common import cache_utils as cu
        doc = SimpleNamespace(doctype="Scouting Entry", date_of_capture="2025-05-01")
        self.assertEqual(cu._resolve_scouting_date(doc), datetime.date(2025, 5, 1))

    def test_accepts_date_object(self):
        from upande_scp.serverscripts.common import cache_utils as cu
        doc = SimpleNamespace(
            doctype="Scouting Entry", date_of_capture=datetime.date(2025, 5, 1)
        )
        self.assertEqual(cu._resolve_scouting_date(doc), datetime.date(2025, 5, 1))

    def test_child_row_walks_to_parent(self):
        from unittest.mock import Mock
        from upande_scp.serverscripts.common import cache_utils as cu
        doc = SimpleNamespace(doctype="Pests Scouting Entry", parent="SE-0001")
        # frappe.db is an unbound LocalProxy in a no-site test context, so swap
        # the module attribute directly (reading the original via patch.object
        # would trigger the proxy and raise).
        db = Mock()
        db.get_value.return_value = "2025-05-04"
        orig = cu.frappe.__dict__.get("db")
        cu.frappe.db = db
        try:
            self.assertEqual(cu._resolve_scouting_date(doc), datetime.date(2025, 5, 4))
        finally:
            cu.frappe.db = orig
        db.get_value.assert_called_once_with(
            "Scouting Entry", "SE-0001", "date_of_capture"
        )

    def test_unresolvable_returns_none(self):
        from upande_scp.serverscripts.common import cache_utils as cu
        doc = SimpleNamespace(doctype="Scouting Entry", date_of_capture=None)
        self.assertIsNone(cu._resolve_scouting_date(doc))


class TestInvalidateScoutingWeek(unittest.TestCase):
    def test_deletes_only_the_affected_week_key(self):
        from upande_scp.serverscripts.common import cache_utils as cu
        # 2025-05-01 is ISO week 18 of 2025.
        doc = SimpleNamespace(doctype="Scouting Entry", date_of_capture="2025-05-01")
        with patch.object(cu, "scouting_payload_version", return_value=7), \
             patch.object(cu, "invalidate") as inv, \
             patch.object(cu, "invalidate_scouting_payload") as bump:
            cu.invalidate_scouting_week_for_doc(doc)
            inv.assert_called_once_with("scp:scouting_payload_v2:7:2025-W18")
            bump.assert_not_called()

    def test_falls_back_to_global_bump_when_week_unknown(self):
        from upande_scp.serverscripts.common import cache_utils as cu
        doc = SimpleNamespace(doctype="Scouting Entry", date_of_capture=None)
        with patch.object(cu, "invalidate") as inv, \
             patch.object(cu, "invalidate_scouting_payload") as bump:
            cu.invalidate_scouting_week_for_doc(doc)
            bump.assert_called_once_with()
            inv.assert_not_called()


class TestInvalidateDispatch(unittest.TestCase):
    """invalidate_on_change should scope scouting writes to one week but keep
    the global bump for master-data changes."""

    def test_scouting_entry_busts_only_its_week(self):
        from upande_scp.serverscripts.common import cache_utils as cu
        doc = SimpleNamespace(doctype="Scouting Entry", date_of_capture="2025-05-01")
        with patch.object(cu, "invalidate_scouting_week_for_doc") as week, \
             patch.object(cu, "invalidate_scouting_payload") as bump, \
             patch.object(cu, "invalidate"):
            cu.invalidate_on_change(doc)
            week.assert_called_once_with(doc)
            bump.assert_not_called()

    def test_master_data_keeps_global_bump(self):
        from upande_scp.serverscripts.common import cache_utils as cu
        doc = SimpleNamespace(doctype="Zone", name="Z-1")
        with patch.object(cu, "invalidate_scouting_week_for_doc") as week, \
             patch.object(cu, "invalidate_scouting_payload") as bump, \
             patch.object(cu, "invalidate"):
            cu.invalidate_on_change(doc)
            bump.assert_called_once_with()
            week.assert_not_called()


if __name__ == "__main__":
    unittest.main()
