import frappe

from upande_scp.serverscripts.common import farm_map


def derive_levels(farm_wh, warehouses, types=None):
	"""Work out the section list and the drill-down levels from warehouse rows.

	Pure over ``warehouses`` (dicts with name, warehouse_name, warehouse_type,
	is_group, parent_warehouse, in ``lft`` order). Returns ``(sections, levels)``:

	* ``sections`` - the direct parents of stations (Section or Pivot), at any
	  depth, excluding the farm warehouse itself: ``{name, warehouse_name}``.
	* ``levels`` - every group warehouse strictly between the farm warehouse and
	  the stations (Phase, Section, Pivot): ``{name, warehouse_name,
	  warehouse_type, parent}``.
	"""
	types = types or farm_map.station_types()
	by_name = {w["name"]: w for w in warehouses}
	stations = [w for w in warehouses if farm_map.is_station(w, types)]

	parent_names = set()
	level_names = set()
	for st in stations:
		parent = st.get("parent_warehouse")
		first = True
		seen = set()
		while parent and parent != farm_wh and parent not in seen:
			seen.add(parent)
			node = by_name.get(parent)
			if not node:
				break
			# A station never counts as a level: an orchard Block that carries
			# its rows beneath it is the thing being scouted, not a picker step.
			if node.get("is_group") and not farm_map.is_station(node, types):
				level_names.add(parent)
				if first:
					parent_names.add(parent)
			first = False
			parent = node.get("parent_warehouse")

	sections = [
		{"name": w["name"], "warehouse_name": w["warehouse_name"]}
		for w in warehouses
		if w["name"] in parent_names
	]
	levels = [
		{
			"name": w["name"],
			"warehouse_name": w["warehouse_name"],
			"warehouse_type": w.get("warehouse_type"),
			"parent": w.get("parent_warehouse"),
		}
		for w in warehouses
		if w["name"] in level_names
	]
	return sections, levels


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
	    "levels": [{"name": "...", "warehouse_name": "...",
	                "warehouse_type": "Phase" | "Section" | "Pivot", "parent": "..."}],
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
	levels = []
	station_type = None
	has_sections = False

	if farm_wh:
		warehouses = frappe.get_all(
			"Warehouse",
			filters={"custom_farm": farm, "disabled": 0},
			fields=[
				"name",
				"warehouse_name",
				"warehouse_type",
				"is_group",
				"parent_warehouse",
			],
			order_by="lft asc",
			limit_page_length=0,
		)
		sections, levels = derive_levels(farm_wh, warehouses)
		sections.sort(key=lambda w: w["name"])
		has_sections = len(sections) > 0

	# Sample any leaf warehouse under this farm to infer station type.
	# Which types count as stations is configuration (Settings → Station
	# Warehouse Types), not a constant: roses call it a Greenhouse, avocado and
	# coffee a Block, and the next crop will bring its own word.
	types = farm_map.station_types()
	leaf = frappe.db.sql(
		"""
		SELECT warehouse_type
		FROM `tabWarehouse`
		WHERE custom_farm = %s AND is_group = 0 AND disabled = 0
		  AND warehouse_type IN %s
		GROUP BY warehouse_type
		ORDER BY COUNT(*) DESC
		LIMIT 1
		""",
		(farm, tuple(types)),
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
			"levels": levels,
		}
	}
	return frappe.response["message"]
