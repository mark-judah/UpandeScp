"""Talking to another site: the parts that decide whether a push is safe to start.

Two things here are load-bearing and neither is about HTTP.

**Telling 403 from 404.** They look identical to a naive check, and conflating
them was a real bug in this tool: the first self-test reported `Warehouse`, `UOM`
and `Employee` as "missing from the target" when the target was this very site.
They were readable — the API key's user simply lacked the roles. "Install the
app" and "grant the user a role" are completely different fixes, and the second
is the one you actually hit, because a fresh key usually lands on a user with
fewer roles than the person who made it.

**Never leaking the secret.** `describe()` is printed by every run, so it must not
carry the token, and the credential loader must not put it anywhere a later reader
could find it.

Run: bench --site <site> run-tests \
        --module upande_scp.serverscripts.tests.test_migrate_target
"""

import os
import tempfile
import unittest
from unittest.mock import patch

from upande_scp.serverscripts.migrate import plan
from upande_scp.serverscripts.migrate.target import Target, TargetError


class FakeResponse:
    def __init__(self, status, payload=None, text=""):
        self.status_code = status
        self.ok = 200 <= status < 300
        self._payload = payload
        self.text = text or str(payload or "")

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload


def make_target(**env):
    base = {
        "SCP_TARGET_URL": "https://example.test",
        "SCP_API_KEY": "keykeykey",
        "SCP_API_SECRET": "secretsecret",
    }
    base.update(env)
    with patch.dict(os.environ, base, clear=False):
        with patch.dict(os.environ, {"SCP_MIGRATE_ENV": "/nonexistent"}):
            return Target()


class TestCredentials(unittest.TestCase):
    def test_it_refuses_to_start_without_all_three(self):
        with patch.dict(os.environ, {"SCP_MIGRATE_ENV": "/nonexistent"}, clear=True):
            with self.assertRaises(TargetError) as caught:
                Target()
            for name in ("SCP_TARGET_URL", "SCP_API_KEY", "SCP_API_SECRET"):
                self.assertIn(name, str(caught.exception))

    def test_the_error_does_not_echo_whatever_was_supplied(self):
        with patch.dict(os.environ, {"SCP_MIGRATE_ENV": "/nonexistent"}, clear=True):
            with patch.dict(os.environ, {"SCP_API_KEY": "leaky-key-value"}):
                with self.assertRaises(TargetError) as caught:
                    Target()
                self.assertNotIn("leaky-key-value", str(caught.exception))

    def test_describe_never_carries_the_secret(self):
        """Printed on every run, so this is the line most likely to leak."""
        t = make_target()
        described = t.describe()
        self.assertNotIn("secretsecret", described)
        self.assertNotIn("keykeykey", described)
        self.assertIn("example.test", described)

    def test_describe_shows_only_a_key_prefix(self):
        """Enough to tell two keys apart in a log, not enough to use."""
        t = make_target()
        self.assertIn("keyk", t.describe())
        self.assertNotIn("keykeykey", t.describe())

    def test_it_reads_a_key_file(self):
        with tempfile.NamedTemporaryFile("w", suffix=".env", delete=False) as fh:
            fh.write("SCP_TARGET_URL=https://from-file.test\n")
            fh.write("SCP_API_KEY=filekey\n")
            fh.write("SCP_API_SECRET=filesecret\n")
            path = fh.name
        os.chmod(path, 0o600)
        try:
            with patch.dict(os.environ, {}, clear=True):
                t = Target(env_file=path)
            self.assertEqual(t.url, "https://from-file.test")
            self.assertIn("from-file.test", t.describe())
        finally:
            os.unlink(path)

    def test_the_url_loses_a_trailing_slash(self):
        """Otherwise every path becomes a double slash, which some proxies 404."""
        t = make_target(SCP_TARGET_URL="https://example.test/")
        self.assertEqual(t.url, "https://example.test")

    def test_the_host_override_is_used_for_the_label(self):
        """A bench reached by IP still reports which site it is."""
        t = make_target(SCP_TARGET_URL="http://127.0.0.1:8000", SCP_TARGET_HOST="kaitet.local")
        self.assertIn("kaitet.local", t.describe())
        self.assertEqual(t.session.headers["Host"], "kaitet.local")

    def test_no_host_header_when_not_asked_for(self):
        t = make_target()
        self.assertNotIn("Host", t.session.headers)


class TestProbeStates(unittest.TestCase):
    """The bug this class exists for: 403 and 404 are not the same problem."""

    def probe(self, doctype_response, registry_hit=True):
        t = make_target()
        calls = []

        def fake(method, path, **kw):
            calls.append(kw.get("params", {}))
            if (kw.get("params") or {}).get("doctype") == "DocType":
                return FakeResponse(200, {"message": 1 if registry_hit else 0})
            return doctype_response

        with patch.object(t, "_request", side_effect=fake):
            return t.probe("Warehouse")

    def test_a_readable_doctype_reports_its_count(self):
        state, count = self.probe(FakeResponse(200, {"message": 812}))
        self.assertEqual((state, count), ("ok", 812))

    def test_an_empty_doctype_is_ok_not_missing(self):
        """Zero rows is a fine, expected state — a fresh site has many."""
        state, count = self.probe(FakeResponse(200, {"message": 0}))
        self.assertEqual((state, count), ("ok", 0))

    def test_403_on_an_installed_doctype_is_a_permission_problem(self):
        """The real case: the key's user lacks Stock Manager, not a missing app."""
        state, _ = self.probe(FakeResponse(403, {"exception": "PermissionError"}), registry_hit=True)
        self.assertEqual(state, "forbidden")

    def test_403_on_a_doctype_that_is_not_registered_is_missing(self):
        """Some versions answer 403 for both, so the registry settles it."""
        state, _ = self.probe(FakeResponse(403, {"exception": "PermissionError"}), registry_hit=False)
        self.assertEqual(state, "missing")

    def test_404_is_missing(self):
        state, _ = self.probe(FakeResponse(404, {"exc_type": "DoesNotExistError"}))
        self.assertEqual(state, "missing")

    def test_a_server_error_is_neither_missing_nor_forbidden(self):
        """Reporting a 500 as 'not installed' would send someone to reinstall an
        app that is already there."""
        state, _ = self.probe(FakeResponse(500, {"exception": "boom"}))
        self.assertEqual(state, "error")

    def test_count_returns_none_for_anything_unreadable(self):
        t = make_target()
        for state in ("forbidden", "missing", "error"):
            with patch.object(t, "probe", return_value=(state, None)):
                self.assertIsNone(t.count("Warehouse"))

    def test_doctype_exists_is_true_when_merely_forbidden(self):
        """It is there; we just cannot read it. Saying otherwise sends the
        operator to fix the wrong thing."""
        t = make_target()
        with patch.object(t, "probe", return_value=("forbidden", None)):
            self.assertTrue(t.doctype_exists("Warehouse"))
        with patch.object(t, "probe", return_value=("missing", None)):
            self.assertFalse(t.doctype_exists("Warehouse"))


class TestPlanOrdering(unittest.TestCase):
    """Loading order is the whole point of the plan: a step may only reference
    doctypes from earlier steps, or links resolve to documents that are not there
    yet."""

    def test_no_doctype_is_listed_twice(self):
        names = plan.all_doctypes()
        self.assertEqual(len(names), len(set(names)))

    def test_every_step_has_a_label_and_content(self):
        for app, steps in plan.STEPS.items():
            for label, doctypes in steps:
                self.assertTrue(label, app)
                self.assertTrue(doctypes, label)

    def test_each_step_only_depends_on_earlier_ones(self):
        """Checked against the live schema, not a hand-written list — so the plan
        cannot silently drift from what the doctypes actually link to."""
        import frappe

        for app, steps in plan.STEPS.items():
            mine = set(plan.doctypes_for(app))
            loaded = set()
            for label, doctypes in steps:
                for dt in doctypes:
                    if not frappe.db.exists("DocType", dt):
                        continue
                    for f in frappe.get_meta(dt).fields:
                        if f.fieldtype != "Link" or f.options not in mine:
                            continue
                        if f.options == dt or f.options in doctypes:
                            continue  # same step or self-reference
                        self.assertIn(
                            f.options,
                            loaded,
                            f"{app}: {dt}.{f.fieldname} needs {f.options}, "
                            f"which loads after it (step '{label}')",
                        )
                loaded.update(doctypes)

    def test_the_submittable_set_matches_the_schema(self):
        """If one stops being submittable the push would set docstatus on a
        doctype that has none."""
        import frappe

        for dt in plan.SUBMITTABLE:
            if not frappe.db.exists("DocType", dt):
                continue
            self.assertTrue(
                frappe.get_meta(dt).is_submittable, f"{dt} is no longer submittable"
            )

    def test_the_plan_only_lists_doctypes_this_bench_has(self):
        import frappe

        missing = [dt for dt in plan.all_doctypes() if not frappe.db.exists("DocType", dt)]
        self.assertEqual(missing, [], f"plan lists doctypes that do not exist: {missing}")

    def test_prerequisites_are_not_in_the_push_list(self):
        """They belong to upande_core and ERPNext — listing them would try to
        create Farms and Items we do not own."""
        pushed = set(plan.all_doctypes())
        for doctype, _owner, _why in plan.PREREQUISITE_DOCTYPES:
            self.assertNotIn(doctype, pushed)
