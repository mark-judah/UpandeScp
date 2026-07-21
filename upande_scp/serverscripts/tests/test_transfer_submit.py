import unittest

from upande_scp.serverscripts.store_keeper_api import (
    _transfer_submit_error,
    _SE_PURPOSE,
)


class TestTransferSubmitError(unittest.TestCase):
    def _row(self, **over):
        row = {
            "name": "SE-0001",
            "docstatus": 0,
            "purpose": _SE_PURPOSE,
            "bio_employee": "HR-EMP-001",
        }
        row.update(over)
        return row

    def test_eligible_row_returns_none(self):
        self.assertIsNone(_transfer_submit_error(self._row()))

    def test_already_submitted_or_cancelled(self):
        msg = _transfer_submit_error(self._row(docstatus=1))
        self.assertIn("already submitted or cancelled", msg)
        self.assertIn("SE-0001", msg)

    def test_wrong_purpose(self):
        msg = _transfer_submit_error(self._row(purpose="Material Issue"))
        self.assertIn("purpose is not", msg)

    def test_missing_bio_employee(self):
        for val in ("", None):
            msg = _transfer_submit_error(self._row(bio_employee=val))
            self.assertIn("no receiving employee assigned", msg)
