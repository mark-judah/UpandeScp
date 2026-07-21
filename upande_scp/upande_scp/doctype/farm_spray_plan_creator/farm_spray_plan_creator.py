import frappe
from frappe.model.document import Document


def _assert_spray_plan_creator_role(user: str) -> None:
    """Raise ValidationError if *user* does not hold the Spray Plan Creator role."""
    roles = {r.role for r in frappe.get_all(
        "Has Role", filters={"parent": user}, fields=["role"]
    )}
    if "SCP Spray Plan Creator" not in roles:
        frappe.throw(
            f"User {user} does not hold the 'SCP Spray Plan Creator' role.",
            title="Role required",
        )


class FarmSprayPlanCreator(Document):
    def validate(self) -> None:
        if not self.user:
            return
        _assert_spray_plan_creator_role(self.user)


def validate_farm_spray_plan_creators(doc, method=None) -> None:
    """doc_events hook: called on Farm.validate.

    Frappe does not propagate validate() to child-table rows during a parent
    save, so we iterate the table here and enforce the role guard ourselves.
    """
    for row in doc.get("spray_plan_creators") or []:
        if row.user:
            _assert_spray_plan_creator_role(row.user)
