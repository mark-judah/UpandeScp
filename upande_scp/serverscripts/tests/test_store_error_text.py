"""A failed transfer row must say why — a PermissionError has no text of its own."""
import unittest

import frappe

from upande_scp.serverscripts.store import store_keeper_api as S


class TestErrorText(unittest.TestCase):
    def test_uses_own_text(self):
        self.assertEqual(S._error_text(frappe.ValidationError("no stock")), "no stock")

    def test_falls_back_to_message_log(self):
        old = frappe.local.message_log
        try:
            frappe.local.message_log = [{"message": "User <b>x</b> does not have access"}]
            self.assertEqual(S._error_text(frappe.PermissionError()), "User x does not have access")
        finally:
            frappe.local.message_log = old

    def test_never_blank(self):
        old = frappe.local.message_log
        try:
            frappe.local.message_log = []
            self.assertEqual(S._error_text(frappe.PermissionError()), "PermissionError")
        finally:
            frappe.local.message_log = old
