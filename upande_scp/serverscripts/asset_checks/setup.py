"""Keep the Asset Check Sheet client-id field present whenever upande_asset is.

``custom_scp_client_id`` is what makes a phone's retry find the sheet it already
made. The sheet DocType belongs to upande_asset, an optional app, so the field can
only exist once that app does — and the app may be installed AFTER SCP. Running
this on every SCP migrate means installing upande_asset later still converges.
Safe to re-run; a no-op without the app.
"""

import frappe

DOCTYPE = "Asset Check Sheet"
FIELDNAME = "custom_scp_client_id"


def ensure_client_id_field() -> bool:
	"""Create the field if the sheet table exists and the column does not. True when
	the column is there afterwards."""
	if not frappe.db.table_exists(DOCTYPE):
		return False
	if frappe.db.has_column(DOCTYPE, FIELDNAME):
		return True
	from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

	create_custom_fields(
		{
			DOCTYPE: [
				{
					"fieldname": FIELDNAME,
					"label": "SCP Client ID",
					"fieldtype": "Data",
					"insert_after": "amended_from",
					"read_only": 1,
					"hidden": 1,
					"no_copy": 1,
					"search_index": 1,
				}
			]
		},
		update=True,
		ignore_validate=True,
	)
	frappe.clear_cache(doctype=DOCTYPE)
	return frappe.db.has_column(DOCTYPE, FIELDNAME)


def after_migrate():
	try:
		ensure_client_id_field()
	except Exception:
		frappe.log_error(title="asset_checks: client id field", message=frappe.get_traceback())
