from frappe.model.document import Document


class SprayApplicationLogsheet(Document):
	def validate(self):
		# Active ingredients, toxicity, HML, % a.i, tank water and total a.i come from
		# the Spray Product master; blanks only, never fails the spray.
		from upande_scp.serverscripts.spray_plan_creator.logsheet_chemistry import fill_pesticide_rows

		fill_pesticide_rows(self)
