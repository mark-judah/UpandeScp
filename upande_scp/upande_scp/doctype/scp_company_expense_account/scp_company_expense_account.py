"""One company's crop-protection expense accounts (B6).

`default_chemical_expense_account` on the settings is one value for every
company, which cannot be right on a site with more than one chart of accounts:
Karen Roses books chemicals to `Chemicals Expense - KR`, Kaitet Ltd. to
`Chemical Pest & Disease Control - KL`. A row per company, with chemicals and
foliars apart, replaces it; the single field stays as the fallback.
"""

import frappe
from frappe.model.document import Document


class SCPCompanyExpenseAccount(Document):
	def validate(self):
		for field in ("chemical_expense_account", "foliar_expense_account"):
			acc = self.get(field)
			if acc and frappe.db.get_value("Account", acc, "company") != self.company:
				frappe.throw(f"{acc} does not belong to {self.company}.")
