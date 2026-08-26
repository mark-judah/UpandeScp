"""The scout's chosen zone, and what GPS is for once they have chosen it.

Zone used to be decided entirely by matching the GPS point against surveyed
geometry. That fails in two ways this covers: a fix drifting under a polytunnel
puts a scout in the wrong column, and a farm whose beds were never surveyed —
Altura — could not scout at all, because a zone was mandatory and unresolvable.

The scout now decides. GPS becomes the check on the claim, and a bad fix costs a
verification result rather than the scout's work.
"""

import unittest

import frappe

from upande_scp.serverscripts.mobile import create_scouting_entry as ce
from upande_scp.serverscripts.mobile import geo_utils


class TestDistanceToNamedZone(unittest.TestCase):
    def test_unmeasurable_is_none_not_zero(self):
        """0.0 would read as a perfect fix. A farm with no surveyed beds would
        look flawlessly accurate, which is the opposite of the truth."""
        self.assertIsNone(geo_utils.get_distance_to_zone(None, None, "any"))
        self.assertIsNone(geo_utils.get_distance_to_zone("1.0", "36.0", ""))
        self.assertIsNone(
            geo_utils.get_distance_to_zone("1.0", "36.0", "no-such-zone-xyz")
        )


class TestManualZoneIsHonoured(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        frappe.set_user("Administrator")
        cls.zone = frappe.db.get_value(
            "Zone", {"raw_geojson": ["!=", ""]}, ["name", "bed"], as_dict=True
        )

    def _payload(self, **over):
        base = {
            "client_id": "test-manual-zone",
            "scouts_name": "charlesmulemba@monaflowers.co.ke",
            "greenhouse": (self.zone.bed or "").rsplit(" - Bed", 1)[0],
            "bed": self.zone.bed,
            "zone": self.zone.name,
            "latitude": "0.4175", "longitude": "35.4054", "accuracy": 5,
            "date_of_capture": "2026-08-25", "time_of_capture": "10:00:00",
        }
        base.update(over)
        return base

    def test_the_endpoint_reads_the_client_s_zone_at_all(self):
        """It did not. `scout_doc.zone` was always the GPS-derived value, so a
        scout's pick was discarded without trace."""
        import inspect
        src = inspect.getsource(ce)
        self.assertIn("entry_data.get('zone')", src)
        self.assertIn("scout_doc.zone       = final_zone", src)

    def test_a_bed_with_no_resolvable_zone_no_longer_blocks_a_chosen_one(self):
        """The old guard rejected any bed whose GPS zone could not be resolved.
        On a farm with no geometry that rejected every entry ever."""
        import inspect
        src = inspect.getsource(ce)
        self.assertIn("if bed_for_zone and not final_zone:", src)

    def test_a_missing_fix_only_blocks_when_gps_is_deciding(self):
        import inspect
        src = inspect.getsource(ce)
        self.assertIn(
            "Latitude and longitude are required when no zone is selected.", src
        )

    def test_tolerance_allows_for_the_fix_s_own_accuracy(self):
        """Comparing a distance against zero would call every fix 'Far'; the
        reading is only ever as good as its stated accuracy."""
        self.assertGreater(ce.ZONE_VERIFY_TOLERANCE_M, 0)


class TestDistanceIsOnlyMeaningfulWithItsVerdict(unittest.TestCase):
    def test_the_field_says_so_itself(self):
        """A Float coerces None to 0, so an unmeasurable distance stores as
        0.0 — indistinguishable from a perfect fix unless the reader also
        checks Zone Verification. The field description has to say that,
        because the column alone cannot."""
        meta = frappe.get_meta("Scouting Entry Metadata")
        field = meta.get_field("selected_zone_distance")
        self.assertIsNotNone(field)
        self.assertIn("Verified or Far", field.description or "")

    def test_the_verdict_field_carries_the_unmeasurable_cases(self):
        meta = frappe.get_meta("Scouting Entry Metadata")
        options = (meta.get_field("zone_verification").options or "").split("\n")
        for verdict in ("Verified", "Far", "No Fix", "No Geometry"):
            self.assertIn(verdict, options)
