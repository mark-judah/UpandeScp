"""Reading zone and tree geometry, whatever shape it was stored in.

This file exists because of a fault found on staging by submitting one scouting
entry as a real scout. The entry was aimed at Simotwo GH 19 Bed 219 and was
written against `Simotwo GH 17 - KR - Bed 84 - Zone 9` — a different greenhouse,
104 m away — with `zone_fallback: true` and a bed and zone that disagreed.

The cause was not missing geometry. It was the *shape* of it:

    staging   148,189 of 154,437 zones (96%)  {"type": "Feature", ...}
    kaitet    154,290 of 154,290       (0%)   {"type": "FeatureCollection", ...}

`_build_zone_cache` accepted only FeatureCollection. A bare Feature was neither
logged nor raised — the zone simply never entered the cache, so the point matched
the nearest *parseable* zone instead. The tree cache beside it had always handled
all three shapes; the zone cache never got the same treatment.

Run: bench --site <site> run-tests \
        --module upande_scp.serverscripts.tests.test_geo_utils
"""

import json
import unittest

from upande_scp.serverscripts.mobile.geo_utils import _feature_geometry

# The exact bytes staging holds for the zone whose geometry was being dropped.
STAGING_ZONE = json.dumps({
    "type": "Feature",
    "properties": {"fid": 2025, "line_id": 219, "segment_id": 2, "zone_id": 5},
    "geometry": {
        "type": "LineString",
        "coordinates": [
            [35.75258043130989, 0.0740875083426437],
            [35.75261583653921, 0.07409351999685451],
        ],
    },
})

# The shape kaitet holds, which always worked.
KAITET_ZONE = json.dumps({
    "type": "FeatureCollection",
    "features": [{
        "type": "Feature",
        "properties": {"fid": 756, "zone_id": 9},
        "geometry": {
            "type": "LineString",
            "coordinates": [
                [35.75167560922066, 0.07382681600795499],
                [35.75171000000000, 0.07383000000000000],
            ],
        },
    }],
})


class TestFeatureGeometry(unittest.TestCase):
    def test_the_staging_shape_is_read(self):
        """The regression: a bare Feature must yield its geometry."""
        geometry, props = _feature_geometry(json.loads(STAGING_ZONE))
        self.assertIsNotNone(geometry, "a bare Feature was dropped — the whole bug")
        self.assertEqual(geometry["type"], "LineString")
        self.assertEqual(len(geometry["coordinates"]), 2)
        self.assertEqual(props["zone_id"], 5)

    def test_the_kaitet_shape_still_reads_identically(self):
        geometry, props = _feature_geometry(json.loads(KAITET_ZONE))
        self.assertEqual(geometry["type"], "LineString")
        self.assertEqual(props["fid"], 756)

    def test_both_shapes_yield_the_same_geometry(self):
        """Shape is packaging. The same line stored either way must read the same."""
        line = {"type": "LineString", "coordinates": [[35.0, 0.1], [35.1, 0.2]]}
        as_feature = {"type": "Feature", "properties": {}, "geometry": line}
        as_collection = {"type": "FeatureCollection",
                         "features": [{"type": "Feature", "properties": {}, "geometry": line}]}
        self.assertEqual(_feature_geometry(as_feature)[0],
                         _feature_geometry(as_collection)[0])

    def test_bare_geometry_is_its_own_geometry(self):
        line = {"type": "LineString", "coordinates": [[35.0, 0.1], [35.1, 0.2]]}
        geometry, props = _feature_geometry(line)
        self.assertEqual(geometry, line)
        self.assertEqual(props, {}, "a bare geometry carries no properties")

    def test_a_bare_point_is_read(self):
        """The tree cache's third shape, kept working by the shared reader."""
        point = {"type": "Point", "coordinates": [35.0, 0.1]}
        geometry, _ = _feature_geometry(point)
        self.assertEqual(geometry["type"], "Point")

    def test_tree_radius_survives_both_shapes(self):
        """Radius lives in properties, which differ in depth between the shapes."""
        for doc in (
            {"type": "Feature", "properties": {"radius": 2.5},
             "geometry": {"type": "Point", "coordinates": [35.0, 0.1]}},
            {"type": "FeatureCollection", "features": [
                {"type": "Feature", "properties": {"radius": 2.5},
                 "geometry": {"type": "Point", "coordinates": [35.0, 0.1]}}]},
        ):
            _geometry, props = _feature_geometry(doc)
            self.assertEqual(props.get("radius"), 2.5)

    def test_nothing_usable_returns_none_not_a_crash(self):
        for bad in (
            None, "", [], "not json at all", 42,
            {},
            {"type": "FeatureCollection", "features": []},
            {"type": "FeatureCollection"},
            {"type": "Feature"},
            {"type": "Something Else"},
        ):
            geometry, props = _feature_geometry(bad)
            self.assertIsNone(geometry, repr(bad))
            self.assertEqual(props, {}, repr(bad))

    def test_properties_are_always_a_dict(self):
        """Callers read props.get(...) without guarding; null must not reach them."""
        for doc in (
            {"type": "Feature", "properties": None,
             "geometry": {"type": "Point", "coordinates": [35.0, 0.1]}},
            {"type": "FeatureCollection", "features": [
                {"type": "Feature", "properties": None,
                 "geometry": {"type": "Point", "coordinates": [35.0, 0.1]}}]},
        ):
            _geometry, props = _feature_geometry(doc)
            self.assertEqual(props, {})
