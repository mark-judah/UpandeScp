"""The reference-image manifest: download each photo once, and download little.

Two things here are load-bearing, and both are about a phone in a field on a metered
connection.

**Once.** The phone must be able to tell, without downloading anything, whether it
already holds a photo. That is what `content_hash` is for — and it hashes the file's
*bytes*, not its URL, because the failure that matters is a master's photo being
replaced under the same file name. A URL-only check would serve that stale picture
forever.

**Little.** The masters' photos are full-resolution research downloads — 44 MB across
47 files on kaitet, averaging ~944 KB. The manifest therefore points at a derivative
fitted inside 800 px, which measures ~3 MB for the same set. A test asserts the
derivative is genuinely smaller than the original, because the moment that silently
stops happening the feature is 15x more expensive with nothing failing.

Run: bench --site <site> run-tests \
        --module upande_scp.serverscripts.tests.test_reference_images
"""

import os
import unittest

import frappe

from upande_scp.serverscripts.common.cache_utils import invalidate_reference_images
from upande_scp.serverscripts.mobile import reference_images as RI


def _abs(url):
    """Absolute disk path for a public `/files/...` URL."""
    return frappe.get_site_path("public", *url.lstrip("/").split("/"))


class ReferenceImageCase(unittest.TestCase):
    """Shared manifest. Built once — it hashes and may resize every photo on the site."""

    @classmethod
    def setUpClass(cls):
        invalidate_reference_images()
        cls.manifest = RI.getReferenceImages()["data"]
        cls.images = cls.manifest["images"]

    @classmethod
    def tearDownClass(cls):
        # Leave nothing cached from a test run.
        invalidate_reference_images()


class TestManifestShape(ReferenceImageCase):
    def test_it_returns_the_fields_the_phone_needs(self):
        if not self.images:
            self.skipTest("no reference photos on this site")
        required = {
            "key",
            "category",
            "doctype",
            "name",
            "label",
            "url",
            "size",
            "full_url",
            "full_size",
            "content_hash",
        }
        for image in self.images:
            self.assertTrue(required <= set(image), f"{image['key']} is missing fields")

    def test_keys_are_unique(self):
        """The key is the phone's cache index. A collision would hide one photo."""
        keys = [i["key"] for i in self.images]
        self.assertEqual(len(keys), len(set(keys)))

    def test_the_key_namespaces_by_category(self):
        """A Pest and a Predator may legitimately share a name."""
        for image in self.images:
            self.assertTrue(image["key"].startswith(image["category"] + ":"))

    def test_it_only_lists_photos_that_are_actually_on_disk(self):
        """A URL the phone would 404 on belongs in `missing`, not in `images`."""
        for image in self.images:
            self.assertTrue(
                os.path.isfile(_abs(image["url"])),
                f"{image['key']} points at a file that is not there: {image['url']}",
            )

    def test_a_field_pointing_at_a_vanished_file_is_reported(self):
        """Not silently dropped — the office needs to know a master lost its photo."""
        for row in self.manifest["missing"]:
            self.assertTrue({"category", "name", "url"} <= set(row))
            self.assertFalse(os.path.isfile(_abs(row["url"])))

    def test_totals_agree_with_the_listing(self):
        self.assertEqual(self.manifest["count"], len(self.images))
        self.assertEqual(
            self.manifest["total_bytes"], sum(i["size"] for i in self.images)
        )

    def test_only_the_four_photo_masters_appear(self):
        allowed = {"pest", "disease", "predator", "disorder"}
        self.assertTrue({i["category"] for i in self.images} <= allowed)


class TestDownloadOnce(ReferenceImageCase):
    def test_a_matching_version_returns_nothing_else(self):
        """The whole point: a phone that is up to date transfers no listing at all."""
        answer = RI.getReferenceImages(version=self.manifest["version"])["data"]
        self.assertTrue(answer["unchanged"])
        self.assertNotIn("images", answer)
        self.assertEqual(answer["version"], self.manifest["version"])

    def test_a_stale_version_returns_the_full_listing(self):
        answer = RI.getReferenceImages(version="not-a-real-version")["data"]
        self.assertFalse(answer["unchanged"])
        self.assertEqual(answer["count"], self.manifest["count"])

    def test_no_version_returns_the_full_listing(self):
        answer = RI.getReferenceImages()["data"]
        self.assertFalse(answer["unchanged"])
        self.assertIn("images", answer)

    def test_the_version_is_stable_across_calls(self):
        """If it drifted, every sync would re-download everything."""
        again = RI.getReferenceImages()["data"]
        self.assertEqual(again["version"], self.manifest["version"])

    def test_the_version_survives_a_cache_drop(self):
        """It must be a function of the data, not of when the cache was built."""
        invalidate_reference_images()
        rebuilt = RI.getReferenceImages()["data"]
        self.assertEqual(rebuilt["version"], self.manifest["version"])

    def test_the_hash_identifies_the_original_bytes(self):
        """Hashing bytes rather than the URL is what catches a replaced photo."""
        import hashlib

        if not self.images:
            self.skipTest("no reference photos on this site")
        image = self.images[0]
        with open(_abs(image["full_url"]), "rb") as fh:
            self.assertEqual(hashlib.sha256(fh.read()).hexdigest(), image["content_hash"])

    def test_a_changed_label_bumps_the_version(self):
        """The app renders the label under the photo, so it is part of the payload."""
        if not self.images:
            self.skipTest("no reference photos on this site")
        image = self.images[0]
        field = "common_name" if image["category"] in ("pest", "disease", "predator") else "disorder_name"
        before = frappe.db.get_value(image["doctype"], image["name"], field)
        try:
            frappe.db.set_value(
                image["doctype"], image["name"], field, f"{before} (test)", update_modified=False
            )
            invalidate_reference_images()
            self.assertNotEqual(
                RI.getReferenceImages()["data"]["version"], self.manifest["version"]
            )
        finally:
            frappe.db.set_value(
                image["doctype"], image["name"], field, before, update_modified=False
            )
            invalidate_reference_images()


class TestDerivatives(ReferenceImageCase):
    def test_what_is_offered_is_never_bigger_than_the_original(self):
        """Holds for every entry, including the ones that fell back: a derivative is
        discarded unless it actually saves bytes."""
        for image in self.images:
            self.assertLessEqual(
                image["size"],
                image["full_size"],
                f"{image['key']}: the phone is offered more bytes than the original",
            )

    def test_the_heavy_photos_are_actually_shrunk(self):
        """The regression that costs 15x with nothing failing. Anything comfortably
        over the box must come down."""
        try:
            from PIL import Image
        except ImportError:
            self.skipTest("Pillow unavailable")
        heavy = [i for i in self.images if i["full_size"] > 500_000]
        if not heavy:
            self.skipTest("no large originals on this site")
        for image in heavy:
            self.assertLess(
                image["size"],
                image["full_size"] / 2,
                f"{image['key']}: {image['full_size']} bytes was not meaningfully reduced",
            )

    def test_the_derivative_fits_the_box(self):
        try:
            from PIL import Image
        except ImportError:
            self.skipTest("Pillow unavailable")
        shrunk = [i for i in self.images if i["url"] != i["full_url"]]
        if not shrunk:
            self.skipTest("no derivatives were built")
        for image in shrunk[:5]:
            with Image.open(_abs(image["url"])) as im:
                self.assertLessEqual(max(im.size), RI._MAX_EDGE, image["key"])

    def test_the_derivative_name_is_derived_from_the_source_hash(self):
        """That is what makes it immutable and safe to cache forever."""
        for image in self.images:
            if image["url"] == image["full_url"]:
                continue
            self.assertIn(image["content_hash"][:16], image["url"])

    def test_derivatives_are_public(self):
        """The phone fetches them with no auth header, like the originals."""
        for image in self.images:
            self.assertFalse(image["url"].startswith("/private/"), image["key"])

    def test_rebuilding_reuses_the_file_on_disk(self):
        """A second build must not re-encode; that is the difference between 345 ms
        and several seconds on every cold cache."""
        if not self.images:
            self.skipTest("no reference photos on this site")
        image = next((i for i in self.images if i["url"] != i["full_url"]), None)
        if not image:
            self.skipTest("no derivatives were built")
        path = _abs(image["url"])
        before = os.stat(path).st_mtime_ns
        invalidate_reference_images()
        RI.getReferenceImages()
        self.assertEqual(os.stat(path).st_mtime_ns, before)

    def test_a_smaller_original_is_not_upscaled(self):
        """`thumbnail` never enlarges, so a small photo stays its own size."""
        try:
            from PIL import Image
        except ImportError:
            self.skipTest("Pillow unavailable")
        for image in self.images:
            if image["url"] == image["full_url"]:
                continue
            with Image.open(_abs(image["full_url"])) as src:
                if max(src.size) >= RI._MAX_EDGE:
                    continue
                with Image.open(_abs(image["url"])) as out:
                    self.assertEqual(out.size, src.size, image["key"])


class TestCacheWiring(unittest.TestCase):
    def test_editing_a_photo_master_drops_the_manifest(self):
        """Wired through `_DOC_INVALIDATIONS`, so a new photo shows up without waiting
        out the TTL."""
        from upande_scp.serverscripts.common.cache_utils import (
            _DOC_INVALIDATIONS,
            K_SM_REFERENCE_IMAGES,
        )

        for doctype in ("Pest", "Plant Disease", "Predator", "Physiological Disorder"):
            self.assertIn(
                K_SM_REFERENCE_IMAGES,
                _DOC_INVALIDATIONS[doctype],
                f"editing a {doctype} would serve a stale manifest",
            )

    def test_the_photo_masters_are_hooked_at_all(self):
        """The invalidation map is only consulted for doctypes in `doc_events`."""
        from upande_scp import hooks

        for doctype in ("Pest", "Plant Disease", "Predator", "Physiological Disorder"):
            self.assertIn(doctype, hooks.doc_events)

    def test_the_endpoint_is_callable_from_the_phone(self):
        self.assertIn(
            RI.getReferenceImages,
            frappe.whitelisted,
            "getReferenceImages is not whitelisted",
        )
