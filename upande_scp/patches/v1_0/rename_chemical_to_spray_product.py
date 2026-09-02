"""Rename the `Chemical` doctype to `Spray Product`. Schema identity only.

**pre_model_sync**, and it has to be: `bench migrate` syncs doctypes from disk
straight afterwards. If `Chemical` is still the name in the database at that
point, migrate sees `Spray Product` as a brand-new doctype and `Chemical` as an
orphan — and deletes the orphan, taking 479 records with it.

Deliberately does no data work. Its sibling
`consolidate_spray_products` runs **post**_model_sync and does all of it, for
one reason: the fields that work needs (`category`, `crop_rates`) do not exist
until the sync in between has created them. Doing both halves in one
pre_model_sync patch fails in ways that read as unrelated bugs —
`AttributeError: 'SprayProduct' object has no attribute 'crop_rates'` from the
controller, then `Unknown column 'chemical_name' in 'INSERT INTO'` once the
column is renamed but the DocField describing it is not.
"""

import frappe

OLD = "Chemical"
NEW = "Spray Product"


def execute():
	_rename_doctype()
	_rename_name_field()
	frappe.db.commit()


def _rename_doctype():
	if frappe.db.exists("DocType", NEW) or not frappe.db.exists("DocType", OLD):
		return
	# v15's rename_doc takes no `ignore_permissions` kwarg.
	frappe.rename_doc("DocType", OLD, NEW, force=True)
	frappe.db.commit()

	# rename_doc repoints child rows' `parenttype`, but not rows in other tables
	# that name the doctype as data.
	for table, column in (("Custom Field", "dt"), ("Property Setter", "doc_type")):
		if frappe.db.table_exists(table):
			frappe.db.sql(
				f"UPDATE `tab{table}` SET `{column}` = %s WHERE `{column}` = %s",
				(NEW, OLD),
			)


def _rename_name_field():
	"""`chemical_name` -> `product_name`: the column AND the DocField describing it.

	Both, together. The column alone leaves the ORM writing `chemical_name` into
	a table that no longer has it; the DocField alone leaves the data behind. The
	doctype now holds foliars too, so the old name is simply wrong.
	"""
	if not frappe.db.table_exists(NEW):
		return

	if frappe.db.has_column(NEW, "chemical_name"):
		if frappe.db.has_column(NEW, "product_name"):
			frappe.db.sql(
				f"UPDATE `tab{NEW}` SET product_name = chemical_name "
				"WHERE (product_name IS NULL OR product_name = '') "
				"AND chemical_name IS NOT NULL"
			)
			# sql_ddl, not sql: MariaDB autocommits schema changes and Frappe
			# refuses DDL through the transactional path.
			frappe.db.sql_ddl(f"ALTER TABLE `tab{NEW}` DROP COLUMN `chemical_name`")
		else:
			# CHANGE carries the data across, so nothing to copy.
			frappe.db.sql_ddl(
				f"ALTER TABLE `tab{NEW}` CHANGE `chemical_name` `product_name` "
				"varchar(140)"
			)

	frappe.db.sql(
		"UPDATE `tabDocField` SET fieldname = 'product_name', label = 'Product Name' "
		"WHERE parent = %s AND fieldname = 'chemical_name'",
		(NEW,),
	)
	frappe.db.commit()
	frappe.clear_cache(doctype=NEW)
