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
		self.assertGreater((max(r["date"] for r in rows) - min(r["date"] for r in rows)).days, 50)

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
		for r in self.plan(seed=9):
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

		first = [r for r in rows if (r["date"] - start).days < 20]
		last = [r for r in rows if (r["date"] - start).days >= 40]
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


class TestReferenceImages(unittest.TestCase):
	IMAGES = {"aphids": "/r/aphids.jpeg", "caterpillars": "/r/c.jpg", "thrips": "/r/t.jpg", "spodoptera": "/r/s.jpg",
	          "powdery_mildew": "/r/p.jpg", "fruit_fly_(bactocera)": "/r/f.jpg"}

	def test_own_photo_then_alias_then_kind_stand_in(self):
		rng = random.Random(1)
		self.assertEqual(S.pick_reference("Aphids", "pest", self.IMAGES, rng), "/r/aphids.jpeg")
		self.assertEqual(S.pick_reference("Fruit fly (Bactocera)", "pest", self.IMAGES, rng), "/r/f.jpg")
		self.assertEqual(S.pick_reference("Fall Armyworm", "pest", self.IMAGES, rng), "/r/s.jpg")
		self.assertIn(S.pick_reference("Unknown Bug", "pest", self.IMAGES, rng), {"/r/c.jpg", "/r/t.jpg", "/r/aphids.jpeg", "/r/s.jpg"})
		self.assertEqual(S.pick_reference("Late Blight", "disease", self.IMAGES, rng), "/r/p.jpg")
		self.assertIsNone(S.pick_reference("X", "pest", {}, rng))

	def test_reference_images_skip_duplicates_and_thumbnails(self):
		import os
		import tempfile

		with tempfile.TemporaryDirectory() as d:
			for fn in ("aphids.jpeg", "aphidsa55695.jpeg", "calf_thumb.jpg", "QR_x.png", "zz-photo-1.png", "rust.jpg", "x.pdf"):
				open(os.path.join(d, fn), "wb").write(b"x")
			self.assertEqual(sorted(S.reference_images((d, "/nope"))), ["aphids", "rust"])

	def test_real_reference_images_are_readable(self):
		imgs = S.reference_images()
		if not imgs:
			self.skipTest("reference images absent")
		self.assertIn("aphids", imgs)
		self.assertTrue(open(imgs["aphids"], "rb").read(4))


class TestDb(unittest.TestCase):
	def test_second_run_is_a_noop_when_seeded(self):
		if not S.is_seeded():
			self.skipTest("demo scouting not seeded on this site")
		self.assertEqual(S.run(dry_run=True)["status"], "already seeded")


class TestLoadUnits(unittest.TestCase):
	def test_only_live_blocks_with_their_cycle_crop(self):
		if not frappe.db.exists("Production Crop Cycle", {"unit": "P1-B9", "item": "Maize - H513"}):
			self.skipTest("mutara production seed data absent")
		units = {u.block: u.crop for u in S.load_units()}
		self.assertEqual(len([b for b in units if b.startswith("P1-") or b.startswith("P2-")]), 24)
		self.assertEqual(len([b for b in units if b.startswith("PH")]), 25)
		self.assertEqual((units["P1-B9 - MUT"], units["P2-B9 - MUT"]), ("Corn", "Corn"))
		self.assertFalse([b for b in units if b.startswith(("P3-", "P4-", "Avocado Block"))])


class TestTrapReadings(unittest.TestCase):
	def test_one_reading_a_week_building_through_the_window(self):
		end = datetime.date(2026, 10, 29)
		rows = S.trap_readings("Mutara - T01", "Aphids", end, S.WINDOW_DAYS, random.Random(3), ["E1"])
		self.assertTrue(8 <= len(rows) <= 10)
		self.assertTrue(all(r["date"].weekday() == 0 for r in rows))
		self.assertEqual([r["date"] for r in rows], sorted(r["date"] for r in rows))
		self.assertTrue(all(r["count"] >= 0 and r["pest"] == "Aphids" and r["trap"] == "Mutara - T01" for r in rows))
		half = len(rows) // 2
		self.assertGreater(sum(r["count"] for r in rows[half:]), sum(r["count"] for r in rows[:half]))

	def test_deterministic(self):
		end = datetime.date(2026, 10, 29)
		a = S.trap_readings("T", "P", end, S.WINDOW_DAYS, random.Random(5), ["E1", "E2"])
		b = S.trap_readings("T", "P", end, S.WINDOW_DAYS, random.Random(5), ["E1", "E2"])
		self.assertEqual(a, b)
