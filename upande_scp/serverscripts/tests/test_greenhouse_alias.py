"""Sending a capture to the greenhouse that actually has beds.

Two Warehouse records exist for the same physical greenhouse — `Torongo GH18 -
KR` and `Torongo GH 18 - KR`, differing by one space. The second holds all 558
beds and 73,159 entries; the first was created later for stock and has none. A
handset that cached the empty one fails every capture with Frappe's own link
error, `Could not find Bed: Torongo GH18 - KR - Bed 250`, because the bed it
names does not exist. One scout lost six days that way.

Both records have to stay — the empty one carries stock — so the fix is to
recognise the pair on the way in and file the capture under the record that has
the beds.

The rules are deliberately narrow. A name is only ever redirected when it has no
beds of its own AND exactly one same-name twin has them. Anything ambiguous is
left alone to fail visibly, because a capture filed under the wrong greenhouse is
worse than one that is refused.
"""

import unittest

from upande_scp.serverscripts.mobile import greenhouse_alias as GA


def rows(*pairs):
	"""(name, bed_count) -> the row shape `build_alias_map` reads."""
	return [{"name": n, "beds": b} for n, b in pairs]


class TestRecognisingTheSameName(unittest.TestCase):
	def test_a_missing_space_is_the_same_name(self):
		self.assertEqual(GA.squash("Torongo GH18 - KR"), GA.squash("Torongo GH 18 - KR"))

	def test_so_is_a_doubled_space(self):
		self.assertEqual(GA.squash("Chepsito GH 15   - KR"), GA.squash("Chepsito GH 15 - KR"))

	def test_case_does_not_matter(self):
		self.assertEqual(GA.squash("TORONGO gh18 - kr"), GA.squash("Torongo GH 18 - KR"))

	def test_different_greenhouses_stay_different(self):
		self.assertNotEqual(GA.squash("Torongo GH 17 - KR"), GA.squash("Torongo GH 18 - KR"))

	def test_nothing_is_not_a_name(self):
		self.assertEqual(GA.squash(None), "")
		self.assertEqual(GA.squash("   "), "")


class TestBuildingTheMap(unittest.TestCase):
	def test_the_bedless_twin_points_at_the_one_with_beds(self):
		m = GA.build_alias_map(rows(("Torongo GH18 - KR", 0), ("Torongo GH 18 - KR", 558)))
		self.assertEqual(m, {"Torongo GH18 - KR": "Torongo GH 18 - KR"})

	def test_a_greenhouse_with_beds_is_never_redirected(self):
		m = GA.build_alias_map(rows(("Torongo GH 18 - KR", 558), ("Torongo GH18 - KR", 3)))
		self.assertEqual(m, {})

	def test_a_lone_bedless_greenhouse_is_left_alone(self):
		"""No twin means nothing to redirect to — a genuinely new greenhouse."""
		self.assertEqual(GA.build_alias_map(rows(("Kapkolia GH 99 - KR", 0))), {})

	def test_two_bedded_twins_are_refused_as_ambiguous(self):
		"""Guessing between two populated records could file a capture under the
		wrong physical house. Better to refuse and be seen."""
		m = GA.build_alias_map(
			rows(("Torongo GH18 - KR", 0), ("Torongo GH 18 - KR", 558), ("TORONGO GH 18 - KR", 12))
		)
		self.assertEqual(m, {})

	def test_neither_twin_has_beds(self):
		m = GA.build_alias_map(rows(("A GH 1 - KR", 0), ("A GH1 - KR", 0)))
		self.assertEqual(m, {})

	def test_several_pairs_at_once(self):
		m = GA.build_alias_map(
			rows(
				("Torongo GH18 - KR", 0), ("Torongo GH 18 - KR", 558),
				("Torongo GH17 - KR", 0), ("Torongo GH 17 - KR", 504),
				("Chepsito GH 15   - KR", 0), ("Chepsito GH 15 - KR", 205),
			)
		)
		self.assertEqual(
			m,
			{
				"Torongo GH18 - KR": "Torongo GH 18 - KR",
				"Torongo GH17 - KR": "Torongo GH 17 - KR",
				"Chepsito GH 15   - KR": "Chepsito GH 15 - KR",
			},
		)


class TestRewritingACapture(unittest.TestCase):
	MAP = {"Torongo GH18 - KR": "Torongo GH 18 - KR"}

	def test_the_greenhouse_and_the_bed_move_together(self):
		"""The bed is a link whose name embeds the greenhouse, so redirecting one
		without the other just swaps which half is wrong."""
		out = GA.rewrite_entry(
			{"greenhouse": "Torongo GH18 - KR", "bed": "Torongo GH18 - KR - Bed 250"}, self.MAP
		)
		self.assertEqual(out["greenhouse"], "Torongo GH 18 - KR")
		self.assertEqual(out["bed"], "Torongo GH 18 - KR - Bed 250")

	def test_everything_else_is_untouched(self):
		entry = {
			"greenhouse": "Torongo GH18 - KR",
			"bed": "Torongo GH18 - KR - Bed 3",
			"scouts_name": "christine.cheruiyot@karenroses.com",
			"client_id": "abc",
			"latitude": "0.91",
		}
		out = GA.rewrite_entry(entry, self.MAP)
		for k in ("scouts_name", "client_id", "latitude"):
			self.assertEqual(out[k], entry[k])

	def test_the_original_is_not_mutated(self):
		entry = {"greenhouse": "Torongo GH18 - KR", "bed": "Torongo GH18 - KR - Bed 1"}
		GA.rewrite_entry(entry, self.MAP)
		self.assertEqual(entry["greenhouse"], "Torongo GH18 - KR")

	def test_a_greenhouse_not_in_the_map_passes_through(self):
		entry = {"greenhouse": "Chepsito GH 01 - KR", "bed": "Chepsito GH 01 - KR - Bed 9"}
		self.assertEqual(GA.rewrite_entry(entry, self.MAP), entry)

	def test_an_empty_map_changes_nothing(self):
		entry = {"greenhouse": "Torongo GH18 - KR", "bed": "Torongo GH18 - KR - Bed 1"}
		self.assertEqual(GA.rewrite_entry(entry, {}), entry)

	def test_a_bed_that_does_not_carry_the_greenhouse_is_left_as_it_is(self):
		"""Only a prefix match is safe to rewrite; anything else is a naming
		convention we do not know."""
		out = GA.rewrite_entry(
			{"greenhouse": "Torongo GH18 - KR", "bed": "Bed 250"}, self.MAP
		)
		self.assertEqual(out["greenhouse"], "Torongo GH 18 - KR")
		self.assertEqual(out["bed"], "Bed 250")

	def test_a_capture_with_no_bed_still_moves(self):
		out = GA.rewrite_entry({"greenhouse": "Torongo GH18 - KR", "bed": ""}, self.MAP)
		self.assertEqual(out["greenhouse"], "Torongo GH 18 - KR")
		self.assertEqual(out["bed"], "")

	def test_a_block_flow_capture_is_untouched(self):
		"""Block/row captures name no greenhouse; there is nothing to redirect."""
		entry = {"block": "WESA BLK 1 - KL", "row": "Row 4"}
		self.assertEqual(GA.rewrite_entry(entry, self.MAP), entry)


class TestTheWholeBatch(unittest.TestCase):
	MAP = {"Torongo GH18 - KR": "Torongo GH 18 - KR"}

	def test_every_entry_in_a_batch_is_redirected(self):
		batch = [
			{"greenhouse": "Torongo GH18 - KR", "bed": "Torongo GH18 - KR - Bed 1"},
			{"greenhouse": "Torongo GH18 - KR", "bed": "Torongo GH18 - KR - Bed 2"},
			{"greenhouse": "Chepsito GH 01 - KR", "bed": "Chepsito GH 01 - KR - Bed 1"},
		]
		out = GA.rewrite_batch(batch, self.MAP)
		self.assertEqual([e["greenhouse"] for e in out],
		                 ["Torongo GH 18 - KR", "Torongo GH 18 - KR", "Chepsito GH 01 - KR"])

	def test_a_batch_needing_nothing_is_returned_unchanged(self):
		batch = [{"greenhouse": "Chepsito GH 01 - KR"}]
		self.assertIs(GA.rewrite_batch(batch, {}), batch)

	def test_non_dict_members_survive(self):
		batch = [{"greenhouse": "Torongo GH18 - KR"}, "junk"]
		out = GA.rewrite_batch(batch, self.MAP)
		self.assertEqual(out[1], "junk")

	def test_it_reports_what_it_moved(self):
		"""The office needs to know this is happening — it is a data fault being
		papered over, not a feature to leave running for ever."""
		batch = [{"greenhouse": "Torongo GH18 - KR"}, {"greenhouse": "Torongo GH18 - KR"}]
		self.assertEqual(GA.count_redirects(batch, self.MAP), 2)
		self.assertEqual(GA.count_redirects([{"greenhouse": "x"}], self.MAP), 0)
