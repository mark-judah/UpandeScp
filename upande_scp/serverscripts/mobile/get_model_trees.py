import frappe


@frappe.whitelist()
def getModelTrees(block=None):
	"""Return Orchard Tree records flagged `is_model=1` that live under the given block.

	Trees live on Rows (Beds with unit_type=Row), and a Row's `greenhouse`
	field points at the block warehouse.

	Response shape: {data: [{name, tree_code, row, tree_number, label}]}
	"""
	if not block:
		frappe.response["message"] = {"data": []}
		return frappe.response["message"]

	trees = frappe.get_all(
		"Orchard Tree",
		filters={"block": block, "is_model": 1},
		fields=["name", "tree_code", "row", "tree_number"],
		order_by="row asc, tree_number asc",
	)

	data = [
		{
			"name": t.name,
			"tree_code": t.tree_code or t.name,
			"row": t.row,
			"tree_number": t.tree_number,
			"label": f"{t.tree_code or t.name} Model",
		}
		for t in trees
	]

	frappe.response["message"] = {"data": data}
	return frappe.response["message"]
