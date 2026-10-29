"""Mutara demo scouting seed: the generator is deterministic, spreads hot spots over time, keeps to
each crop's own targets, and the DB side is idempotent and clearable.

Run: bench --site mutara.local run-tests --app upande_scp \
        --module upande_scp.serverscripts.tests.test_seed_mutara_scouting
"""

import datetime
import math
import random
import unittest

import frappe

from upande_scp.serverscripts.migrate import seed_mutara_scouting as S

CATALOG = {
	"Potato": {
		"pests": ["Aphids", "Thrips", "Cutworms"],
		"diseases": ["Late Blight", "Early Blight"],
		"predators": ["Ladybird"],
		"stages": {"Aphids": ["Colonies"], "Thrips": ["Adult"], "Cutworms": ["Larvae"]},
		"bands": {"Aphids": (3, 10), "Thrips": (3, 10), "Cutworms": (3, 10)},
	},
}


def _unit(n_sites=300):
	rng = random.Random(1)
	sites = [(f"T{i}", 36.67 + rng.random() * 0.002, 0.04 + rng.random() * 0.002, f"R{i % 10}", i) for i in range(n_sites)]
	return S.Unit(block="P1-B1 - MUT", crop="Potato", sites=sites, polygon=None)


class TestPlan(unittest.TestCase):
	def plan(self, n=4000, seed=7):
		end = datetime.date(2026, 10, 29)
		return S.plan_unit(_unit(), CATALOG["Potato"], n, end, S.WINDOW_DAYS, ["E1", "E2", "E3"], random.Random(seed))

	def test_count_and_window(self):
		rows = self.plan()
		self.assertEqual(len(rows), 4000)
		lo = datetime.date(2026, 10, 29) - datetime.timedelta(days=S.WINDOW_DAYS)
		self.assertTrue(all(lo <= r["date"] <= datetime.date(2026, 10, 29) for r in rows))
		self.assertGreater((max(r["date"] for r in rows) - min(r["date"] for r in rows)).days, 150)

	def test_deterministic(self):
		a, b = self.plan(500), self.plan(500)
		self.assertEqual([(r["date"], r["site"], r["pests"]) for r in a], [(r["date"], r["site"], r["pests"]) for r in b])

	def test_only_the_crops_own_targets(self):
		for r in self.plan(1500):
			for p in r["pests"]:
				self.assertIn(p["pest"], CATALOG["Potato"]["pests"])
				self.assertIn(p["stage"], CATALOG["Potato"]["stages"][p["pest"]])
				self.assertGreaterEqual(p["count"], 1)
			for d in r["diseases"]:
				self.assertIn(d["disease"], CATALOG["Potato"]["diseases"])
			for q in r["predators"]:
				self.assertIn(q["predator"], CATALOG["Potato"]["predators"])

	def test_all_three_severity_bands_occur(self):
		low = mod = high = 0
		for r in self.plan():
			for p in r["pests"]:
				lo_hi = CATALOG["Potato"]["bands"][p["pest"]]
				if p["count"] <= lo_hi[0]:
					low += 1
				elif p["count"] <= lo_hi[1]:
					mod += 1
				else:
					high += 1
		self.assertTrue(low > 0 and mod > 0 and high > 0, (low, mod, high))

	def test_clean_visits_exist(self):
		rows = self.plan()
		clean = [r for r in rows if not (r["pests"] or r["diseases"])]
		self.assertGreater(len(clean), len(rows) * 0.2)
		self.assertLess(len(clean), len(rows) * 0.9)

	def test_infestation_builds_over_the_window(self):
		rows = self.plan(8000)
		start = min(r["date"] for r in rows)

		def hit_rate(rs):
			return sum(1 for r in rs if r["pests"] or r["diseases"]) / len(rs)

		first = [r for r in rows if (r["date"] - start).days < 60]
		last = [r for r in rows if (r["date"] - start).days >= 120]
		self.assertGreater(hit_rate(last), hit_rate(first))


class TestHotspot(unittest.TestCase):
	def hs(self):
		return S.Hotspot(kind="pest", target="Aphids", x=0.0, y=0.0, onset=20, sigma0=25.0, growth=0.5, peak=1.0, treated=None, season="flat")

	def test_nothing_before_onset(self):
		self.assertEqual(S.Hotspot.strength(self.hs(), day=5, dist_m=0, month=6), 0.0)

	def test_spreads_outward_over_time(self):
		h = self.hs()
		far = 80.0
		self.assertGreater(S.Hotspot.strength(h, 100, far, 8), S.Hotspot.strength(h, 40, far, 8))

	def test_falls_off_with_distance(self):
		h = self.hs()
		self.assertGreater(S.Hotspot.strength(h, 60, 5, 8), S.Hotspot.strength(h, 60, 120, 8))


class TestHelpers(unittest.TestCase):
	def test_series_numbers_are_five_digits(self):
		self.assertEqual(S.sce_name(2026, 51), "SCE-2026-00051")

	def test_allocation_sums_to_total_and_skips_cropless(self):
		alloc = S.allocate({"Avocado": 3, "Potato": 2, "Corn": 0}, 1000)
		self.assertEqual(sum(alloc.values()), 1000)
		self.assertNotIn("Corn", alloc)
		self.assertGreater(alloc["Avocado"], alloc["Potato"])

	def test_point_in_polygon(self):
		sq = [(0, 0), (1, 0), (1, 1), (0, 1), (0, 0)]
		pts = [S.random_point_in(sq, random.Random(i)) for i in range(50)]
		self.assertTrue(all(0 <= x <= 1 and 0 <= y <= 1 for x, y in pts))


class TestDb(unittest.TestCase):
	def test_second_run_is_a_noop_when_seeded(self):
		if not S.is_seeded():
			self.skipTest("demo scouting not seeded on this site")
		self.assertEqual(S.run(dry_run=True)["status"], "already seeded")
