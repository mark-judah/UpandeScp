"""A doctype that names a field it does not have breaks its own list view.

`Spray Product` shipped with `title_field: "chemical_name"` — the name the field
had back when the doctype was `Chemical`. The rename to `Spray Product` moved
the field to `product_name` and left the title_field pointing at a ghost.

Nothing complains on migrate. The damage shows up in the browser: the desk list
builds its columns from the title field's meta, gets `undefined`, and dies with

    TypeError: Cannot read properties of undefined (reading 'fieldname')

and the list renders the empty state — "You haven't created a Spray Product
yet" — over 111 existing records. It reads as missing data, which is why it was
looked for in permissions and in the database before anyone suspected the
doctype definition.

So this checks every doctype in the app, not just the one that broke: any field
a doctype names in `title_field`, `sort_field`, `image_field` or `search_fields`
has to be a field it actually has.
"""

import unittest

import frappe

APP = "upande_scp"

#: Sort and title may also name the framework's own columns.
BUILT_IN = {"name", "modified", "creation", "owner", "modified_by", "idx"}


def _app_doctypes():
	return frappe.get_all(
		"DocType",
		filters={"module": ["in", frappe.get_all(
			"Module Def", filters={"app_name": APP}, pluck="name"
		)]},
		pluck="name",
	)


class TestEveryNamedFieldExists(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		frappe.set_user("Administrator")
		cls.doctypes = _app_doctypes()

	def test_the_app_has_doctypes_to_check(self):
		self.assertTrue(self.doctypes, "no doctypes found for this app to check")

	def test_title_field_names_a_real_field(self):
		"""The one that broke: a ghost title field kills the list view without
		a single server-side error."""
		for dt in self.doctypes:
			meta = frappe.get_meta(dt)
			title = (meta.title_field or "").strip()
			if not title or title in BUILT_IN:
				continue
			with self.subTest(doctype=dt):
				self.assertIsNotNone(
					meta.get_field(title),
					f"{dt}.title_field names '{title}', which is not a field on it",
				)

	def test_sort_field_names_a_real_field(self):
		for dt in self.doctypes:
			meta = frappe.get_meta(dt)
			for part in (meta.sort_field or "").split(","):
				name = part.strip().split(" ")[0]
				if not name or name in BUILT_IN:
					continue
				with self.subTest(doctype=dt, sort_field=name):
					self.assertIsNotNone(
						meta.get_field(name),
						f"{dt}.sort_field names '{name}', which is not a field on it",
					)

	def test_search_fields_name_real_fields(self):
		for dt in self.doctypes:
			meta = frappe.get_meta(dt)
			for part in (meta.search_fields or "").split(","):
				name = part.strip()
				if not name or name in BUILT_IN:
					continue
				with self.subTest(doctype=dt, search_field=name):
					self.assertIsNotNone(
						meta.get_field(name),
						f"{dt}.search_fields names '{name}', which is not a field on it",
					)

	def test_image_field_names_a_real_field(self):
		for dt in self.doctypes:
			meta = frappe.get_meta(dt)
			image = (meta.image_field or "").strip()
			if not image:
				continue
			with self.subTest(doctype=dt):
				self.assertIsNotNone(
					meta.get_field(image),
					f"{dt}.image_field names '{image}', which is not a field on it",
				)
