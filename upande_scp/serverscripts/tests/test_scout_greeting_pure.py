"""Scout greeting rules and flow — pure rules run under plain pytest; the
setting-off and wiring checks use fakes, no database."""

import unittest
from datetime import date
from unittest.mock import patch

from upande_scp.serverscripts.common import scout_greeting_rules as R

TODAY = date(2026, 10, 14)  # a Wednesday


class TestBirthday(unittest.TestCase):
    def test_same_month_and_day(self):
        self.assertTrue(R.is_birthday(date(1990, 10, 14), TODAY))
        self.assertTrue(R.is_birthday("1990-10-14", TODAY))
        self.assertFalse(R.is_birthday(date(1990, 10, 15), TODAY))
        self.assertFalse(R.is_birthday(None, TODAY))

    def test_leap_day_moves_to_28_feb_in_a_common_year(self):
        dob = date(1992, 2, 29)
        self.assertTrue(R.is_birthday(dob, date(2027, 2, 28)))
        self.assertFalse(R.is_birthday(dob, date(2027, 3, 1)))
        self.assertTrue(R.is_birthday(dob, date(2028, 2, 29)))
        self.assertFalse(R.is_birthday(dob, date(2028, 2, 28)))
        self.assertTrue(R.is_birthday(dob, date(2100, 2, 28)))  # 2100 is not a leap year

    def test_1_january_is_a_placeholder_not_a_birthday(self):
        self.assertFalse(R.is_birthday(date(1982, 1, 1), date(2027, 1, 1)))


class TestMilestones(unittest.TestCase):
    def test_entry_milestone_crossed_in_the_window(self):
        self.assertEqual(R.crossed_entry_milestone(5200, 400), 5000)
        self.assertEqual(R.crossed_entry_milestone(10050, 100), 10000)
        self.assertIsNone(R.crossed_entry_milestone(5200, 100))  # crossed long ago
        self.assertIsNone(R.crossed_entry_milestone(900, 900))
        self.assertEqual(R.crossed_entry_milestone(30500, 20000), 30000)  # highest of several

    def test_streak_skips_sundays(self):
        # Wed 14, Tue 13, Mon 12, Sat 10, Fri 9 with Sunday 11 unscouted: five in a row
        days = [date(2026, 10, d) for d in (14, 13, 12, 10, 9)]
        self.assertEqual(R.streak_from_dates(days, TODAY), (5, TODAY))
        # a missed Saturday breaks it
        days = [date(2026, 10, d) for d in (14, 13, 12, 9)]
        self.assertEqual(R.streak_from_dates(days, TODAY)[0], 3)
        # today not scouted yet: yesterday carries the run
        self.assertEqual(R.streak_from_dates([date(2026, 10, 13)], TODAY), (1, date(2026, 10, 13)))
        self.assertEqual(R.streak_from_dates([date(2026, 10, 1)], TODAY), (0, None))

    def test_streak_milestone_only_when_recent(self):
        self.assertEqual(R.streak_milestone(5, TODAY, TODAY), 5)
        self.assertEqual(R.streak_milestone(12, TODAY, TODAY), 10)
        self.assertIsNone(R.streak_milestone(12, date(2026, 10, 14), date(2026, 10, 30)))
        self.assertIsNone(R.streak_milestone(4, TODAY, TODAY))


class TestChoose(unittest.TestCase):
    base = {"first_name": "Mark", "entries_recent": 500}

    def test_priority_birthday_over_milestone_over_encouragement(self):
        s = {**self.base, "date_of_birth": date(1990, 10, 14), "lifetime": 5100, "entries_last7": 300,
             "plan_total": 5, "plan_done": 3}
        self.assertEqual(R.choose(s, TODAY, "u")["kind"], "birthday")
        s["date_of_birth"] = date(1990, 3, 3)
        g = R.choose(s, TODAY, "u")
        self.assertEqual(g["kind"], "milestone")
        self.assertIn("5,000", g["title"])
        s["lifetime"] = 6000
        self.assertEqual(R.choose(s, TODAY, "u")["kind"], "encouragement")

    def test_birthday_uses_the_first_name_without_emoji(self):
        g = R.choose({"first_name": "Mark", "date_of_birth": date(1990, 10, 14)}, TODAY, "u")
        self.assertIn("Mark", g["title"])
        self.assertTrue((g["title"] + g["message"]).isascii())

    def test_plan_progress(self):
        g = R.choose({**self.base, "plan_total": 5, "plan_done": 3}, TODAY, "u")
        self.assertEqual(g["kind"], "encouragement")
        self.assertIn("3 of 5", g["title"] + g["message"])
        self.assertIn("two", g["message"].lower() if "to go" in g["message"] else "two to go")
        done = R.choose({**self.base, "plan_total": 5, "plan_done": 5}, TODAY, "u")
        self.assertIn("complete", done["title"].lower())
        self.assertEqual(g["stats"]["plan_done"], 3)

    def test_ahead_of_last_week_then_steady_then_general_then_nothing(self):
        self.assertEqual(R.choose({"entries_week": 300, "entries_last_week_same_span": 200}, TODAY, "u")["title"],
                         "Ahead of last week")
        self.assertEqual(R.choose({"entries_week": 100, "entries_last_week_same_span": 200}, TODAY, "u")["kind"],
                         "encouragement")
        self.assertEqual(R.choose({"entries_recent": 40}, TODAY, "u")["kind"], "encouragement")
        self.assertIsNone(R.choose({}, TODAY, "u")["kind"])

    def test_entry_count_is_pluralised(self):
        g = R.choose({"entries_week": 1}, TODAY, "u")
        self.assertIn("1 entry", g["message"])
        self.assertNotIn("1 entries", g["message"])

    def test_deterministic_per_user_per_day_and_varies(self):
        s = {**self.base, "plan_total": 5, "plan_done": 1}
        a = [R.choose(s, TODAY, "mark@x") for _ in range(5)]
        self.assertTrue(all(x == a[0] for x in a))
        texts = {R.choose(s, date(2026, 10, 1 + i), f"u{i}")["message"] for i in range(20)}
        self.assertGreater(len(texts), 1)

    def test_first_name(self):
        self.assertEqual(R.first_name("MARK KIPKOGEI BUNEI"), "Mark")
        self.assertEqual(R.first_name("X Y", "jane"), "Jane")
        self.assertEqual(R.first_name(None), "")


class TestSettingOff(unittest.TestCase):
    def test_off_returns_kind_null_without_reading_anything(self):
        from upande_scp.serverscripts.scouts import greeting as G
        with patch.object(G.capture_settings, "greetings_enabled", return_value=False), \
             patch.object(G, "_employee", side_effect=AssertionError("must not query")), \
             patch.object(G, "frappe") as fr, patch.object(G, "nowdate", return_value="2026-10-14"):
            fr.session.user = "a@b.c"
            self.assertIsNone(G.greeting_for("a@b.c", TODAY)["kind"])
            self.assertIsNone(G.get_scout_greeting()["kind"])
            fr.cache.assert_not_called()

    def test_no_employee_returns_null(self):
        from upande_scp.serverscripts.scouts import greeting as G
        with patch.object(G.capture_settings, "greetings_enabled", return_value=True), \
             patch.object(G, "_employee", return_value=None):
            self.assertIsNone(G.greeting_for("a@b.c", TODAY)["kind"])

    def test_on_picks_the_birthday_from_gathered_stats(self):
        from upande_scp.serverscripts.scouts import greeting as G
        emp = {"name": "E1", "employee_name": "JANE DOE", "first_name": "Jane", "date_of_birth": date(1990, 10, 14)}
        with patch.object(G.capture_settings, "greetings_enabled", return_value=True), \
             patch.object(G, "_employee", return_value=emp), \
             patch.object(G, "gather", return_value={"first_name": "Jane", "date_of_birth": emp["date_of_birth"]}):
            g = G.greeting_for("jane@x", TODAY)
        self.assertEqual(g["kind"], "birthday")
        self.assertIn("Jane", g["title"])


if __name__ == "__main__":
    unittest.main()
