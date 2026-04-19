import frappe


@frappe.whitelist()
def getFarmHierarchyInfo(farm=None):
	"""Return hierarchy metadata for a farm.

	Response shape:
	  {
	    "farm": "Lokitela",
	    "farm_warehouse": "Lokitela - KL" | None,
	    "station_type": "Greenhouse" | "Block" | None,
	    "has_sections": True | False,
	    "sections": [{"name": "23HA_SECTION - KL", "warehouse_name": "23HA_SECTION"}],
	  }

	The app uses `station_type` to decide which leaf warehouses to offer and
	whether to insert a Section picker between farm and station.
	"""
	if not farm:
		frappe.response["message"] = {"data": None}
		return frappe.response["message"]

	farm_wh = frappe.db.get_value(
		"Warehouse",
		{"warehouse_type": "Farm", "custom_farm": farm},
		"name",
	)

	sections = []
	station_type = None
	has_sections = False

	if farm_wh:
		sections = frappe.get_all(
			"Warehouse",
			filters={
				"parent_warehouse": farm_wh,
				"warehouse_type": "Section",
				"is_group": 1,
				"disabled": 0,
			},
			fields=["name", "warehouse_name"],
			order_by="name asc",
		)
		has_sections = len(sections) > 0

	# Sample any leaf warehouse under this farm to infer station type.
	leaf = frappe.db.sql(
		"""
		SELECT warehouse_type
		FROM `tabWarehouse`
		WHERE custom_farm = %s AND is_group = 0 AND disabled = 0
		  AND warehouse_type IN ('Greenhouse', 'Block')
		GROUP BY warehouse_type
		ORDER BY COUNT(*) DESC
		LIMIT 1
		""",
		(farm,),
		as_dict=True,
	)
	if leaf:
		station_type = leaf[0]["warehouse_type"]

	frappe.response["message"] = {
		"data": {
			"farm": farm,
			"farm_warehouse": farm_wh,
			"station_type": station_type,
			"has_sections": has_sections,
			"sections": sections,
		}
	}
	return frappe.response["message"]
