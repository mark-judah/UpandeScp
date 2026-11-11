import unittest

import frappe

from upande_scp.serverscripts.store import issue_list_pdf as m

NOT_A_KEEPER = "christine.cheruiyot@karenroses.com"


class TestPure(unittest.TestCase):
    def test_supervisor_is_read_from_the_team_snapshot(self):
        self.assertEqual(m._supervisor("A B - Supervisor\nC - Sprayer"), "A B")
        self.assertEqual(m._supervisor("C - Sprayer"), "")
        self.assertEqual(m._supervisor(None), "")

    def test_qr_prefers_the_traceable_code_else_plain_text(self):
        self.assertEqual(m.qr_payload("ABC123", "I1", 2, "L"), "ABC123")
        self.assertEqual(m.qr_payload(None, "I1", 2.5, "L"), "I1\n2.5 L")

    def test_bad_date_is_refused(self):
        with self.assertRaises(frappe.ValidationError):
            m.collect("11/08/2026")

    def _data(self):
        t = [{"item_code": "I1", "item_name": "Amisil", "uom": "Kg", "qty": 1.5}]
        line = {"item_code": "I1", "item_name": "Amisil", "qty": 1.5, "uom": "Kg",
                "source": "Store - K", "batch": "", "qr": "I1\n1.5 Kg", "coded": False}
        plan = {"wo": "WO-1", "se": "SE-1", "state": "Approved", "spray_type": "Full",
                "scheduled": "06:00", "supervisor": "Joe", "issued": False, "lines": [line]}
        done = dict(plan, wo="WO-2", issued=True)
        return {"date": "2026-08-11", "to_issue": 1, "issued": 1, "totals": t,
                "farms": [{"farm": "Kap", "houses": [
                    {"greenhouse": "GH 1", "plans": [plan, done], "totals": t}]}]}

    def test_html_has_sections_totals_and_signatures(self):
        h = m.render_html(self._data(), "Co", "me", "now")
        self.assertIn("To issue", h)
        self.assertIn("Already issued", h)
        self.assertIn("Day totals", h)
        self.assertIn("Received by", h)
        self.assertEqual(h.count("data:image/png"), 1)  # QR only on the to-issue plan

    def test_empty_day_says_so(self):
        h = m.render_html({"date": "d", "farms": [], "totals": [], "to_issue": 0, "issued": 0})
        self.assertIn("No transfers", h)


class TestAgainstSite(unittest.TestCase):
    def setUp(self):
        frappe.set_user("Administrator")

    def tearDown(self):
        frappe.set_user("Administrator")

    def test_drafts_and_issued_split_by_spray_day(self):
        d = m.collect("2026-08-11")
        self.assertEqual(d["issued"], 0)
        self.assertGreaterEqual(d["to_issue"], 1)
        d2 = m.collect("2026-10-15")
        self.assertEqual(d2["to_issue"], 0)
        self.assertGreaterEqual(d2["issued"], 1)

    def test_farm_and_greenhouse_filters(self):
        d = m.collect("2026-08-11")
        farm = d["farms"][0]["farm"]
        house = d["farms"][0]["houses"][0]["greenhouse"]
        self.assertEqual(m.collect("2026-08-11", farms=["Nowhere"])["farms"], [])
        self.assertEqual(m.collect("2026-08-11", farms=farm)["to_issue"], d["to_issue"])
        one = m.collect("2026-08-11", greenhouses=house)
        self.assertEqual([h["greenhouse"] for f in one["farms"] for h in f["houses"]], [house])

    def test_day_total_is_sum_of_house_totals(self):
        d = m.collect("2026-08-11")
        house = sum(t["qty"] for f in d["farms"] for h in f["houses"] for t in h["totals"])
        self.assertAlmostEqual(house, sum(t["qty"] for t in d["totals"]))

    def test_pdf_bytes_and_filename(self):
        r = m.download_issue_list_pdf("2026-08-11")
        import base64
        self.assertTrue(base64.b64decode(r["data"]).startswith(b"%PDF"))
        self.assertRegex(r["filename"], r"^issue-list-.*-2026-08-11\.pdf$")

    def test_needs_the_store_role(self):
        frappe.set_user(NOT_A_KEEPER)
        with self.assertRaises(frappe.PermissionError):
            m.download_issue_list_pdf("2026-08-11")
