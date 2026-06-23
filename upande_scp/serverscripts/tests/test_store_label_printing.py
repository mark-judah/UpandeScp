import unittest


class TestToPrintJob(unittest.TestCase):
    def _label(self, **over):
        base = {
            "se_name": "MAT-STE-0001",
            "image_src": "data:image/png;base64,AAAA",
            "chem_name": "Score 250 EC",
            "item_code": "CHEM-001",
            "qty_str": "10 L",
            "source": "Main Store - K",
            "target": "Mix Station - K",
            "scheduled": "14 Jun 2026 06:00",
            "spray_type": "Fungicide",
            "greenhouse": "GH 12",
            "qr_payload": "Score 250 EC\n10 L",
        }
        base.update(over)
        return base

    def test_drops_image_src(self):
        from upande_scp.serverscripts.store_label_printing import _to_print_job
        job = _to_print_job(self._label())
        self.assertNotIn("image_src", job)

    def test_keeps_qr_payload_and_fields(self):
        from upande_scp.serverscripts.store_label_printing import _to_print_job
        job = _to_print_job(self._label())
        self.assertEqual(job["qr_payload"], "Score 250 EC\n10 L")
        self.assertEqual(job["se_name"], "MAT-STE-0001")
        self.assertEqual(job["greenhouse"], "GH 12")
        self.assertEqual(job["qty_str"], "10 L")

    def test_missing_keys_default_to_empty_string(self):
        from upande_scp.serverscripts.store_label_printing import _to_print_job
        job = _to_print_job({"se_name": "X", "qr_payload": "a\nb"})
        self.assertEqual(job["chem_name"], "")
        self.assertEqual(job["spray_type"], "")


class TestRecentDates(unittest.TestCase):
    def test_dedupes_and_sorts_desc(self):
        from upande_scp.serverscripts.store_label_printing import _distinct_dates
        rows = [{"posting_date": "2026-06-10"}, {"posting_date": "2026-06-12"},
                {"posting_date": "2026-06-10"}]
        self.assertEqual(_distinct_dates(rows), ["2026-06-12", "2026-06-10"])

    def test_stringifies_date_objects(self):
        import datetime
        from upande_scp.serverscripts.store_label_printing import _distinct_dates
        rows = [{"posting_date": datetime.date(2026, 6, 9)}]
        self.assertEqual(_distinct_dates(rows), ["2026-06-09"])

    def test_empty(self):
        from upande_scp.serverscripts.store_label_printing import _distinct_dates
        self.assertEqual(_distinct_dates([]), [])


if __name__ == "__main__":
    unittest.main()
