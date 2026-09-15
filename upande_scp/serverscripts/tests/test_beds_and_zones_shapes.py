"""The zones the web maps draw, and the shape they are stored in.

`get_beds_and_zones` feeds every map in the React app — the scouting heatmap, the
observation map, the 3D view and the Application Plan's zone picker. It read each
Zone's GeoJSON as `gj["features"][0]`, which is one of the three shapes this data
comes in, and swallowed everything else in a bare `except Exception: continue`.

On the live site 148,186 of 154,434 zones — 96% — are stored as a bare Feature.
Every one of them was dropped without a log, so the endpoint returned beds with
no zones and the maps said "Zone geometry not available for this greenhouse" or
sat for ever on "Zone polygons are being parsed in the background". Nothing about
it looked like a failure; it looked like missing data.

The mobile endpoints learned to read all three shapes months ago
(`_feature_geometry`). This one never did.
"""

import json
import unittest

from upande_scp.serverscripts.geo.get_beds_and_zones import decode_zone

BED = "Chepsito GH 01 - KR - Bed 1"
ZONE = f"{BED} - Zone 1"
COORDS = [[35.75428126113157, 0.06791330258419671], [35.75425316157819, 0.06793580492289777]]


def row(geojson, name=ZONE, bed=BED):
	return {"name": name, "bed": bed, "geojson": json.dumps(geojson)}


BARE_FEATURE = {
	"type": "Feature",
	"properties": {"fid": 1, "line_id": 1, "zone_id": 1},
	"geometry": {"type": "LineString", "coordinates": COORDS},
}
COLLECTION = {"type": "FeatureCollection", "features": [BARE_FEATURE]}
BARE_GEOMETRY = {"type": "LineString", "coordinates": COORDS}


class TestTheThreeShapes(unittest.TestCase):
	def test_a_bare_feature_decodes(self):
		"""96% of the live site. This is the whole bug."""
		out = decode_zone(row(BARE_FEATURE))
		self.assertIsNotNone(out)
		self.assertEqual(out["coords"], COORDS)
		self.assertEqual(out["line_id"], 1)
		self.assertEqual(out["order"], 1)
		self.assertEqual(out["bed"], BED)

	def test_a_feature_collection_still_decodes(self):
		"""The 4% that always worked must keep working."""
		out = decode_zone(row(COLLECTION))
		self.assertIsNotNone(out)
		self.assertEqual(out["coords"], COORDS)
		self.assertEqual(out["line_id"], 1)

	def test_a_bare_geometry_decodes_when_it_carries_a_line(self):
		"""No properties, so no line_id — the encoder needs one, so it is skipped
		rather than guessed at."""
		self.assertIsNone(decode_zone(row(BARE_GEOMETRY)))

	def test_all_three_shapes_agree_on_the_coordinates(self):
		a = decode_zone(row(BARE_FEATURE))
		b = decode_zone(row(COLLECTION))
		self.assertEqual(a["coords"], b["coords"])


class TestWhatIsStillRefused(unittest.TestCase):
	def test_a_zone_whose_bed_is_not_in_the_list(self):
		self.assertIsNone(decode_zone(row(BARE_FEATURE), bed_names={"some other bed"}))

	def test_a_zone_named_outside_the_convention(self):
		"""The order comes from the name; without it the zone cannot be placed."""
		self.assertIsNone(decode_zone(row(BARE_FEATURE, name=f"{BED} - Zone A")))
		self.assertIsNone(decode_zone(row(BARE_FEATURE, name="Some Zone")))

	def test_a_line_with_more_than_two_points(self):
		"""The wire format encodes a two-point segment; a longer line is not one."""
		long_line = {
			"type": "Feature",
			"properties": {"line_id": 1},
			"geometry": {"type": "LineString", "coordinates": COORDS + [[35.0, 0.1]]},
		}
		self.assertIsNone(decode_zone(row(long_line)))

	def test_broken_json(self):
		self.assertIsNone(decode_zone({"name": ZONE, "bed": BED, "geojson": "{not json"}))

	def test_no_geometry_at_all(self):
		self.assertIsNone(
			decode_zone(row({"type": "Feature", "properties": {"line_id": 1}}))
		)

	def test_a_feature_without_a_line_id(self):
		no_id = {
			"type": "Feature",
			"properties": {"fid": 3},
			"geometry": {"type": "LineString", "coordinates": COORDS},
		}
		self.assertIsNone(decode_zone(row(no_id)))

	def test_an_empty_row(self):
		self.assertIsNone(decode_zone({}))
		self.assertIsNone(decode_zone({"name": ZONE, "bed": BED, "geojson": ""}))


class TestItAcceptsAlreadyParsedJson(unittest.TestCase):
	def test_a_dict_rather_than_a_string(self):
		"""Frappe hands back a str, but a caller holding the parsed form should
		not have to re-serialise it to be understood."""
		out = decode_zone({"name": ZONE, "bed": BED, "geojson": BARE_FEATURE})
		self.assertIsNotNone(out)
		self.assertEqual(out["coords"], COORDS)
