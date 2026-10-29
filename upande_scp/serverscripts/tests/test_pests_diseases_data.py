"""Pure test of the pest / disease seed data (no DB writes)."""

import unittest

from upande_scp.serverscripts.scouting import seed_pests_diseases as S
from upande_scp.serverscripts.scouting import pests_diseases_extra_data as X

MUTARA_CROPS = ["Avocado", "Potato", "Onion", "Cabbage", "Passion Fruit"]


class TestPestDiseaseData(unittest.TestCase):
	def test_no_duplicate_records(self):
		for rows in (S._all_pests(), S._all_diseases()):
			names = [r[0] for r in rows]
			self.assertEqual(len(names), len(set(names)), "duplicate master")
			for _n, _s, crops, _st, _g in rows:
				self.assertEqual(len(crops), len(set(crops)))

	def test_every_crop_has_pests_and_diseases(self):
		for crop in MUTARA_CROPS:
			self.assertTrue(any(crop in r[2] for r in S._all_pests()), crop)
			self.assertTrue(any(crop in r[2] for r in S._all_diseases()), crop)

	def test_every_stage_in_vocabulary(self):
		vocab = set(X.STAGE_CATALOG) | {n for n, _i, _r in S.REQUIRED_STAGES}
		for rows in (S._all_pests(), S._all_diseases()):
			for name, _s, _c, stages, _g in rows:
				for st in stages:
					self.assertIn(st, vocab, f"{name}: {st}")

	def test_new_records_documented_and_coloured(self):
		for name, sci, _c, _st, guide in X.NEW_PESTS:
			self.assertTrue(sci and guide.startswith("ID:"), name)
			self.assertIn(name, X.NEW_PEST_COLORS)
		for name, sci, _c, _st, guide in X.NEW_DISEASES:
			self.assertTrue(sci and guide.startswith("ID:"), name)
			self.assertIn(name, X.NEW_DISEASE_COLORS)

	def test_extra_crops_target_existing_records(self):
		pests = {r[0] for r in S.PESTS}
		diseases = {r[0] for r in S.DISEASES}
		self.assertLessEqual(set(X.EXTRA_PEST_CROPS), pests)
		self.assertLessEqual(set(X.EXTRA_DISEASE_CROPS), diseases)


def _crops_of(pest):
	return set(next(r[2] for r in S._all_pests() if r[0] == pest))


class TestMutaraPestCropMapping(unittest.TestCase):
	PIVOT_CROPS = {"Potato", "Cabbage", "Onion", "Passion Fruit", "Corn"}

	def test_requested_pest_crop_links(self):
		self.assertIn("Avocado", _crops_of("Scale Insects"))
		self.assertLessEqual({"Passion Fruit"}, _crops_of("Spidermites"))
		self.assertLessEqual({"Passion Fruit"}, _crops_of("Broad Mites"))
		self.assertIn("Passion Fruit", _crops_of("Aphids"))
		self.assertEqual(self.PIVOT_CROPS, self.PIVOT_CROPS & _crops_of("Thrips"))
		self.assertLessEqual({"Cabbage", "Potato", "Onion"}, _crops_of("Cutworms"))
		self.assertLessEqual(self.PIVOT_CROPS | {"Avocado"}, _crops_of("Caterpillars"))
		self.assertEqual({"Corn"}, _crops_of("Fall Armyworm"))
		self.assertEqual({"Potato"}, _crops_of("Potato Tuber Moth"))
		self.assertEqual({"Cabbage"}, _crops_of("Diamondback Moth"))

	def test_corn_pests_have_stages_and_colour(self):
		corn = [r for r in S._all_pests() if "Corn" in r[2]]
		self.assertTrue(corn)
		for name, _s, _c, stages, _g in corn:
			self.assertTrue(stages, name)
		self.assertIn("Fall Armyworm", X.NEW_PEST_COLORS)


class TestCropItemMap(unittest.TestCase):
	def test_variety_items_join_their_crop(self):
		from upande_scp.serverscripts.migrate.seed_mutara_locations import crop_item_map

		m = crop_item_map(["Potatoes - Shangi", "Cabbage - Gloria F1", "Passion Fruit - Purple", "Hass Avocado"])
		self.assertIn("Potatoes - Shangi", m["Potato"])
		self.assertIn("Cabbage - Gloria F1", m["Cabbage"])
		self.assertIn("Passion Fruit - Purple", m["Passion Fruit"])
		self.assertEqual(["Maize"], m["Corn"])


def _disease_crops(name):
	return set(next(r[2] for r in S._all_diseases() if r[0] == name))


class TestRequestedDiseasesAndBeneficials(unittest.TestCase):
	ALL = {"Avocado", "Potato", "Onion", "Cabbage", "Passion Fruit", "Corn"}

	def test_disease_crop_links(self):
		self.assertIn("Corn", _disease_crops("Corn Rust"))
		self.assertLessEqual({"Avocado", "Passion Fruit"}, _disease_crops("Anthracnose"))
		self.assertEqual({"Avocado", "Cabbage"}, _disease_crops("Leaf Spot"))
		self.assertEqual({"Cabbage"}, _disease_crops("Damping Off"))
		self.assertEqual(self.ALL, self.ALL & _disease_crops("Fusarium Wilt"))
		self.assertEqual(self.ALL, self.ALL & _disease_crops("Bacterial Wilt (Ralstonia)"))
		self.assertIn("Cabbage", _disease_crops("Black Rot"))
		self.assertIn("Potato", _disease_crops("Botrytis"))
		self.assertIn("Onion", _disease_crops("Onion Powdery Mildew"))
		self.assertIn("Onion", _disease_crops("Onion Downy Mildew"))
		self.assertIn("Onion", _disease_crops("Purple Blotch"))
		self.assertEqual({"Corn"}, _disease_crops("Maize Lethal Necrosis (MLND)"))

	def test_persea_mite(self):
		self.assertEqual({"Avocado", "Passion Fruit"}, _crops_of("Persea Mite"))
		self.assertIn("Broad Mites", {r[0] for r in S._all_pests()})

	def test_predators_modelled_like_kaitet(self):
		by = {r[0]: r for r in X.PREDATORS}
		for name in ("Ladybird", "Lacewing"):
			self.assertEqual(set(X.ALL_MUTARA_CROPS), set(by[name][2]))
			self.assertTrue(by[name][5].startswith("ID:") and by[name][1] and by[name][4])
			pests = {r[0] for r in S._all_pests()}
			self.assertLessEqual(set(by[name][3]), pests)
		self.assertEqual(len({r[0] for r in X.PREDATORS}), len(X.PREDATORS))
