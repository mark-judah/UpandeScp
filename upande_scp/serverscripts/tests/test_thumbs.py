"""Thumbnail service. DB test — direct runner; writes temp files and File rows, cleaned up."""

import io
import os
import shutil
import unittest
import uuid

import frappe
from PIL import Image

from upande_scp.serverscripts.common import thumbs as T


def _jpeg(width=2000, height=1000, orientation=None) -> bytes:
    im = Image.new("RGB", (width, height), (120, 40, 40))
    buf = io.BytesIO()
    exif = Image.Exif()
    if orientation:
        exif[0x0112] = orientation
    im.save(buf, "JPEG", exif=exif)
    return buf.getvalue()


class ThumbCase(unittest.TestCase):
    def setUp(self):
        self.made = []
        self.tag = uuid.uuid4().hex[:8]

    def tearDown(self):
        frappe.set_user("Administrator")
        for name in self.made:
            frappe.delete_doc("File", name, force=True, ignore_permissions=True)
        frappe.db.rollback()
        for d in (frappe.get_site_path("public", "files", T.PUBLIC_DIR),
                  frappe.get_site_path("private", T.PUBLIC_DIR)):
            for f in os.listdir(d) if os.path.isdir(d) else []:
                if f in self.thumbs:
                    os.remove(os.path.join(d, f))

    paths: list = []
    thumbs: set = set()

    def file(self, private=False, data=None, **kw):
        sub = "private/files" if private else "public/files"
        name = f"zz_thumbtest_{self.tag}_{len(self.made)}.jpg"
        path = frappe.get_site_path(*sub.split("/"), name)
        with open(path, "wb") as f:
            f.write(data or _jpeg())
        self.addCleanup(lambda: os.path.exists(path) and os.remove(path))
        url = f"/{'private/' if private else ''}files/{name}"
        # db_insert: File.insert would re-read and EXIF-strip the file we just wrote.
        doc = frappe.get_doc({"doctype": "File", "name": uuid.uuid4().hex[:10], "file_name": name,
                              "file_url": url, "is_private": 1 if private else 0,
                              "owner": frappe.session.user, **kw})
        doc.db_insert()
        self.made.append(doc.name)
        return url, path

    def build(self, url, w):
        out, pub = T.ensure_thumb(url, w, url.startswith("/private/"))
        self.thumbs.add(os.path.basename(out))
        return out, pub

    def test_resize_to_webp_and_no_upscale(self):
        url, _ = self.file()
        out, pub = self.build(url, 480)
        with Image.open(out) as im:
            self.assertEqual(im.format, "WEBP")
            self.assertEqual(im.size, (480, 240))
        self.assertTrue(pub.startswith("/files/scp_thumbs/") and pub.endswith("_480.webp"))
        small, _ = self.file(data=_jpeg(300, 200))
        out, _ = self.build(small, 960)
        with Image.open(out) as im:
            self.assertEqual(im.size, (300, 200))

    def test_exif_orientation_honoured(self):
        url, _ = self.file(data=_jpeg(2000, 1000, orientation=6))  # rotate 90
        out, _ = self.build(url, 480)
        with Image.open(out) as im:
            self.assertEqual(im.size[0] < im.size[1], True)

    def test_cache_hit_and_mtime_rekey(self):
        url, path = self.file()
        out, _ = self.build(url, 240)
        first = os.path.getmtime(out)
        os.utime(out, (first - 100, first - 100))
        again, _ = self.build(url, 240)
        self.assertEqual(out, again)
        self.assertAlmostEqual(os.path.getmtime(out), first - 100, delta=1)  # not rewritten
        os.utime(path, (first + 500, first + 500))
        newer, _ = self.build(url, 240)
        self.assertNotEqual(out, newer)

    def test_public_request_redirects_to_static(self):
        url, _ = self.file()
        r = T.thumb(url, 480)
        self.assertEqual(r.status_code, 302)
        loc = r.headers["Location"]
        self.thumbs.add(os.path.basename(loc))
        self.assertTrue(os.path.isfile(frappe.get_site_path("public", loc.lstrip("/"))))

    def test_bad_widths(self):
        url, _ = self.file()
        for w in (0, 100, 481, 5000, "abc", None, -480):
            with self.assertRaises(frappe.ValidationError, msg=str(w)):
                T.thumb(url, w)

    def test_bad_paths(self):
        for src in ("/files/../site_config.json", "/private/files/../../site_config.json",
                    "/etc/passwd", "/files/%2e%2e/x.jpg", "files/x.jpg", "/files//x.jpg",
                    "/files/a\\b.jpg", "/files/x.jpg\x00.png", "", "/assets/frappe/x.jpg",
                    "https://evil.example/files/x.jpg", "/files/x.jpg?a=1"):
            with self.assertRaises(frappe.ValidationError, msg=repr(src)):
                T.thumb(src, 480)

    def test_unknown_file_and_non_image(self):
        with self.assertRaises(frappe.DoesNotExistError):
            T.thumb("/files/zz_nonexistent_file.jpg", 480)
        url, _ = self.file(data=b"not an image at all")
        with self.assertRaises(frappe.ValidationError):
            T.thumb(url, 480)

    def test_private_file_permission(self):
        owner = "thumb_owner@example.com"
        other = "thumb_other@example.com"
        for u in (owner, other):
            if not frappe.db.exists("User", u):
                frappe.get_doc({"doctype": "User", "email": u, "first_name": u.split("@")[0],
                                "send_welcome_email": 0}).insert(ignore_permissions=True)
        frappe.set_user(owner)
        url, _ = self.file(private=True)
        r = T.thumb(url, 480)  # the owner reads it
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.mimetype, "image/webp")
        self.assertIn("private", r.headers["Cache-Control"])
        Image.open(io.BytesIO(r.data)).verify()
        out, pub = T.thumb_path(url, 480, os.path.getmtime(frappe.get_site_path("private", "files", os.path.basename(url))))
        self.thumbs.add(os.path.basename(out))
        self.assertIsNone(pub)
        self.assertNotIn(os.sep + "public" + os.sep, out)  # never under public/
        frappe.set_user(other)
        with self.assertRaises(frappe.PermissionError):
            T.thumb(url, 480)
        frappe.set_user("Administrator")
        self.assertEqual(T.thumb(url, 480).status_code, 200)


if __name__ == "__main__":
    unittest.main()
