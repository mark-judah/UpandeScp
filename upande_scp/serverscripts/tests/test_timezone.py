"""The app's view of what time it is.

The bug this exists because of: kaitet ran for its whole life on Frappe's out-of-the-box
`Asia/Kolkata` while every farm coordinate is Kenyan, so every timestamp the app wrote
was **2h30m ahead of local time** and the `0 14 * * *` daily report fired at 11:30
Nairobi. Nothing surfaced it, because a clock that is consistently wrong looks like a
working clock.

So the load-bearing behaviour is *detection*: the app must be able to say the site
timezone looks wrong, from the farms' own coordinates, without being told. And the lock
must default closed, because changing a timezone re-times every notification and
scheduled report with no error anywhere.

Run: bench --site <site> run-tests \
        --module upande_scp.serverscripts.tests.test_timezone
"""

import unittest
from contextlib import contextmanager

import frappe

from upande_scp.serverscripts.common import timezone as TZ


@contextmanager
def site_timezone(name):
    before = frappe.db.get_single_value("System Settings", "time_zone")
    frappe.db.set_single_value("System Settings", "time_zone", name)
    frappe.clear_cache(doctype="System Settings")
    frappe.db.commit()
    try:
        yield
    finally:
        frappe.db.set_single_value("System Settings", "time_zone", before)
        frappe.clear_cache(doctype="System Settings")
        frappe.db.commit()


@contextmanager
def scp_settings(**values):
    before = {
        k: frappe.db.get_single_value(TZ.SETTINGS, k) for k in values
    }
    for k, v in values.items():
        frappe.db.set_single_value(TZ.SETTINGS, k, v)
    frappe.clear_cache(doctype=TZ.SETTINGS)
    frappe.db.commit()
    try:
        yield
    finally:
        for k, v in before.items():
            frappe.db.set_single_value(TZ.SETTINGS, k, v)
        frappe.clear_cache(doctype=TZ.SETTINGS)
        frappe.db.commit()


class TestReading(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        frappe.set_user("Administrator")

    def test_it_reads_the_site_timezone_rather_than_assuming_one(self):
        with site_timezone("Africa/Nairobi"):
            self.assertEqual(TZ.erp_timezone(), "Africa/Nairobi")
        with site_timezone("Asia/Kolkata"):
            self.assertEqual(TZ.erp_timezone(), "Asia/Kolkata")

    def test_the_app_follows_erp_unless_overridden(self):
        with site_timezone("Africa/Nairobi"):
            with scp_settings(app_timezone=""):
                self.assertEqual(TZ.app_timezone(), "Africa/Nairobi")
            with scp_settings(app_timezone="Europe/Amsterdam"):
                self.assertEqual(TZ.app_timezone(), "Europe/Amsterdam")

    def test_an_unrecognised_override_is_ignored_rather_than_obeyed(self):
        """A stored typo must not become the app's clock."""
        with site_timezone("Africa/Nairobi"):
            with scp_settings(app_timezone="Mars/Olympus_Mons"):
                self.assertEqual(TZ.app_timezone(), "Africa/Nairobi")

    def test_offsets_are_computed_now_not_hardcoded(self):
        """An offset is not a property of a timezone — it moves with daylight saving, so
        a stored number would be wrong twice a year wherever that applies."""
        self.assertEqual(TZ.offset_minutes("Africa/Nairobi"), 180)
        self.assertEqual(TZ.offset_minutes("Asia/Kolkata"), 330)
        self.assertEqual(TZ.offset_minutes("UTC"), 0)
        self.assertIsNone(TZ.offset_minutes("Nowhere/Nothing"))

    def test_validity_is_checked_against_the_real_database(self):
        self.assertTrue(TZ.is_valid("Africa/Nairobi"))
        self.assertFalse(TZ.is_valid("Africa/Nairoby"))
        self.assertFalse(TZ.is_valid(""))
        self.assertFalse(TZ.is_valid(None))


class TestDetection(unittest.TestCase):
    """The part that would have caught the original bug."""

    @classmethod
    def setUpClass(cls):
        frappe.set_user("Administrator")
        if not frappe.db.count("Farm Map Coordinate"):
            raise unittest.SkipTest("no farm coordinates to infer a timezone from")

    def test_it_infers_the_timezone_from_the_farms_own_coordinates(self):
        self.assertEqual(TZ.expected_timezone(), "Africa/Nairobi")

    def test_it_reports_a_wrong_site_timezone_with_the_drift(self):
        """The exact situation kaitet was in, and the message that would have surfaced
        it: Kolkata configured, Kenyan farms, 2h30m apart."""
        with site_timezone("Asia/Kolkata"):
            report = TZ.timezone_report()
            self.assertTrue(report["warnings"], "a wrong timezone must warn")
            joined = " ".join(report["warnings"])
            self.assertIn("Asia/Kolkata", joined)
            self.assertIn("Africa/Nairobi", joined)
            self.assertIn("2h30m", joined)

    def test_it_stays_quiet_when_the_timezone_is_right(self):
        with site_timezone("Africa/Nairobi"):
            with scp_settings(app_timezone=""):
                self.assertEqual(TZ.timezone_report()["warnings"], [])

    def test_a_display_override_warns_that_scheduling_does_not_follow_it(self):
        """The honest limit: an app timezone changes what is shown, not when anything
        happens. Saying otherwise would be the more dangerous bug of the two."""
        with site_timezone("Africa/Nairobi"):
            with scp_settings(app_timezone="Europe/Amsterdam"):
                joined = " ".join(TZ.timezone_report()["warnings"])
                self.assertIn("Europe/Amsterdam", joined)
                self.assertIn("what is shown, not when", joined)

    def test_the_report_shows_all_three_clocks(self):
        report = TZ.timezone_report()
        for key in ("now_erp", "now_utc", "now_app"):
            self.assertTrue(report[key], f"{key} missing — a mismatch must be visible")

    def test_it_names_what_a_change_would_affect(self):
        affected = " ".join(TZ.timezone_report()["affected"]).lower()
        for thing in ("notification", "report", "cutoff", "auto-cancel"):
            self.assertIn(thing, affected)


class TestLock(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        frappe.set_user("Administrator")

    def test_the_lock_defaults_closed_when_nothing_is_stored(self):
        """An untouched field must not leave the most consequential setting open."""
        with scp_settings(timezone_locked=None):
            self.assertTrue(TZ.is_locked())

    def test_a_locked_timezone_refuses_to_change(self):
        with scp_settings(timezone_locked=1):
            with self.assertRaises(frappe.ValidationError) as cm:
                TZ.set_app_timezone("Europe/Amsterdam")
            self.assertIn("locked", str(cm.exception).lower())

    def test_unlocking_then_setting_works_and_is_reversible(self):
        before = frappe.db.get_single_value(TZ.SETTINGS, "app_timezone")
        try:
            TZ.set_lock(0)
            self.assertFalse(TZ.is_locked())
            out = TZ.set_app_timezone("Europe/Amsterdam")
            self.assertEqual(out["app_timezone"], "Europe/Amsterdam")
            self.assertFalse(out["follows_erp"])

            TZ.set_app_timezone("")
            self.assertTrue(TZ.timezone_report()["follows_erp"])
        finally:
            frappe.db.set_single_value(TZ.SETTINGS, "app_timezone", before or "")
            TZ.set_lock(1)
            frappe.db.commit()

    def test_an_unknown_timezone_is_refused_rather_than_stored(self):
        """Storing it would look like it took effect while silently falling back."""
        try:
            TZ.set_lock(0)
            with self.assertRaises(frappe.ValidationError):
                TZ.set_app_timezone("Not/AZone")
        finally:
            TZ.set_lock(1)
            frappe.db.commit()

    def test_only_an_elevated_user_may_touch_it(self):
        user = None
        for candidate in frappe.get_all(
            "Has Role",
            filters={"role": "SCP Spray Plan Creator", "parenttype": "User"},
            pluck="parent", limit_page_length=60,
        ):
            if candidate != "Administrator" and not (
                set(frappe.get_roles(candidate)) & TZ.ELEVATED
            ):
                user = candidate
                break
        if not user:
            self.skipTest("every planner on this site is also elevated")
        frappe.set_user(user)
        try:
            with self.assertRaises(frappe.PermissionError):
                TZ.set_lock(0)
            with self.assertRaises(frappe.PermissionError):
                TZ.set_app_timezone("UTC")
        finally:
            frappe.set_user("Administrator")


class TestSiteIsCorrect(unittest.TestCase):
    """A guard on the live setting, not on the code.

    Fails loudly if the site drifts back to a timezone its own farms contradict — which
    is how this went unnoticed for the site's whole life.
    """

    def test_the_site_timezone_matches_where_the_farms_are(self):
        expected = TZ.expected_timezone()
        if not expected:
            self.skipTest("no coordinates to infer from")
        self.assertEqual(
            TZ.erp_timezone(), expected,
            "System Settings → Time Zone contradicts the farms' own coordinates; "
            "every timestamp and scheduled job is out of step",
        )

    def test_the_scheduler_and_the_farms_agree(self):
        """`ScheduledJobType.is_event_due` evaluates cron against `now_datetime()`, so
        the site timezone IS the scheduler's clock. There is no second one to set."""
        from frappe.utils import now_datetime
        from datetime import datetime
        from zoneinfo import ZoneInfo

        expected = TZ.expected_timezone()
        if not expected:
            self.skipTest("no coordinates to infer from")
        local = datetime.now(ZoneInfo(expected)).replace(tzinfo=None)
        drift = abs((now_datetime() - local).total_seconds())
        self.assertLess(
            drift, 120,
            f"the scheduler's clock is {drift / 60:.0f} min from farm-local time",
        )


class TestSchedulerAlignment(unittest.TestCase):
    """What the operator actually asked about: does a timezone change re-time the
    reports, and will anything double-send?

    Cron is evaluated against `frappe.utils.now_datetime()` — the site timezone — so
    correcting the clock moves every slot in real terms. The risk on a *backwards*
    correction is a stale `last_execution` stamped in the future: the job waits for its
    next slot after that stamp. Benign, and repairing it would be worse — rewinding the
    stamps can make a daily report whose slot falls inside the shifted window fire twice.
    """

    @classmethod
    def setUpClass(cls):
        frappe.set_user("Administrator")

    def test_it_reports_every_scp_job_with_its_next_run(self):
        report = TZ.scheduler_alignment()
        self.assertEqual(report["timezone"], TZ.erp_timezone())
        self.assertTrue(report["jobs"], "no SCP scheduled jobs found")
        for job in report["jobs"]:
            self.assertIn("next_execution", job)

    def test_no_report_email_is_due_to_fire_a_second_time(self):
        """The one outcome that would actually annoy people: a duplicate report landing
        because the clock moved backwards under a job that had already run today."""
        emails = [
            j
            for j in TZ.scheduler_alignment()["jobs"]
            if "report" in j["job"] or "email" in j["job"]
        ]
        if not emails:
            self.skipTest("no report jobs registered on this site")
        for job in emails:
            self.assertFalse(
                job["due_now"],
                f"{job['job']} is due immediately — it would send a duplicate",
            )

    def test_a_stale_stamp_is_reported_rather_than_silently_repaired(self):
        report = TZ.scheduler_alignment()
        self.assertIn("stale_last_execution", report)
        self.assertIsInstance(report["stale_last_execution"], int)
        # Whatever the count, the note has to explain the choice not to fix it.
        self.assertIn("send twice", report["note"])

    def test_the_cron_slots_land_at_the_intended_local_hour(self):
        """A `0 14 * * *` job should next run at 14:00 local, not 14:00 in some other
        country's clock — which is exactly what it was doing before."""
        for job in TZ.scheduler_alignment()["jobs"]:
            cron = str(job.get("cron") or "")
            nxt = job.get("next_execution")
            if not nxt or len(cron.split()) != 5:
                continue
            minute, hour = cron.split()[0], cron.split()[1]
            if not (minute.isdigit() and hour.isdigit()):
                continue
            self.assertEqual(
                nxt[11:16], f"{int(hour):02d}:{int(minute):02d}",
                f"{job['job']} next runs at {nxt[11:16]}, not the {hour}:{minute} its "
                "cron asks for",
            )


class TestClientMomentsAreSiteLocal(unittest.TestCase):
    """`to_site_naive` — the seam between a handset's clock and this database.

    This exists because of a bug that reached the field. The RN app stamps every
    offline moment with `Date.toISOString()`, which is UTC and ends in `Z`. Frappe's
    `get_datetime` honours that offset and returns an *aware* datetime; everything
    stored here is naive and in the ERP timezone. The mixture failed twice over —
    `TypeError: can't compare offset-naive and offset-aware datetimes` when the
    sync compared the moment against the transfer anchor, and MariaDB 1292
    `Incorrect datetime value: '2026-09-02 21:18:00+00:00'` when a scan's raw
    string went into the column — so a supervisor pressing "send this to the site"
    got a refusal and their day's work stayed on the phone.
    """

    def test_utc_is_converted_not_stripped(self):
        """The instant is real: `Z` must be *converted*, never merely discarded.

        Stripping the offset is the tempting one-line fix and it is wrong. On a
        site three hours ahead of UTC it dates a tank mix three hours before it was
        mixed, and `resolve_moments` then clamps that forward to the anchor — so
        the mistake is absorbed and never shows up as a visibly wrong time.
        """
        with site_timezone("Africa/Nairobi"):
            got = TZ.to_site_naive("2026-09-03T00:15:00.000Z")
        self.assertEqual(str(got), "2026-09-03 03:15:00")
        self.assertIsNone(got.tzinfo, "must be naive to reach a datetime column")

    def test_explicit_offset_is_honoured(self):
        with site_timezone("Africa/Nairobi"):
            got = TZ.to_site_naive("2026-09-02T21:15:00+00:00")
        self.assertEqual(str(got), "2026-09-03 00:15:00")

    def test_naive_input_is_left_alone(self):
        """Server-side callers already speak site-local; do not shift them."""
        with site_timezone("Africa/Nairobi"):
            got = TZ.to_site_naive("2026-09-03 00:15:00")
        self.assertEqual(str(got), "2026-09-03 00:15:00")

    def test_result_compares_against_now(self):
        """The actual crash: comparison against a naive server moment."""
        with site_timezone("Africa/Nairobi"):
            got = TZ.to_site_naive("2026-09-03T00:15:00.000Z")
        try:
            got < frappe.utils.now_datetime()
        except TypeError as e:  # pragma: no cover - the regression itself
            self.fail(f"still not comparable: {e}")

    def test_missing_and_unparseable_return_none(self):
        for value in (None, "", "not a date", []):
            self.assertIsNone(TZ.to_site_naive(value), repr(value))
