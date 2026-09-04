import unittest

import frappe


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
        from upande_scp.serverscripts.store.store_label_printing import _to_print_job
        job = _to_print_job(self._label())
        self.assertNotIn("image_src", job)

    def test_keeps_qr_payload_and_fields(self):
        from upande_scp.serverscripts.store.store_label_printing import _to_print_job
        job = _to_print_job(self._label())
        self.assertEqual(job["qr_payload"], "Score 250 EC\n10 L")
        self.assertEqual(job["se_name"], "MAT-STE-0001")
        self.assertEqual(job["greenhouse"], "GH 12")
        self.assertEqual(job["qty_str"], "10 L")

    def test_missing_keys_default_to_empty_string(self):
        from upande_scp.serverscripts.store.store_label_printing import _to_print_job
        job = _to_print_job({"se_name": "X", "qr_payload": "a\nb"})
        self.assertEqual(job["chem_name"], "")
        self.assertEqual(job["spray_type"], "")


class TestRecentDates(unittest.TestCase):
    def test_dedupes_and_sorts_desc(self):
        from upande_scp.serverscripts.store.store_label_printing import _distinct_dates
        rows = [{"posting_date": "2026-06-10"}, {"posting_date": "2026-06-12"},
                {"posting_date": "2026-06-10"}]
        self.assertEqual(_distinct_dates(rows), ["2026-06-12", "2026-06-10"])

    def test_stringifies_date_objects(self):
        import datetime
        from upande_scp.serverscripts.store.store_label_printing import _distinct_dates
        rows = [{"posting_date": datetime.date(2026, 6, 9)}]
        self.assertEqual(_distinct_dates(rows), ["2026-06-09"])

    def test_empty(self):
        from upande_scp.serverscripts.store.store_label_printing import _distinct_dates
        self.assertEqual(_distinct_dates([]), [])


if __name__ == "__main__":
    unittest.main()


class TestPrintingDoesNotNeedTheImage(unittest.TestCase):
    """The ZQ520 draws the QR from `qr_payload`. It is never sent a PNG.

    Both gates below were derived from a PNG existing on disk, so a label whose
    traceable code was perfectly intact could not be printed — and `has_qr`
    checks `os.path.isfile`, which does fail in practice (`regenerate_qrs`
    exists because of it).
    """

    def test_the_printer_asks_for_labels_without_requiring_an_image(self):
        import inspect

        from upande_scp.serverscripts.store import store_label_printing as slp

        src = inspect.getsource(slp.get_print_jobs)
        self.assertIn("require_image=False", src)

    def test_the_pdf_still_requires_one(self):
        """It embeds the PNG, so a line without one cannot be drawn."""
        import inspect

        from upande_scp.serverscripts.spray_plan_ops import spray_plan_labels as spl

        self.assertIs(
            inspect.signature(spl._collect_labels).parameters["require_image"].default,
            True,
        )
        self.assertNotIn(
            "require_image", inspect.getsource(spl.generate_pdf),
            "the PDF must keep the default — it has nothing to draw without an image",
        )

    def test_the_calendar_no_longer_hides_a_day_over_a_missing_file(self):
        import inspect

        from upande_scp.serverscripts.store import store_label_printing as slp

        src = inspect.getsource(slp.get_label_dates)
        self.assertNotIn('r.get("has_qr")', src)

    def test_a_job_never_carries_an_image_anyway(self):
        """Whatever `_collect_labels` resolved, `_JOB_FIELDS` drops it — so an
        empty `image_src` cannot reach the app and cannot be missed there."""
        from upande_scp.serverscripts.store.store_label_printing import (
            _JOB_FIELDS,
            _to_print_job,
        )

        self.assertNotIn("image_src", _JOB_FIELDS)
        job = _to_print_job({
            "se_name": "MAT-STE-2026-01245",
            "image_src": "",
            "qr_payload": "226000000400060004200522928496969",
        })
        self.assertNotIn("image_src", job)
        self.assertEqual(job["qr_payload"], "226000000400060004200522928496969")


class TestPrintingWithTheImageGone(unittest.TestCase):
    """The gap, reproduced against a real transfer rather than asserted.

    An attachment is made to look like a non-image (a single field, restored in
    `finally`) so `_collect_labels` sees an SE with codes and no usable picture
    — which is what the store hits when a QR file goes missing from disk.
    """

    def _a_labelled_transfer(self):
        rows = frappe.db.sql(
            """
            SELECT se.name
            FROM `tabStock Entry` se
            JOIN `tabWork Order` wo ON wo.name = se.work_order
            JOIN `tabChemical QR Label` l ON l.stock_entry = se.name
            WHERE se.purpose = 'Material Transfer for Manufacture'
              AND se.docstatus = 1 AND wo.custom_type = 'Application Floor Plan'
            ORDER BY se.modified DESC LIMIT 1
            """,
            pluck="name",
        )
        return rows[0] if rows else None

    def test_the_printer_gets_its_label_and_the_pdf_does_not(self):
        from upande_scp.serverscripts.spray_plan_ops.spray_plan_labels import (
            _collect_labels,
        )

        se = self._a_labelled_transfer()
        if not se:
            self.skipTest("no labelled AFP transfer on this site")

        files = frappe.get_all(
            "File",
            filters={"attached_to_doctype": "Stock Entry", "attached_to_name": se},
            fields=["name", "file_name"],
        )
        images = [f for f in files if str(f.file_name or "").lower().endswith(
            (".png", ".jpg", ".jpeg", ".gif", ".webp"))]
        if not images:
            self.skipTest(f"{se} has no image attachment to hide")

        before, _ = _collect_labels([se], require_image=True)
        self.assertTrue(before, "the fixture should be printable to begin with")

        try:
            for f in images:
                frappe.db.set_value(
                    "File", f.name, "file_name", f"{f.file_name}.hidden",
                    update_modified=False,
                )

            pdf_labels, pdf_skipped = _collect_labels([se], require_image=True)
            zpl_labels, _ = _collect_labels([se], require_image=False)

            self.assertEqual(pdf_labels, [], "the PDF has no picture to embed")
            self.assertEqual(pdf_skipped[0]["reason"], "no image attachments")
            self.assertTrue(
                zpl_labels,
                "the printer builds the QR from the payload and needs no picture",
            )
            self.assertTrue(
                all(l["qr_payload"] for l in zpl_labels),
                "a label with no payload would print a blank QR",
            )
            self.assertTrue(
                all(l["image_src"] == "" for l in zpl_labels),
                "image_src should come back empty, not stale",
            )
        finally:
            for f in images:
                frappe.db.set_value(
                    "File", f.name, "file_name", f.file_name, update_modified=False
                )
            frappe.db.commit()

        after, _ = _collect_labels([se], require_image=True)
        self.assertEqual(len(after), len(before), "the fixture must be left as found")
