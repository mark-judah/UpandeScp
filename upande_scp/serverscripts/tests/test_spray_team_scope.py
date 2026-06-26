import unittest
from unittest import mock

from upande_scp.serverscripts.spray_plan_creator import bootstrap as bs


def _make_fake_sql(captured, team_rows):
    def fake_sql(query, values=None, as_dict=False):
        if "tabSpray Team Details" in query:
            # Members query for one team.
            return [
                {
                    "employee": "E1",
                    "employee_name": "Emp One",
                    "designation": "Sprayer",
                    "role": "Sprayer",
                }
            ]
        # Team-list query.
        captured["query"] = query
        captured["params"] = values
        return list(team_rows)

    return fake_sql


class TestFetchSprayTeams(unittest.TestCase):
    def test_matches_farm_unfarmed_and_legacy_name(self):
        captured = {}
        team_rows = [
            {"name": "Team A", "custom_farm": "Main"},   # farm-tagged
            {"name": "Team B", "custom_farm": None},     # unfarmed (global)
            {"name": "Team A", "custom_farm": "Main"},   # duplicate -> de-duped
        ]
        with mock.patch.object(bs.frappe, "db", mock.Mock(sql=_make_fake_sql(captured, team_rows))):
            teams = bs._fetch_spray_teams(["Main"])

        # De-dup keeps two distinct teams, each with members attached.
        self.assertEqual([t["name"] for t in teams], ["Team A", "Team B"])
        self.assertTrue(all("members" in t for t in teams))
        self.assertEqual(teams[0]["members"][0]["employee"], "E1")

        # The query must match by custom_farm, by unfarmed, AND by legacy name.
        q = captured["query"].lower()
        self.assertIn("custom_farm in", q)
        self.assertIn("custom_farm is null", q)
        self.assertIn("like", q)

    def test_no_farms_returns_empty(self):
        # No DB call should be needed when the user has no farms.
        with mock.patch.object(bs.frappe, "db", mock.Mock(sql=mock.Mock(side_effect=AssertionError("should not query")))):
            self.assertEqual(bs._fetch_spray_teams([]), [])
