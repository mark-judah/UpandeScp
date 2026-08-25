"""Unit tests for the optional-biometric chemical-issue decision.

`_resolve_biometric_outcome` is the pure core of `submit_with_biometric`:
given the latest scan (or None), the SE's assigned employee, and the
`bypass_biometric_on_issue` setting, it decides how the row resolves.
"""
import unittest

from upande_scp.serverscripts.store import store_keeper_api as sk

SCAN_MATCH = {"name": "LOG-1", "employee": "EMP-1", "employee_name": "Jane"}
SCAN_OTHER = {"name": "LOG-2", "employee": "EMP-9", "employee_name": "Otto"}


class TestResolveBiometricOutcome(unittest.TestCase):
    def test_matching_scan_is_verified(self):
        # A fresh scan that matches the assignee is recorded Verified, with the
        # log name — independent of the bypass flag.
        for bypass in (False, True):
            self.assertEqual(
                sk._resolve_biometric_outcome(SCAN_MATCH, "EMP-1", bypass),
                ("verified", "LOG-1"),
            )

    def test_no_scan_with_bypass_is_bypassed(self):
        self.assertEqual(
            sk._resolve_biometric_outcome(None, "EMP-1", True),
            ("bypassed", None),
        )

    def test_mismatched_scan_with_bypass_is_bypassed(self):
        self.assertEqual(
            sk._resolve_biometric_outcome(SCAN_OTHER, "EMP-1", True),
            ("bypassed", None),
        )

    def test_no_scan_without_bypass_is_mismatch(self):
        self.assertEqual(
            sk._resolve_biometric_outcome(None, "EMP-1", False),
            ("mismatch", None),
        )

    def test_mismatched_scan_without_bypass_is_mismatch(self):
        self.assertEqual(
            sk._resolve_biometric_outcome(SCAN_OTHER, "EMP-1", False),
            ("mismatch", None),
        )
