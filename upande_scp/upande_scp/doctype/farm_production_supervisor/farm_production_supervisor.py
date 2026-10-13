from frappe.model.document import Document


class FarmProductionSupervisor(Document):
	"""Child row of Farm.production_supervisors. The role is checked when the
	roster is set (spray_plan_creator.admin), the same way the other rosters are."""
